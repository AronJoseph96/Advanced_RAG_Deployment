"""
api/app.py
----------
FastAPI backend for the Agentic Hybrid RAG system.

Endpoints
---------
GET  /health                  → liveness + readiness probe
POST /ingest/documents        → load files from a server-side directory into Pinecone
POST /ingest/documents/upload → upload files and ingest into Pinecone
POST /ingest/csv              → upload a CSV file and load it into SQLite
POST /chat                    → single-turn chat, returns full JSON response
GET  /chat/stream             → streaming chat via Server-Sent Events (SSE)
DELETE /chat/memory           → reset the agent's conversation memory

Design choices for an Intel i3 / 12 GB machine
-----------------------------------------------
* One global RAGAgent singleton — no per-request re-initialisation.
* All agent calls are async — the single Uvicorn worker's event loop
  stays responsive while Groq / Pinecone I/O is in-flight.
* StreamingResponse is used for SSE so tokens flow to the client as
  they arrive instead of buffering the full reply.
* A request-level asyncio.Semaphore limits concurrent LLM calls to 2
  so the i3 is not overwhelmed during burst traffic.
* File uploads are written to a temp directory then ingested; the temp
  dir is cleaned up regardless of success or failure.

Run
---
    uvicorn advrag.api.app:app --host 0.0.0.0 --port 8000 --reload
"""

import os
import asyncio
import tempfile
import shutil
from pathlib import Path
from typing import AsyncGenerator, Optional

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, UploadFile, File, Form, BackgroundTasks
from fastapi.responses import StreamingResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# Import the module-level agent singleton — advrag.main is the correct package path
from main import agent

load_dotenv()

# ---------------------------------------------------------------------------
# App setup
# ---------------------------------------------------------------------------

app = FastAPI(
    title="Agentic Hybrid RAG API",
    description=(
        "Groq-powered RAG over Pinecone (documents) + SQLite (structured data). "
        "Embeddings and reranking by Mixedbread AI."
    ),
    version="1.0.0",
)

# CORS — tighten origins in production
app.add_middleware(
    CORSMiddleware,
    allow_origins=os.getenv("CORS_ORIGINS", "*").split(","),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Semaphore: max 2 concurrent LLM calls on the i3
_LLM_SEMAPHORE = asyncio.Semaphore(2)


# ---------------------------------------------------------------------------
# Startup
# ---------------------------------------------------------------------------

@app.on_event("startup")
async def startup_event() -> None:
    """
    Initialise the RAGAgent once when Uvicorn starts.
    Blocking network calls (Pinecone, Groq warmup, Mixedbread) are awaited
    here so the first real request is never the one that pays the cold-start
    cost.
    """
    await agent.initialise()


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------

class ChatRequest(BaseModel):
    query: str
    session_reset: bool = False   # set True to wipe memory before the query


class ChatResponse(BaseModel):
    query:    str
    response: str


class IngestDirectoryRequest(BaseModel):
    directory:     str   # absolute or relative server-side path
    chunk_size:    int   = 1000
    chunk_overlap: int   = 200


class IngestResponse(BaseModel):
    message: str
    count:   int         # nodes upserted (documents) or 1 (CSV)
    detail:  str = ""


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

async def _save_upload_to_tempdir(files: list[UploadFile]) -> str:
    """Saves uploaded files to a fresh temp directory, returns its path."""
    tmp = tempfile.mkdtemp(prefix="rag_upload_")
    for upload in files:
        dest = Path(tmp) / (upload.filename or "upload")
        content = await upload.read()
        dest.write_bytes(content)
    return tmp


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.get("/health", tags=["ops"])
async def health() -> dict:
    """Liveness + readiness probe."""
    return {
        "status": "ok",
        "agent_ready": agent._ready,
    }


# ── Document ingestion ───────────────────────────────────────────────────────

@app.post("/ingest/documents", response_model=IngestResponse, tags=["ingestion"])
async def ingest_documents_from_directory(req: IngestDirectoryRequest) -> IngestResponse:
    """
    Triggers ingestion of all supported files (.pdf, .docx, .md, .txt)
    from a server-side directory path into Pinecone.
    """
    directory = Path(req.directory)
    if not directory.exists() or not directory.is_dir():
        raise HTTPException(
            status_code=400,
            detail=f"Directory '{req.directory}' does not exist or is not a directory.",
        )

    async with _LLM_SEMAPHORE:
        try:
            count = await agent.ingest_documents(
                str(directory),
                chunk_size=req.chunk_size,
                chunk_overlap=req.chunk_overlap,
            )
        except Exception as exc:
            raise HTTPException(status_code=500, detail=str(exc))

    return IngestResponse(
        message=f"Successfully ingested documents from '{req.directory}'.",
        count=count,
    )


@app.post("/ingest/documents/upload", response_model=IngestResponse, tags=["ingestion"])
async def upload_and_ingest_documents(
    background_tasks: BackgroundTasks,
    files: list[UploadFile] = File(...),
    chunk_size:    int = Form(1000),
    chunk_overlap: int = Form(200),
) -> IngestResponse:
    """
    Upload one or more document files and ingest them into Pinecone.
    Supported types: .pdf, .docx, .md, .txt
    """
    tmp_dir = await _save_upload_to_tempdir(files)
    background_tasks.add_task(shutil.rmtree, tmp_dir, True)

    async with _LLM_SEMAPHORE:
        try:
            count = await agent.ingest_documents(
                tmp_dir,
                chunk_size=chunk_size,
                chunk_overlap=chunk_overlap,
            )
        except Exception as exc:
            shutil.rmtree(tmp_dir, ignore_errors=True)
            raise HTTPException(status_code=500, detail=str(exc))

    filenames = [f.filename for f in files]
    return IngestResponse(
        message="Files uploaded and ingested.",
        count=count,
        detail=f"Files: {filenames}",
    )


# ── CSV ingestion ────────────────────────────────────────────────────────────

@app.post("/ingest/csv", response_model=IngestResponse, tags=["ingestion"])
async def upload_and_ingest_csv(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    table_name: Optional[str] = Form(None),
) -> IngestResponse:
    """
    Upload a CSV file and load it as a table in the SQLite database.
    The agent can query it immediately after ingestion.
    """
    if not (file.filename or "").lower().endswith(".csv"):
        raise HTTPException(status_code=400, detail="Only .csv files are accepted here.")

    tmp_dir  = tempfile.mkdtemp(prefix="rag_csv_")
    tmp_path = Path(tmp_dir) / (file.filename or "upload.csv")
    tmp_path.write_bytes(await file.read())
    background_tasks.add_task(shutil.rmtree, tmp_dir, True)

    try:
        table = await agent.ingest_csv(str(tmp_path), table_name=table_name)
    except Exception as exc:
        shutil.rmtree(tmp_dir, ignore_errors=True)
        raise HTTPException(status_code=500, detail=str(exc))

    return IngestResponse(
        message=f"CSV loaded into SQLite table '{table}'.",
        count=1,
        detail=f"File: {file.filename}",
    )


# ── Chat ─────────────────────────────────────────────────────────────────────

@app.post("/chat", response_model=ChatResponse, tags=["chat"])
async def chat(req: ChatRequest) -> ChatResponse:
    """
    Single-turn chat endpoint. Returns the full agent response as JSON.
    For streaming (recommended for long answers), use GET /chat/stream instead.
    """
    if req.session_reset:
        agent.reset_memory()

    async with _LLM_SEMAPHORE:
        try:
            reply = await agent.chat(req.query)
        except Exception as exc:
            raise HTTPException(status_code=500, detail=str(exc))

    return ChatResponse(query=req.query, response=reply)


@app.get("/chat/stream", tags=["chat"])
async def chat_stream(
    query: str,
    session_reset: bool = False,
) -> StreamingResponse:
    """
    Streaming chat via Server-Sent Events (SSE).

    Each SSE event:   data: <token>\\n\\n
    Final sentinel:   data: [DONE]\\n\\n
    """
    if session_reset:
        agent.reset_memory()

    async def _event_generator() -> AsyncGenerator[str, None]:
        async with _LLM_SEMAPHORE:
            try:
                async for token in agent.stream_chat(query):
                    safe_token = token.replace("\n", "\\n")
                    yield f"data: {safe_token}\n\n"
            except Exception as exc:
                yield f"data: [ERROR] {exc}\n\n"
            finally:
                yield "data: [DONE]\n\n"

    return StreamingResponse(
        _event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",   # disable nginx buffering for SSE
        },
    )


# ── Session management ───────────────────────────────────────────────────────

@app.delete("/chat/memory", tags=["chat"])
async def reset_memory() -> dict:
    """Clears the agent's conversation memory."""
    agent.reset_memory()
    return {"message": "Conversation memory cleared."}


# ---------------------------------------------------------------------------
# Dev entry-point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "advrag.api.app:app",
        host="0.0.0.0",
        port=8000,
        reload=True,
        workers=1,
        loop="asyncio",
    )