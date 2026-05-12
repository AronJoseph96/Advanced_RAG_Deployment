"""
main.py
-------
Agentic RAG orchestrator using LlamaIndex's FunctionAgent (v0.14+ workflow API).

Architecture
------------
                    ┌────────────────────────────────────┐
  User query ──────►│        FunctionAgent               │
                    │   (Groq — llama-3.1-8b-instant)    │
                    └──────┬─────────────────┬───────────┘
                           │                 │
              ┌────────────▼──┐   ┌──────────▼──────────────────┐
              │  SQL Tool     │   │  Vector Tool                │
              │ NLSQLTable    │   │  QueryFusionRetriever (RRF)  │
              │ QueryEngine   │   │  + Mixedbread Reranker       │
              └────────────┬──┘   └──────────┬──────────────────┘
                           │                 │
                    SQLite DB         Pinecone Serverless
                   (structured)       (documents / unstructured)

llama-index-core 0.14+ Agent API
----------------------------------
  FunctionAgent is constructed directly (no .from_tools classmethod):
      agent = FunctionAgent(tools=[...], llm=..., system_prompt=...)

  Each call to .run() returns a WorkflowHandler:
      handler = agent.run(user_msg=query, memory=memory)
      result  = await handler          # AgentOutput — str(result) is the reply

  Streaming uses handler.stream_events() and filters for AgentStream events:
      async for ev in handler.stream_events():
          if isinstance(ev, AgentStream):
              yield ev.delta

  Conversation memory is a ChatMemoryBuffer kept on the RAGAgent instance
  and passed into every .run() call so the agent sees prior turns.

Startup sequence
----------------
  1. get_llm()              → Groq instance → Settings.llm
  2. init_vector_store()    → Pinecone index + Mixedbread embed/rerank + tool
  3. SQLStoreManager        → NLSQLTableQueryEngine + tool
  4. FunctionAgent(tools=[vector_tool, sql_tool])
"""

import os
import asyncio
from typing import AsyncGenerator, Optional

from dotenv import load_dotenv

# LlamaIndex core
from llama_index.core import Settings
from llama_index.core.agent import FunctionAgent
from llama_index.core.agent.workflow import AgentStream
from llama_index.core.memory import ChatMemoryBuffer
from llama_index.core.tools import QueryEngineTool

# Local modules
from config import settings
from core.llm import get_llm, warmup_llm
from storage.vector_store import init_vector_store, aupsert_nodes
from storage.sql_store import SQLStoreManager
from data_pipeline.loader import aload_documents_from_directory
from data_pipeline.transformation import arun_pipeline

load_dotenv()

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

SQLITE_DB_PATH: str = settings.SQLITE_DB_PATH

# ---------------------------------------------------------------------------
# System prompt
# ---------------------------------------------------------------------------

AGENT_SYSTEM_PROMPT = """\
You are an expert research assistant with access to two knowledge sources:

1. **document_knowledge_search** -- searches unstructured documents, reports,
   and research papers using hybrid semantic + keyword retrieval with
   cross-encoder reranking (Mixedbread AI).
   Use this for conceptual, descriptive, or open-ended questions.

2. **structured_data_analytics** -- queries a structured SQLite database
   using natural language converted to SQL.
   Use this for numerical, comparative, or filter-based questions
   (counts, averages, rankings, date ranges, specific records).

## Rules
- Always pick the most appropriate tool for the question.
- For questions that span both sources, call both tools and synthesise.
- Cite sources from document metadata (file_name, section_header) when possible.
- If neither tool returns useful context, say so -- do not hallucinate.
- Be concise, use markdown formatting, and prefer tables for numerical data.
"""


# ---------------------------------------------------------------------------
# RAGAgent
# ---------------------------------------------------------------------------

class RAGAgent:
    def __init__(self):
        self.llm:          Optional[object]           = None
        self.sql_manager:  Optional[SQLStoreManager]  = None
        self.vector_index: Optional[object]           = None
        self._agent:       Optional[FunctionAgent]    = None
        self._memory:      Optional[ChatMemoryBuffer] = None
        self._tools:       list[QueryEngineTool]      = []
        self._ready:       bool                       = False

    async def initialise(self) -> None:
        if self._ready:
            return

        print("[Agent] Initialising RAG Agent ...")

        # 1. LLM (Groq) -- set Settings.llm before anything else
        self.llm = get_llm()
        Settings.llm = self.llm

        # 2. Lightweight credential ping (failure is non-fatal -- logged only)
        await warmup_llm(self.llm)

        # 3. Vector store (Pinecone + Mixedbread embed + rerank)
        self.vector_index, _, _, vector_tool = await init_vector_store()

        # 4. SQL store (SQLite)
        self.sql_manager = SQLStoreManager(
            llm=self.llm,
            db_path=SQLITE_DB_PATH,
        )
        sql_tool = self.sql_manager.get_tool()

        # 5. Build agent and fresh memory buffer
        self._tools = [vector_tool, sql_tool]
        self._agent = self._build_agent()
        self._memory = self._new_memory()

        self._ready = True
        print("[Agent] Ready")

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _build_agent(self) -> FunctionAgent:
        """
        Constructs a FunctionAgent using the llama-index-core 0.14+ API.
        Direct constructor -- no .from_tools() classmethod in this version.
        """
        return FunctionAgent(
            tools=self._tools,
            llm=self.llm,
            system_prompt=AGENT_SYSTEM_PROMPT,
            verbose=False,
        )

    def _new_memory(self) -> ChatMemoryBuffer:
        """Returns a fresh ChatMemoryBuffer for a new conversation session."""
        return ChatMemoryBuffer.from_defaults(
            token_limit=settings.MEMORY_TOKEN_LIMIT,
        )

    def _assert_ready(self) -> None:
        if not self._ready or self._agent is None:
            raise RuntimeError(
                "RAGAgent is not initialised. Call `await agent.initialise()` first."
            )

    # ------------------------------------------------------------------
    # Chat interface
    # ------------------------------------------------------------------

    async def chat(self, query: str) -> str:
        """
        Single-turn chat. Returns the full response string.
        Conversation history is preserved in self._memory across calls.
        """
        self._assert_ready()
        handler = self._agent.run(user_msg=query, memory=self._memory)
        result = await handler
        return str(result)

    async def stream_chat(self, query: str) -> AsyncGenerator[str, None]:
        """
        Streaming chat via WorkflowHandler.stream_events().
        Yields individual token deltas as they arrive from Groq.
        Conversation history is preserved in self._memory across calls.
        """
        self._assert_ready()
        handler = self._agent.run(user_msg=query, memory=self._memory)
        async for event in handler.stream_events():
            if isinstance(event, AgentStream):
                if event.delta:
                    yield event.delta

    def reset_memory(self) -> None:
        """Clears conversation history for a fresh session."""
        self._assert_ready()
        self._memory = self._new_memory()

    # ------------------------------------------------------------------
    # Runtime ingestion
    # ------------------------------------------------------------------

    async def ingest_documents(
        self,
        directory: str,
        chunk_size: int    = 1000,
        chunk_overlap: int = 200,
    ) -> int:
        """
        Loads, chunks, and upserts documents from a directory into Pinecone.
        chunk_size / chunk_overlap are forwarded to SentenceSplitter.
        """
        self._assert_ready()
        print(f"[Agent] Ingesting documents from '{directory}' ...")

        docs = await aload_documents_from_directory(directory)
        if not docs:
            print("[Agent] No supported files found -- nothing upserted.")
            return 0

        from llama_index.core.node_parser import SentenceSplitter
        from llama_index.core.ingestion import IngestionPipeline

        splitter = SentenceSplitter(
            chunk_size=chunk_size,
            chunk_overlap=chunk_overlap,
            paragraph_separator="\n\n",
        )
        pipeline = IngestionPipeline(transformations=[splitter])

        loop = asyncio.get_running_loop()
        try:
            nodes = await pipeline.arun(documents=docs)
        except AttributeError:
            nodes = await loop.run_in_executor(None, pipeline.run, docs)

        count = await aupsert_nodes(self.vector_index, nodes)
        print(f"[Agent] Ingestion complete -- {count} nodes added to Pinecone.")
        return count

    async def ingest_csv(
        self,
        csv_path: str,
        table_name: Optional[str] = None,
    ) -> str:
        """
        Loads a CSV into SQLite and rebuilds the agent so the new table
        is immediately queryable.
        """
        self._assert_ready()
        name = await self.sql_manager.aload_csv(csv_path, table_name=table_name)

        # Swap in a fresh SQL tool that knows about the new table
        new_sql_tool = self.sql_manager.get_tool()
        self._tools = [
            t for t in self._tools
            if t.metadata.name != "structured_data_analytics"
        ]
        self._tools.append(new_sql_tool)

        # Rebuild agent with updated tool list (memory preserved)
        self._agent = self._build_agent()

        print(f"[Agent] CSV ingested -- table '{name}' is now queryable.")
        return name


# ---------------------------------------------------------------------------
# Module-level singleton  (imported by app.py)
# ---------------------------------------------------------------------------

agent = RAGAgent()


# ---------------------------------------------------------------------------
# Standalone smoke-test
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    async def _smoke_test():
        await agent.initialise()
        answer = await agent.chat("What documents are currently indexed?")
        print("\n[Smoke] Agent reply:", answer)

    asyncio.run(_smoke_test())