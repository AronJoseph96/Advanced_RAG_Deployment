"""
config.py
---------
Single source of truth for every tuneable constant in the system.
All values are read from the environment / .env file via Pydantic Settings,
so nothing is hard-coded outside this module.

Stack
-----
  LLM        : Groq  (llama-3.3-70b-versatile or any Groq-hosted model)
  Embeddings : Mixedbread AI  (mxbai-embed-large-v1, 1024-dim)
  Reranker   : Mixedbread AI  (mxbai-rerank-large-v1)
  Vector DB  : Pinecone Serverless (dotproduct metric, hybrid sparse+dense)
  Structured : SQLite via SQLAlchemy + LlamaIndex NLSQLTableQueryEngine

Usage (anywhere in the codebase)
---------------------------------
    from config import settings

    api_key = settings.GROQ_API_KEY
    model   = settings.LLM_MODEL
"""
from pathlib import Path
from pydantic_settings import BaseSettings, SettingsConfigDict

# Resolve paths relative to this file so they work regardless of cwd.
SRC_DIR      = Path(__file__).resolve().parent   
REPO_ROOT    = SRC_DIR.parent.parent             


class Settings(BaseSettings):

    # ── API Keys ────────────────────────────────────────────────────────────
    GROQ_API_KEY:         str          # Groq Cloud — required
    PINECONE_API_KEY:     str          # Pinecone Serverless — required
    MIXEDBREAD_API_KEY:   str          # Mixedbread AI — required for embed + rerank
    LLAMA_CLOUD_API_KEY:  str = ""     # LlamaParse (optional; leave blank for local readers)

    # ── Pinecone ────────────────────────────────────────────────────────────
    PINECONE_INDEX_NAME: str = "rag-index"
    PINECONE_NAMESPACE:  str = "default"
    PINECONE_CLOUD:      str = "aws"
    PINECONE_REGION:     str = "us-east-1"

    # ── Model identifiers ───────────────────────────────────────────────────
    # LLM served by Groq (fast inference, OpenAI-compatible API)
    LLM_MODEL: str = "llama-3.3-70b-versatile"
    
    # Mixedbread embedding model — 1024-dim, top MTEB retrieval performance.
    # FIX: was "mixedbread-ai/mxbai-wholembed-v3" which does not exist.
    # The correct model identifier is "mixedbread-ai/mxbai-embed-large-v1".
    EMBEDDING_MODEL: str = "mixedbread-ai/mxbai-embed-large-v1"
    EMBEDDING_DIM:   int = 1024  # must match the model's output dimension

    # Cross-encoder reranker — separate API endpoint from embeddings
    RERANKER_MODEL: str = "mixedbread-ai/mxbai-rerank-large-v1"
    RERANKER_TOP_N: int = 5      # nodes kept after reranking

    # ── Chunking ────────────────────────────────────────────────────────────
    CHUNK_SIZE:    int = 512    # SentenceSplitter chunk_size (tokens)
    CHUNK_OVERLAP: int = 64    # SentenceSplitter chunk_overlap (tokens)

    # ── Retrieval ───────────────────────────────────────────────────────────
    TOP_K:            int   = 10    # candidates fetched from Pinecone before rerank
    HYBRID_ALPHA:     float = 0.5   # 0.0 = full sparse (BM25), 1.0 = full dense
    EMBED_BATCH_SIZE: int   = 32    # keep low to avoid OOM on 12 GB i3

    # ── Agent memory ────────────────────────────────────────────────────────
    MEMORY_TOKEN_LIMIT: int = 4096

    # ── Storage paths ───────────────────────────────────────────────────────
    SQLITE_DB_PATH: str = "storage/structured_data.db"
    DOCUMENTS_DIR:  str = "data/docs"
    DATA_DIR:       str = "data/tables"
    CACHE_DIR:      str = "storage/pipeline_cache"   # IngestionPipeline docstore

    model_config = SettingsConfigDict(
        env_file=(".env", "../.env", "../../.env"),
        env_file_encoding="utf-8",
        extra="ignore",   # ignore unknown env vars so the app never crashes on startup
    )


# Module-level singleton — import this everywhere; never re-instantiate Settings.
settings = Settings()
