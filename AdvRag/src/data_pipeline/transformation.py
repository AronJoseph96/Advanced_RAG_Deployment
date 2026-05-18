"""
data_pipeline/transformation.py
--------------------------------

"""

import os
import asyncio
import uuid
from pathlib import Path
from typing import List, Tuple

from llama_index.core import Document, Settings
from llama_index.core.schema import BaseNode, TextNode
from llama_index.core.node_parser import SentenceSplitter
from llama_index.core.extractors import (
    TitleExtractor,
    SummaryExtractor,
    KeywordExtractor,
    QuestionsAnsweredExtractor,
)
from llama_index.core.ingestion import IngestionPipeline, DocstoreStrategy
from llama_index.core.storage.docstore import SimpleDocumentStore

from config import settings   # single import — correct package path
# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# Number of parallel LLM workers inside MetadataExtractors.
# Keep low (e.g. 1-3) on an i3 / free Groq tier to avoid hitting TPD rate limits.
_METADATA_WORKERS: int = int(os.getenv("METADATA_WORKERS", "1"))

_CACHE_DIR: str = settings.CACHE_DIR
# ---------------------------------------------------------------------------
# LLM guard
# ---------------------------------------------------------------------------

def _get_llm():
    """
    Returns Settings.llm and raises a clear error if it is None or is not
    the expected Groq instance.

    This guard prevents the silent OpenAI fallback: LlamaIndex extractors
    default to OpenAI() when Settings.llm is None at construction time,
    which wastes tokens / fails without an OpenAI key.

    Call get_llm() from core.llm before calling arun_pipeline().
    """
    llm = Settings.llm
    if llm is None:
        raise RuntimeError(
            "[Pipeline] Settings.llm is None.\n"
            "Call `from core.llm import get_llm; get_llm()` before running "
            "the pipeline."
        )
    llm_class = type(llm).__name__
    if "Groq" not in llm_class:
        raise RuntimeError(
            f"[Pipeline] Expected a Groq LLM but found '{llm_class}'.\n"
            "Possible causes:\n"
            "  1. OPENAI_API_KEY is set in the environment — add "
            "OPENAI_API_KEY= (blank) to your .env to suppress auto-init.\n"
            "  2. get_llm() was called before this import and then "
            "Settings.llm was overwritten. Call get_llm() immediately "
            "before arun_pipeline()."
        )
    return llm


# ---------------------------------------------------------------------------
# Table-aware document splitter
# ---------------------------------------------------------------------------

def _split_tables_from_prose(
    documents: List[Document],
) -> Tuple[List[Document], List[Document]]:
    """
    Separates Documents into two buckets:

    prose_docs  — normal text; will pass through SentenceSplitter.
    table_docs  — tagged content_type="table"; will NOT be split.

    A Document is treated as a table if its metadata contains:
        content_type == "table"

    This tag is set by load_docx_with_tables() in loader.py.
    Documents without the tag are treated as prose regardless of content.

    Args:
        documents: Mixed list of Document objects from loader.py.

    Returns:
        (prose_docs, table_docs)
    """
    prose_docs: List[Document] = []
    table_docs: List[Document] = []

    for doc in documents:
        if doc.metadata.get("content_type") == "table":
            table_docs.append(doc)
        else:
            prose_docs.append(doc)

    if table_docs:
        print(
            f"[Pipeline] Table-aware split: "
            f"{len(prose_docs)} prose doc(s), {len(table_docs)} table doc(s) "
            f"(tables will not be chunked)."
        )

    return prose_docs, table_docs


def _table_docs_to_nodes(table_docs: List[Document]) -> List[TextNode]:
    """
    Converts table Documents directly into TextNode objects WITHOUT splitting.

    Each table becomes exactly one node so no row/column boundary is ever
    broken by the chunker. A stable node_id is derived from the document's
    doc_id + table_index so re-runs skip unchanged tables via the docstore.

    Metadata from the source Document is preserved on the node, plus:
        content_type : "table"  (already present from loader)
        node_kind    : "table"  (extra tag for downstream filtering)

    Args:
        table_docs: Documents with content_type="table".

    Returns:
        List of TextNode objects — one per table.
    """
    nodes: List[TextNode] = []

    for doc in table_docs:
        meta = dict(doc.metadata)       # copy so we don't mutate the source
        meta["node_kind"] = "table"     # extra tag for retrieval-time filtering

        # Stable, reproducible node id for docstore deduplication.
        base    = meta.get("doc_id", doc.doc_id or "")
        t_idx   = str(meta.get("table_index", 0))
        node_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"{base}::table::{t_idx}"))

        node = TextNode(
            text=doc.get_content(),
            metadata=meta,
            id_=node_id,
        )
        nodes.append(node)

    if nodes:
        print(f"[Pipeline] Converted {len(nodes)} table(s) → atomic TextNode(s).")

    return nodes


# ---------------------------------------------------------------------------
# Individual pipeline components
# ---------------------------------------------------------------------------

def _make_splitter(
    chunk_size: int = settings.CHUNK_SIZE,
    chunk_overlap: int = settings.CHUNK_OVERLAP,
) -> SentenceSplitter:

    return SentenceSplitter(
        chunk_size=chunk_size,
        chunk_overlap=chunk_overlap,
        paragraph_separator="\n\n",
    )


def _make_title_extractor(llm) -> TitleExtractor:
    """
    Asks the LLM to infer a concise title for each node.
    Stored in node.metadata["document_title"].
    nodes=5 → uses up to 5 adjacent nodes for context when inferring titles.

    llm is passed explicitly — never read from Settings — to prevent the
    silent OpenAI fallback that occurs when Settings.llm is unset at the
    moment the extractor is constructed.
    """
    return TitleExtractor(
        llm=llm,
        nodes=1,
        num_workers=_METADATA_WORKERS,
    )


def _make_summary_extractor(llm) -> SummaryExtractor:
    """
    Asks the LLM to write a 1-sentence summary for each node.
    Stored in node.metadata["section_summary"].
    """
    return SummaryExtractor(
        llm=llm,
        summaries=["self"],
        num_workers=_METADATA_WORKERS,
    )


def _make_keyword_extractor(llm) -> KeywordExtractor:
    """
    Extracts 10 keywords per node.
    Keywords are injected into node.metadata["excerpt_keywords"] and also
    prepended to the node text, boosting BM25 sparse recall for domain terms.
    """
    return KeywordExtractor(
        llm=llm,
        keywords=5,
        num_workers=_METADATA_WORKERS,
    )


def _make_questions_extractor(llm) -> QuestionsAnsweredExtractor:
    """
    Generates 3 questions this node's content can answer.
    Stored in node.metadata["questions_this_excerpt_can_answer"].
    Dramatically improves retrieval for question-style queries.
    """
    return QuestionsAnsweredExtractor(
        llm=llm,
        questions=2,
        num_workers=_METADATA_WORKERS,
    )


# ---------------------------------------------------------------------------
# Pipeline factory  (prose only — tables are handled separately)
# ---------------------------------------------------------------------------

def build_ingestion_pipeline(
    llm,
    use_metadata_extractors: bool = True,
    cache_dir: str = _CACHE_DIR,
    chunk_size: int = settings.CHUNK_SIZE,
    chunk_overlap: int = settings.CHUNK_OVERLAP,
) -> IngestionPipeline:
    """
    Assembles the IngestionPipeline for PROSE documents only.
    Table documents are handled by _table_docs_to_nodes() before this runs.

    Args:
        llm:                     Groq LLM instance from get_llm(). Passed
                                 explicitly to every extractor to prevent the
                                 silent OpenAI fallback.
        use_metadata_extractors: Set False to skip LLM-powered metadata steps.
                                 Useful for quick tests or documents with
                                 existing rich metadata.
        cache_dir:               Directory for the on-disk SimpleDocumentStore.
                                 Processed node hashes are persisted here so
                                 the pipeline skips documents it has already
                                 seen on subsequent runs.

    Returns:
        A configured IngestionPipeline instance.
    """
    Path(cache_dir).mkdir(parents=True, exist_ok=True)

    transformations: list = [_make_splitter(chunk_size, chunk_overlap)]

    if use_metadata_extractors:
        # Order matters: Title → Summary → Keywords → Questions.
        # llm is passed explicitly to each — never falls back to Settings.llm.
        transformations += [
            _make_title_extractor(llm),
            _make_summary_extractor(llm),
            _make_keyword_extractor(llm),
            _make_questions_extractor(llm),
        ]
        
        # Only add the heaviest extractor if explicitly requested via environment
        if os.getenv("ENABLE_COMPLEX_METADATA", "false").lower() == "true":
            transformations.append(_make_questions_extractor(llm))

    # Persistent docstore for de-duplication across runs.
    # UPSERTS_AND_DELETE: re-processes updated docs, deletes removed ones,
    # and silently skips unchanged documents.
    docstore = SimpleDocumentStore()
    docstore_path = Path(cache_dir) / "docstore.json"
    if docstore_path.exists():
        docstore = SimpleDocumentStore.from_persist_path(str(docstore_path))
        print(f"[Pipeline] Loaded docstore cache ← {docstore_path}")

    return IngestionPipeline(
        transformations=transformations,
        docstore=docstore,
        docstore_strategy=DocstoreStrategy.DUPLICATES_ONLY,
    )


# ---------------------------------------------------------------------------
# Async runner
# ---------------------------------------------------------------------------

async def arun_pipeline(
    documents: List[Document],
    use_metadata_extractors: bool = True,
    cache_dir: str = _CACHE_DIR,
    chunk_size: int = settings.CHUNK_SIZE,
    chunk_overlap: int = settings.CHUNK_OVERLAP,
) -> List[BaseNode]:
    """
    Runs the full table-aware IngestionPipeline and returns enriched,
    de-duplicated Nodes ready for Pinecone upsert.

    Flow
    ----
    1. Validate that Settings.llm is a Groq instance (fail fast).
    2. Separate input documents into prose_docs and table_docs.
    3. Convert table_docs → atomic TextNodes (no splitting, no LLM calls).
    4. Run prose_docs through the IngestionPipeline (split + LLM metadata).
    5. Merge prose nodes + table nodes into a single list and return.

    Args:
        documents:               Raw Document objects from loader.py / helpers.py.
        use_metadata_extractors: Pass False to skip LLM metadata extraction.
        cache_dir:               Directory for the on-disk docstore cache.

    Returns:
        List of BaseNode objects ready for Pinecone upsert via vector_store.py.
    """
    # ── Step 1: validate LLM — fail fast before any network calls ───────────
    llm = _get_llm() if use_metadata_extractors else Settings.llm

    # ── Step 2: separate tables from prose ──────────────────────────────────
    prose_docs, table_docs = _split_tables_from_prose(documents)

    # ── Step 3: convert tables to atomic nodes (no splitting, no LLM) ───────
    table_nodes: List[BaseNode] = _table_docs_to_nodes(table_docs)

    # ── Step 4: run prose through the IngestionPipeline ─────────────────────
    prose_nodes: List[BaseNode] = []

    if prose_docs:
        pipeline = build_ingestion_pipeline(
            llm=llm,
            use_metadata_extractors=use_metadata_extractors,
            cache_dir=cache_dir,
            chunk_size=chunk_size,
            chunk_overlap=chunk_overlap,
        )

        print(
            f"[Pipeline] Running on {len(prose_docs)} prose document(s) "
            f"(metadata_extractors={'on' if use_metadata_extractors else 'off'}) …"
        )

        try:
            prose_nodes = await pipeline.arun(
                documents=prose_docs,
                num_workers=_METADATA_WORKERS,
            )
        except AttributeError:
            # Fallback for llama-index-core < 0.10 that lacks arun()
            loop = asyncio.get_running_loop()
            prose_nodes = await loop.run_in_executor(None, pipeline.run, prose_docs)

        # Persist updated docstore so the next run skips these documents.
        cache_path = Path(cache_dir) / "docstore.json"
        if pipeline.docstore:
            pipeline.docstore.persist(str(cache_path))
            print(f"[Pipeline] Docstore cache saved → {cache_path}")

    else:
        print("[Pipeline] No prose documents to process.")

    # ── Step 5: merge and return ─────────────────────────────────────────────
    all_nodes: List[BaseNode] = prose_nodes + table_nodes

    print(
        f"[Pipeline] Done — "
        f"{len(prose_nodes)} prose node(s) + {len(table_nodes)} table node(s) "
        f"= {len(all_nodes)} total node(s)."
    )
    return all_nodes


# ---------------------------------------------------------------------------
# Lightweight metadata enrichment (no LLM needed)
# ---------------------------------------------------------------------------

def enrich_node_metadata(nodes: List[BaseNode]) -> List[BaseNode]:
    """
    Sets default values for metadata keys that downstream code expects,
    without making any LLM calls.  Use when use_metadata_extractors=False.
    """
    for node in nodes:
        meta = node.metadata
        meta.setdefault("document_title",  meta.get("file_name", "Unknown"))
        meta.setdefault("section_summary", "")
        meta.setdefault("excerpt_keywords", "")
        meta.setdefault("questions_this_excerpt_can_answer", "")
    return nodes


# ---------------------------------------------------------------------------
# Standalone smoke-test
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import sys
    import tempfile
    from pathlib import Path

    # Allow running from src/ or from AdvRag/ root
    SRC = Path(__file__).resolve().parent.parent
    if str(SRC) not in sys.path:
        sys.path.insert(0, str(SRC))

    from llama_index.core import Document
    from core.llm import get_llm

    async def _smoke_test():
        # MUST be called before build_ingestion_pipeline so Settings.llm is
        # set to Groq — the _get_llm() guard will catch it if you forget.
        get_llm()

        # One prose doc + one simulated table doc
        docs = [
            Document(
                text=(
                    "# Introduction to RAG\n\n"
                    "Retrieval-Augmented Generation (RAG) combines a retrieval "
                    "component with a generative LLM to ground answers in facts.\n\n"
                    "## Why RAG?\n\n"
                    "LLMs hallucinate. RAG fixes this by injecting relevant "
                    "documents into the prompt before generation."
                ),
                metadata={"file_name": "rag_intro.md", "file_type": "md"},
            ),
            Document(
                text=(
                    "Feature          | Status      | Priority\n"
                    "User login       | Done        | High\n"
                    "Stream playback  | In Progress | High\n"
                    "Admin dashboard  | Planned     | Medium"
                ),
                metadata={
                    "file_name":    "ott_srs.docx",
                    "file_type":    "docx",
                    "content_type": "table",   # ← skips SentenceSplitter
                    "table_index":  0,
                },
            ),
        ]

        with tempfile.TemporaryDirectory() as tmp:
            nodes = await arun_pipeline(docs, use_metadata_extractors=True, cache_dir=tmp)

        print(f"\n{'='*55}")
        print(f"  Total nodes produced: {len(nodes)}")
        print(f"{'='*55}")
        for n in nodes:
            kind = n.metadata.get("node_kind", "prose")
            print(f"\n[Node | {kind}]  {n.id_}")
            print(f"  Title    : {n.metadata.get('document_title', '—')[:80]}")
            print(f"  Summary  : {n.metadata.get('section_summary', '—')[:80]}")
            print(f"  Keywords : {n.metadata.get('excerpt_keywords', '—')[:60]}")
            print(f"  Content  : {n.get_content()[:100]} …")

    asyncio.run(_smoke_test())
