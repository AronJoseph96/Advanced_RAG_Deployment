"""
storage/vector_store.py
-----------------------
Pinecone Serverless hybrid vector store via LlamaIndex.

Architecture
------------
Dense  vectors → MixedbreadAIEmbedding  (mxbai-embed-large-v1, 1024-dim)
Sparse vectors → BM25 handled automatically by PineconeVectorStore(add_sparse_vector=True)
Reranker       → MixedbreadAI cross-encoder  (mxbai-rerank-large-v1)
Index metric   → dotproduct  (mandatory for Pinecone hybrid)
Retrieval      → Hybrid base retriever (alpha-blended dense + sparse)
                 → QueryFusionRetriever in RRF mode across N query rewrites
                 → MixedbreadAIRerank for final top-N selection

i3 note: embed_batch_size=32 keeps RAM pressure low during bulk upserts.
All blocking Pinecone / embedding calls are wrapped in run_in_executor so
the FastAPI event loop is never stalled.
"""

import os
import asyncio
from typing import List, Optional, Tuple

from dotenv import load_dotenv
from pinecone import Pinecone, ServerlessSpec

from llama_index.vector_stores.pinecone import PineconeVectorStore
from llama_index.embeddings.mixedbreadai import MixedbreadAIEmbedding
from llama_index.postprocessor.mixedbreadai_rerank import MixedbreadAIRerank
from llama_index.core import (
    VectorStoreIndex,
    StorageContext,
    Settings,
)
from llama_index.core.retrievers import QueryFusionRetriever
from llama_index.core.query_engine import RetrieverQueryEngine
from llama_index.core.schema import BaseNode
from llama_index.core.tools import QueryEngineTool, ToolMetadata

from config import settings   # single import — no double-import bug
from utils.retrieval_logging import enable_query_logging

load_dotenv()

# ---------------------------------------------------------------------------
# Constants  (all overridable via .env / settings)
# ---------------------------------------------------------------------------

INDEX_NAME: str   = settings.PINECONE_INDEX_NAME
CLOUD:      str   = settings.PINECONE_CLOUD
REGION:     str   = settings.PINECONE_REGION
DENSE_DIM:  int   = settings.EMBEDDING_DIM          # 1024 for mxbai-embed-large-v1
METRIC:     str   = "dotproduct"                     # REQUIRED for Pinecone hybrid
TOP_K:      int   = settings.TOP_K
ALPHA:      float = settings.HYBRID_ALPHA            # 0=sparse, 1=dense
EMBED_BATCH_SIZE: int = settings.EMBED_BATCH_SIZE


# ---------------------------------------------------------------------------
# Embeddings — Mixedbread AI
# ---------------------------------------------------------------------------

def get_dense_embeddings() -> MixedbreadAIEmbedding:
    """
    Returns a MixedbreadAIEmbedding model.

    mxbai-embed-large-v1 produces 1024-dim embeddings and ranks #1 on the
    MTEB retrieval benchmark (as of early 2025) for its size class.
    embed_batch_size is capped at 32 to prevent OOM on the i3.
    """
    return MixedbreadAIEmbedding(
        model_name=settings.EMBEDDING_MODEL,       # "mxbai-embed-large-v1"
        api_key=settings.MIXEDBREAD_API_KEY,
        batch_size=EMBED_BATCH_SIZE,
    )


# ---------------------------------------------------------------------------
# Reranker — Mixedbread AI cross-encoder
# ---------------------------------------------------------------------------

def get_reranker() -> MixedbreadAIRerank:
    """
    Returns a MixedbreadAIRerank postprocessor.

    The reranker runs AFTER hybrid vector retrieval: it takes the top-K
    candidate nodes returned by Pinecone and re-scores them with a
    cross-encoder model (much more accurate than bi-encoder similarity).
    Only the top RERANKER_TOP_N results survive into the LLM prompt.

    This two-stage setup (fast ANN retrieval → accurate reranking) is the
    standard production RAG pattern and significantly improves answer quality
    without slowing down the retrieval phase.
    """
    return MixedbreadAIRerank(
        model=settings.RERANKER_MODEL,             # "mxbai-rerank-large-v1"
        api_key=settings.MIXEDBREAD_API_KEY,
        top_n=settings.RERANKER_TOP_N,             # nodes kept after reranking
    )


# ---------------------------------------------------------------------------
# Pinecone index bootstrap
# ---------------------------------------------------------------------------

def _get_pinecone_client() -> Pinecone:
    return Pinecone(api_key=settings.PINECONE_API_KEY)


def ensure_index_exists(pc: Optional[Pinecone] = None):
    """
    Creates the Serverless index if it does not exist, then returns the
    live pinecone.Index handle.

    The dotproduct metric is non-negotiable — cosine / euclidean indexes
    do NOT support Pinecone's hybrid sparse vector scoring.
    """
    pc = pc or _get_pinecone_client()
    existing_names = [idx.name for idx in pc.list_indexes()]

    if INDEX_NAME not in existing_names:
        print(
            f"[VectorStore] Creating index '{INDEX_NAME}' "
            f"(dim={DENSE_DIM}, metric={METRIC}, cloud={CLOUD}/{REGION}) …"
        )
        pc.create_index(
            name=INDEX_NAME,
            dimension=DENSE_DIM,
            metric=METRIC,
            spec=ServerlessSpec(cloud=CLOUD, region=REGION),
        )
        print(f"[VectorStore] Index '{INDEX_NAME}' created.")
    else:
        print(f"[VectorStore] Index '{INDEX_NAME}' already exists — reusing.")

    return pc.Index(INDEX_NAME)


# ---------------------------------------------------------------------------
# VectorStoreIndex construction
# ---------------------------------------------------------------------------

def get_vector_store_index(pinecone_index) -> VectorStoreIndex:
    """
    Wraps a live Pinecone index in LlamaIndex's PineconeVectorStore.

    add_sparse_vector=True  → LlamaIndex generates BM25 sparse vectors
                               automatically alongside the dense embeddings.
                               No separate SPLADE model or encoder needed.

    from_vector_store()     → attaches to *existing* Pinecone data without
                               re-embedding anything; safe to call on startup.
    """
    vector_store = PineconeVectorStore(
        pinecone_index=pinecone_index,
        add_sparse_vector=True,   # enables hybrid support
    )
    storage_context = StorageContext.from_defaults(vector_store=vector_store)

    return VectorStoreIndex.from_vector_store(
        vector_store,
        storage_context=storage_context,
        # embed_model falls back to Settings.embed_model set in init_vector_store
    )


# ---------------------------------------------------------------------------
# Fused retriever (Hybrid + RRF)
# ---------------------------------------------------------------------------

def get_fused_retriever(index: VectorStoreIndex) -> QueryFusionRetriever:
    """
    Two-layer retrieval strategy:

    Layer 1 — Hybrid base retriever
        Calls Pinecone with alpha-blended dense + sparse scores in one RPC.
        alpha=0.5 → equal weight; tune via HYBRID_ALPHA in .env.

    Layer 2 — QueryFusionRetriever (RRF)
        Rewrites the user query into `num_queries` variants, runs each
        through the base retriever concurrently, then merges via
        Reciprocal Rank Fusion.  num_queries=4 gives strong recall
        improvement for the cost of 4× Pinecone reads.
        Set num_queries=1 to disable query rewriting.
    """
    base_retriever = index.as_retriever(
        vector_store_query_mode="hybrid",
        alpha=ALPHA,
        similarity_top_k=TOP_K,
    )

    return QueryFusionRetriever(
        retrievers=[base_retriever],
        llm=Settings.llm,          # uses the Groq instance set in Settings
        num_queries=4,             # number of query rewrites for RRF
        use_async=True,            # non-blocking fan-out; keeps i3 responsive
        similarity_top_k=TOP_K,
        mode="reciprocal_rerank",
        verbose=False,
    )


# ---------------------------------------------------------------------------
# Query engine + agent tool
# ---------------------------------------------------------------------------

def get_vector_query_engine(
    retriever: QueryFusionRetriever,
    reranker: Optional[MixedbreadAIRerank] = None,
) -> RetrieverQueryEngine:
    """
    Wraps the fused retriever in a RetrieverQueryEngine with an optional
    Mixedbread reranker as a node postprocessor.

    The reranker is applied AFTER retrieval: it re-scores the top-K
    candidates with the cross-encoder and keeps only top-N for the LLM.
    """
    node_postprocessors = [reranker] if reranker is not None else []

    return RetrieverQueryEngine.from_args(
        retriever=retriever,
        llm=Settings.llm,
        node_postprocessors=node_postprocessors,
        streaming=False,
    )


def get_vector_tool(query_engine: RetrieverQueryEngine) -> QueryEngineTool:
    """
    Returns a LlamaIndex QueryEngineTool that the FunctionCallingAgent
    will call for unstructured / document-based questions.
    """
    return QueryEngineTool(
        query_engine=enable_query_logging(query_engine, "Pinecone"),
        metadata=ToolMetadata(
            name="document_knowledge_search",
            return_direct=True,
            description=(
                "Search the document knowledge base using hybrid semantic + keyword "
                "retrieval with cross-encoder reranking. Use this tool for questions "
                "about uploaded documents, reports, policies, research papers, or any "
                "unstructured text. Prefer this tool when the user mentions a document, "
                "file, report, section, clause, requirement ID such as RS4, or asks what "
                "is stated in the source material. Input should be a plain-English "
                "question or search phrase."
            ),
        ),
    )


# ---------------------------------------------------------------------------
# Node upsert helper
# ---------------------------------------------------------------------------

async def aupsert_nodes(
    index: VectorStoreIndex,
    nodes: List[BaseNode],
    batch_size: int = EMBED_BATCH_SIZE,
) -> int:
    """
    Upserts nodes into the Pinecone index in batches.
    Runs index.insert_nodes (synchronous) in a thread-pool executor so the
    FastAPI event loop is never blocked.
    """
    loop = asyncio.get_running_loop()
    total = 0

    for start in range(0, len(nodes), batch_size):
        batch = nodes[start : start + batch_size]
        await loop.run_in_executor(None, index.insert_nodes, batch)
        total += len(batch)
        print(f"[VectorStore] Upserted {total}/{len(nodes)} nodes …")

    print(f"[VectorStore] Done — {total} nodes in Pinecone.")
    return total


# ---------------------------------------------------------------------------
# Top-level initialiser  (call once at application startup)
# ---------------------------------------------------------------------------

async def init_vector_store() -> Tuple[
    VectorStoreIndex,
    QueryFusionRetriever,
    RetrieverQueryEngine,
    QueryEngineTool,
]:
    """
    Full initialisation sequence:
      1. Register Mixedbread embedding model as Settings.embed_model
      2. Create / attach Pinecone index
      3. Build hybrid retriever (QueryFusionRetriever with RRF)
      4. Attach Mixedbread reranker as postprocessor
      5. Wrap in QueryEngineTool for the agent

    Returns a 4-tuple: (index, retriever, query_engine, tool)
    """
    # 1. Global embedding model — must be set before VectorStoreIndex is built
    Settings.embed_model = get_dense_embeddings()

    # 2. Pinecone index (blocking network call — offload to thread pool)
    loop = asyncio.get_running_loop()
    pc = _get_pinecone_client()
    pinecone_index = await loop.run_in_executor(None, ensure_index_exists, pc)

    # 3. Build the LlamaIndex stack
    index     = get_vector_store_index(pinecone_index)
    retriever = get_fused_retriever(index)

    # 4. Reranker postprocessor
    reranker = get_reranker()

    # 5. Query engine + tool
    query_engine = get_vector_query_engine(retriever, reranker=reranker)
    tool         = get_vector_tool(query_engine)

    print("[VectorStore] Initialisation complete.")
    return index, retriever, query_engine, tool


# ---------------------------------------------------------------------------
# Standalone smoke-test
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    from core.llm import get_llm

    async def _smoke_test():
        get_llm()   # registers Groq as Settings.llm
        index, retriever, qe, tool = await init_vector_store()
        response = await qe.aquery("What documents are available?")
        print("[Smoke] Response:", response)

    asyncio.run(_smoke_test())
