"""
core/llm.py
-----------
Initialises the Groq LLM (llama-index-llms-groq) and the shared RAG prompt.

Groq provides OpenAI-compatible inference for open-weight models
(LLaMA-3, Mixtral, Gemma …) with very low latency — ideal for an i3 host
that cannot run a local GPU model.
"""

import asyncio
import sys
import os
from typing import Optional

from llama_index.llms.groq import Groq
from llama_index.core.llms import ChatMessage, MessageRole
from llama_index.core.prompts import ChatPromptTemplate
from llama_index.core import Settings

from config import settings   # single source of truth


# ---------------------------------------------------------------------------
# LLM factory
# ---------------------------------------------------------------------------

def get_llm(
    temperature: float = 0.0,
    max_tokens: int = 2048,
    model: Optional[str] = None,
) -> Groq:
    """
    Returns a fully configured Groq LLM instance and registers it as
    Settings.llm so every LlamaIndex engine uses the same object.

    Args:
        temperature : Sampling temperature (0.0 = deterministic / best for RAG).
        max_tokens  : Hard cap on output tokens. Capped at 2048 by default to
                      keep responses bounded during RAG/tool calls.
        model       : Override settings.LLM_MODEL for this call only.

    Returns:
        Groq instance already registered as Settings.llm.
    """
    llm = Groq(
        model=model or settings.LLM_MODEL,
        api_key=settings.GROQ_API_KEY,
        temperature=temperature,
        max_tokens=max_tokens,
    )

    # Register globally so every LlamaIndex engine uses the same instance.
    Settings.llm = llm
    return llm


# ---------------------------------------------------------------------------
# RAG prompt template
# ---------------------------------------------------------------------------

_RAG_SYSTEM_PROMPT = """\
You are an expert research assistant with access to a hybrid knowledge base \
(vector similarity search + structured SQL data).

## Instructions
- Answer the user's question using ONLY the context provided below.
- If the context is insufficient, say so clearly — do not hallucinate.
- Cite your sources using the document title / section_header from metadata.
- For numerical or tabular data, prefer the SQL results over the vector context.
- Be concise but thorough. Use markdown formatting where it aids clarity.

## Context
### Vector / Document Context
{vector_context}

### Structured / SQL Context
{sql_context}
"""


def get_rag_prompt() -> ChatPromptTemplate:
    """
    Returns a LlamaIndex ChatPromptTemplate with slots for:
        {vector_context}  – retrieved document chunks (str)
        {sql_context}     – SQL query results (str)
        {question}        – the user's query (str)
    """
    return ChatPromptTemplate(
        [
            ChatMessage(role=MessageRole.SYSTEM, content=_RAG_SYSTEM_PROMPT),
            ChatMessage(role=MessageRole.USER,   content="{question}"),
        ]
    )


# ---------------------------------------------------------------------------
# Async warm-up helper
# ---------------------------------------------------------------------------

async def warmup_llm(llm: Groq) -> bool:
    """
    Pings the Groq API with a minimal prompt to validate credentials and
    warm the connection before the first real request pays the cold-start cost.

    Returns True on success, False on failure (never raises).
    """
    try:
        response = await llm.acomplete("Respond with the single word: ready")
        print(f"[LLM] Warmup OK — model replied: {response.text.strip()!r}")
        return True
    except Exception as exc:
        print(f"[LLM] Warmup FAILED: {exc}")
        return False


# ---------------------------------------------------------------------------
# Standalone smoke-test
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    async def _smoke_test():
        print(f"[LLM] Testing model: {settings.LLM_MODEL}")
        llm = get_llm()

        prompt = get_rag_prompt()
        formatted = prompt.format(
            vector_context="The project is named AdvRag.",
            sql_context="Hardware: Intel i3, 12 GB RAM.",
            question="What is the project name and what hardware does it run on?",
        )

        result = await llm.acomplete(formatted)
        print("\n--- Response ---\n", result.text)

    asyncio.run(_smoke_test())
