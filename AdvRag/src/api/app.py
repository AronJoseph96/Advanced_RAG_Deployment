"""
api/app.py  (updated with /flush endpoint)
"""

import os
import asyncio
import tempfile
import shutil
from pathlib import Path
from typing import AsyncGenerator, Optional
from config import settings

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, UploadFile, File, Form, BackgroundTasks
from fastapi.responses import StreamingResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from main import agent

load_dotenv()

app = FastAPI(
    title="Agentic Hybrid RAG API",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=os.getenv("CORS_ORIGINS", "*").split(","),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

_LLM_SEMAPHORE = asyncio.Semaphore(2)


@app.on_event("startup")
async def startup_event() -> None:
    await agent.initialise()


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------

class ChatRequest(BaseModel):
    query: str
    session_reset: bool = False


class ChatResponse(BaseModel):
    query:    str
    response: str


class IngestDirectoryRequest(BaseModel):
    directory:     str
    chunk_size:    int = settings.CHUNK_SIZE
    chunk_overlap: int = settings.CHUNK_OVERLAP


class IngestResponse(BaseModel):
    message: str
    count:   int
    detail:  str = ""


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

async def _save_upload_to_tempdir(files: list[UploadFile]) -> str:
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
    return {"status": "ok", "agent_ready": agent._ready}


# ── Flush ────────────────────────────────────────────────────────────────────

@app.delete("/flush", tags=["ops"])
async def flush_all() -> dict:
    """
    Deletes ALL vectors from Pinecone and ALL tables from SQLite.
    Use before ingesting a fresh document set to prevent stale data bleed.
    """
    results = {}

    # 1. Pinecone — delete all vectors
    try:
        from pinecone import Pinecone as _Pinecone
        pc = _Pinecone(api_key=settings.PINECONE_API_KEY)
        idx = pc.Index(settings.PINECONE_INDEX_NAME)
        idx.delete(delete_all=True)
        results["pinecone"] = "all vectors deleted"
        print("[Flush] Pinecone index cleared.")
    except Exception as exc:
        results["pinecone"] = f"error: {exc}"
        print(f"[Flush] Pinecone error: {exc}")

    # 2. SQLite — drop every table
    try:
        from sqlalchemy import create_engine, inspect, text as sa_text
        engine = create_engine(f"sqlite:///{settings.SQLITE_DB_PATH}")
        inspector = inspect(engine)
        tables = inspector.get_table_names()
        with engine.connect() as conn:
            for tbl in tables:
                conn.execute(sa_text(f'DROP TABLE IF EXISTS "{tbl}"'))
            conn.commit()
        results["sqlite"] = f"dropped tables: {tables}" if tables else "no tables"
        print(f"[Flush] SQLite tables dropped: {tables}")
    except Exception as exc:
        results["sqlite"] = f"error: {exc}"
        print(f"[Flush] SQLite error: {exc}")

    # 3. Reset agent SQL manager
    try:
        agent.sql_manager._db = None
        agent.sql_manager._query_engine = None
        results["agent_sql"] = "sql manager reset"
    except Exception as exc:
        results["agent_sql"] = f"error: {exc}"

    # 4. Also wipe IngestionPipeline docstore cache so re-uploads re-process
    try:
        cache_path = Path(settings.CACHE_DIR) / "docstore.json"
        if cache_path.exists():
            cache_path.unlink()
            results["docstore_cache"] = "cleared"
            print("[Flush] Docstore cache cleared.")
    except Exception as exc:
        results["docstore_cache"] = f"error: {exc}"

    return {
        "message": "Flush complete. Upload new documents before querying.",
        "detail": results,
    }


# ── Document ingestion ───────────────────────────────────────────────────────

@app.post("/ingest/documents", response_model=IngestResponse, tags=["ingestion"])
async def ingest_documents_from_directory(req: IngestDirectoryRequest) -> IngestResponse:
    directory = Path(req.directory)
    if not directory.exists() or not directory.is_dir():
        raise HTTPException(status_code=400, detail=f"Directory '{req.directory}' not found.")

    async with _LLM_SEMAPHORE:
        try:
            count = await agent.ingest_documents(
                str(directory), chunk_size=req.chunk_size, chunk_overlap=req.chunk_overlap,
            )
        except Exception as exc:
            raise HTTPException(status_code=500, detail=str(exc))

    return IngestResponse(message=f"Ingested from '{req.directory}'.", count=count)


@app.post("/ingest/documents/upload", response_model=IngestResponse, tags=["ingestion"])
async def upload_and_ingest_documents(
    background_tasks: BackgroundTasks,
    files: list[UploadFile] = File(...),
    chunk_size:    int = Form(settings.CHUNK_SIZE),
    chunk_overlap: int = Form(settings.CHUNK_OVERLAP),
) -> IngestResponse:
    tmp_dir = await _save_upload_to_tempdir(files)
    background_tasks.add_task(shutil.rmtree, tmp_dir, True)

    async with _LLM_SEMAPHORE:
        try:
            count = await agent.ingest_documents(tmp_dir, chunk_size=chunk_size, chunk_overlap=chunk_overlap)
        except Exception as exc:
            shutil.rmtree(tmp_dir, ignore_errors=True)
            raise HTTPException(status_code=500, detail=str(exc))

    return IngestResponse(
        message="Files uploaded and ingested.",
        count=count,
        detail=f"Files: {[f.filename for f in files]}",
    )


# ── CSV ingestion ────────────────────────────────────────────────────────────

@app.post("/ingest/csv", response_model=IngestResponse, tags=["ingestion"])
async def upload_and_ingest_csv(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    table_name: Optional[str] = Form(None),
) -> IngestResponse:
    if not (file.filename or "").lower().endswith(".csv"):
        raise HTTPException(status_code=400, detail="Only .csv files accepted.")

    tmp_dir  = tempfile.mkdtemp(prefix="rag_csv_")
    tmp_path = Path(tmp_dir) / (file.filename or "upload.csv")
    tmp_path.write_bytes(await file.read())
    background_tasks.add_task(shutil.rmtree, tmp_dir, True)

    try:
        table = await agent.ingest_csv(str(tmp_path), table_name=table_name)
    except Exception as exc:
        shutil.rmtree(tmp_dir, ignore_errors=True)
        raise HTTPException(status_code=500, detail=str(exc))

    return IngestResponse(message=f"CSV loaded into table '{table}'.", count=1, detail=f"File: {file.filename}")


# ── Chat ─────────────────────────────────────────────────────────────────────

@app.post("/chat", response_model=ChatResponse, tags=["chat"])
async def chat(req: ChatRequest) -> ChatResponse:
    if req.session_reset:
        agent.reset_memory()

    async with _LLM_SEMAPHORE:
        try:
            reply = await agent.chat(req.query)
        except Exception as exc:
            raise HTTPException(status_code=500, detail=str(exc))

    return ChatResponse(query=req.query, response=reply)


@app.get("/chat/stream", tags=["chat"])
async def chat_stream(query: str, session_reset: bool = False) -> StreamingResponse:
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
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.delete("/chat/memory", tags=["chat"])
async def reset_memory() -> dict:
    agent.reset_memory()
    return {"message": "Conversation memory cleared."}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("advrag.api.app:app", host="0.0.0.0", port=8000, reload=True, workers=1, loop="asyncio")