"""
main.py
-------
Agentic RAG orchestrator — updated for llama-index-core >= 0.12
where ReActAgent is a Workflow-based class.

Streaming fix
-------------
AgentStream events fire for ALL LLM tokens including Thought/Action/Observation.
We buffer and only yield tokens that appear after 'Answer:' so the frontend
never sees internal ReAct reasoning traces.
"""

import os
import asyncio
from typing import AsyncGenerator, Optional

from dotenv import load_dotenv

from llama_index.core import Settings
from llama_index.core.agent import ReActAgent, AgentStream
from llama_index.core.memory import ChatMemoryBuffer
from llama_index.core.tools import QueryEngineTool

from config import settings
from core.llm import get_llm, warmup_llm
from storage.vector_store import init_vector_store, aupsert_nodes
from storage.sql_store import SQLStoreManager
from data_pipeline.loader import aload_documents_from_directory
from data_pipeline.transformation import arun_pipeline

load_dotenv()

SQLITE_DB_PATH: str = settings.SQLITE_DB_PATH

# ---------------------------------------------------------------------------
# System prompt
# ---------------------------------------------------------------------------

AGENT_SYSTEM_PROMPT = """\
You are an expert research assistant. You have access to two tools:

1. document_knowledge_search  
   Use for ANY question about uploaded documents, PDFs, resumes, reports,  
   policies, or unstructured text. Also use for open-ended or descriptive  
   questions. Always try this tool first when the user asks about a person,  
   topic, or file.

2. structured_data_analytics  
   Use ONLY for questions about uploaded CSV/spreadsheet data requiring  
   counts, sums, averages, rankings, or SQL-style filtering.

Rules:
- Always call a tool before answering. Do not answer from memory alone.
- For ambiguous queries, prefer document_knowledge_search.
- Cite the source file name when possible.
- If a tool returns no results, say so clearly — never hallucinate.
- Be concise and use markdown where it helps clarity.
"""

# ReAct final answer marker — only tokens after this prefix reach the user
_ANSWER_PREFIX = "Answer:"


# ---------------------------------------------------------------------------
# RAGAgent
# ---------------------------------------------------------------------------

class RAGAgent:
    def __init__(self):
        self.llm:          Optional[object]          = None
        self.sql_manager:  Optional[SQLStoreManager] = None
        self.vector_index: Optional[object]          = None
        self._agent:       Optional[ReActAgent]      = None
        self._memory:      Optional[ChatMemoryBuffer]= None
        self._tools:       list                      = []
        self._ready:       bool                      = False

    async def initialise(self) -> None:
        if self._ready:
            return

        print("[Agent] Initialising RAG Agent ...")

        self.llm = get_llm()
        Settings.llm = self.llm

        await warmup_llm(self.llm)

        self.vector_index, _, _, vector_tool = await init_vector_store()

        self.sql_manager = SQLStoreManager(llm=self.llm, db_path=SQLITE_DB_PATH)
        sql_tool = self.sql_manager.get_tool()

        self._tools  = [vector_tool, sql_tool]
        self._memory = self._new_memory()
        self._agent  = self._build_agent()

        self._ready = True
        print("[Agent] Ready")

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _build_agent(self) -> ReActAgent:
        """
        New API (>= 0.12): ReActAgent instantiated directly, no from_tools().
        Memory is passed per-run. verbose=False prevents reasoning traces
        from leaking into the streamed output.
        """
        return ReActAgent(
            tools=self._tools,
            llm=self.llm,
            system_prompt=AGENT_SYSTEM_PROMPT,
            max_iterations=10,
            verbose=False,
        )

    def _new_memory(self) -> ChatMemoryBuffer:
        return ChatMemoryBuffer.from_defaults(
            token_limit=settings.MEMORY_TOKEN_LIMIT,
        )

    def _assert_ready(self) -> None:
        if not self._ready or self._agent is None:
            raise RuntimeError(
                "RAGAgent not initialised. Call `await agent.initialise()` first."
            )

    # ------------------------------------------------------------------
    # Chat interface
    # ------------------------------------------------------------------

    async def chat(self, query: str) -> str:
        """
        Non-streaming chat.
        WorkflowHandler is awaitable — resolves to the final AgentOutput.
        Strips ReAct reasoning traces from the result before returning.
        """
        self._assert_ready()
        handler = self._agent.run(
            user_msg=query,
            memory=self._memory,
        )
        result = await handler
        return _extract_answer(str(result))

    async def stream_chat(self, query: str) -> AsyncGenerator[str, None]:
        self._assert_ready()

        # Strategy:
        #   1. Run the agent and consume AgentStream events, buffering until
        #      the "Answer:" marker appears, then yield all subsequent tokens.
        #   2. If nothing was yielded (marker never appeared, or an exception
        #      was raised mid-stream), fall back to a *fresh* blocking chat()
        #      call. Never re-await a handler that already started streaming —
        #      ReActAgent raises on a second await once tool calls have begun.

        accumulated    = ""
        answer_started = False
        any_yielded    = False
        stream_exc: Optional[Exception] = None

        try:
            handler = self._agent.run(
                user_msg=query,
                memory=self._memory,
            )

            async for event in handler.stream_events():
                if not isinstance(event, AgentStream):
                    continue

                delta = event.delta
                if not delta:
                    continue

                if answer_started:
                    yield delta
                    any_yielded = True
                else:
                    accumulated += delta
                    idx = accumulated.find(_ANSWER_PREFIX)
                    if idx != -1:
                        answer_started = True
                        after = accumulated[idx + len(_ANSWER_PREFIX):].lstrip(" ")
                        if after:
                            yield after
                            any_yielded = True

        except Exception as exc:
            stream_exc = exc
            print(f"[Agent] stream_chat streaming error: {exc}")

        # ── Fallback: if nothing was yielded, run a fresh blocking chat() ──
        if not any_yielded:
            try:
                fallback = await self.chat(query)
                if fallback:
                    yield fallback
            except Exception as fb_exc:
                original = str(stream_exc) if stream_exc else str(fb_exc)
                yield f"[Error] {original}"

    def reset_memory(self) -> None:
        """Replaces the memory buffer with a fresh one, clearing history."""
        self._memory = self._new_memory()

    # ------------------------------------------------------------------
    # Runtime ingestion
    # ------------------------------------------------------------------

    async def ingest_documents(
        self,
        directory: str,
        chunk_size:    int = 1000,
        chunk_overlap: int = 200,
    ) -> int:
        self._assert_ready()
        print(f"[Agent] Ingesting from '{directory}' ...")

        docs = await aload_documents_from_directory(directory)
        if not docs:
            print("[Agent] No supported files found.")
            return 0

        nodes = await arun_pipeline(
            docs,
            use_metadata_extractors=False,
            chunk_size=chunk_size,
            chunk_overlap=chunk_overlap,
        )

        count = await aupsert_nodes(self.vector_index, nodes)
        print(f"[Agent] Ingestion complete — {count} nodes in Pinecone.")
        return count

    async def ingest_csv(self, csv_path: str, table_name: Optional[str] = None) -> str:
        self._assert_ready()
        name = await self.sql_manager.aload_csv(csv_path, table_name=table_name)

        new_sql_tool = self.sql_manager.get_tool()
        self._tools = [
            t for t in self._tools
            if t.metadata.name != "structured_data_analytics"
        ]
        self._tools.append(new_sql_tool)

        # Rebuild agent with updated tools; memory lives on self._memory
        self._agent = self._build_agent()

        print(f"[Agent] CSV ingested — table '{name}' queryable.")
        return name


# ---------------------------------------------------------------------------
# Helper: strip ReAct trace from full response string
# ---------------------------------------------------------------------------

def _extract_answer(full_response: str) -> str:
    """
    Returns only the text after the last 'Answer:' marker.
    Falls back to the full string if the marker is absent.
    """
    idx = full_response.rfind(_ANSWER_PREFIX)
    if idx != -1:
        return full_response[idx + len(_ANSWER_PREFIX):].strip()
    return full_response.strip()


# ---------------------------------------------------------------------------
# Module-level singleton
# ---------------------------------------------------------------------------

agent = RAGAgent()


if __name__ == "__main__":
    async def _smoke_test():
        await agent.initialise()
        answer = await agent.chat("What documents are currently indexed?")
        print("\n[Smoke] Agent reply:", answer)

    asyncio.run(_smoke_test())