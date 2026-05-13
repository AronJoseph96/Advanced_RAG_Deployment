"""
Console logging helpers for RAG tool calls.

These wrappers keep the underlying LlamaIndex query engines unchanged while
printing retrieved context/results to the terminal during normal app runs.
"""

from __future__ import annotations

from functools import wraps
from typing import Any


MAX_TEXT_CHARS = 1200


def _shorten(value: Any, limit: int = MAX_TEXT_CHARS) -> str:
    text = str(value).replace("\r\n", "\n").strip()
    if len(text) <= limit:
        return text
    return f"{text[:limit]}... [truncated {len(text) - limit} chars]"


def _node_text(node: Any) -> str:
    if hasattr(node, "get_content"):
        return node.get_content(metadata_mode="none")
    if hasattr(node, "text"):
        return node.text
    return str(node)


def print_query_response(label: str, question: Any, response: Any) -> None:
    print(f"\n[{label}] Query")
    print(_shorten(question, 500))

    metadata = getattr(response, "metadata", None) or {}
    if metadata:
        sql_query = metadata.get("sql_query")
        if sql_query:
            print(f"[{label}] SQL")
            print(_shorten(sql_query))

        result = metadata.get("result")
        if result is not None:
            print(f"[{label}] Result rows")
            print(_shorten(result))

        remaining = {
            key: value
            for key, value in metadata.items()
            if key not in {"sql_query", "result"}
        }
        if remaining:
            print(f"[{label}] Metadata")
            print(_shorten(remaining))

    source_nodes = getattr(response, "source_nodes", None) or []
    if source_nodes:
        print(f"[{label}] Retrieved nodes ({len(source_nodes)})")
        for idx, source_node in enumerate(source_nodes, start=1):
            node = getattr(source_node, "node", source_node)
            score = getattr(source_node, "score", None)
            node_metadata = getattr(node, "metadata", {}) or {}

            score_text = f", score={score:.4f}" if isinstance(score, float) else ""
            print(f"[{label}] Node {idx}{score_text}")
            if node_metadata:
                print(f"[{label}] Node {idx} metadata: {_shorten(node_metadata, 500)}")
            print(_shorten(_node_text(node)))
    elif not metadata:
        print(f"[{label}] Response")
        print(_shorten(response))

    if metadata:
        print(f"[{label}] Response")
        print(_shorten(response))


def enable_query_logging(query_engine: Any, label: str) -> Any:
    """
    Adds console logging to a query engine and returns the same object.

    QueryEngineTool still receives the original LlamaIndex query engine type,
    so frontend/API responses continue to work exactly as before.
    """
    if getattr(query_engine, "_retrieval_logging_enabled", False):
        return query_engine

    original_query = query_engine.query
    original_aquery = query_engine.aquery

    @wraps(original_query)
    def logged_query(question: Any, *args: Any, **kwargs: Any) -> Any:
        response = original_query(question, *args, **kwargs)
        print_query_response(label, question, response)
        return response

    @wraps(original_aquery)
    async def logged_aquery(question: Any, *args: Any, **kwargs: Any) -> Any:
        response = await original_aquery(question, *args, **kwargs)
        print_query_response(label, question, response)
        return response

    object.__setattr__(query_engine, "query", logged_query)
    object.__setattr__(query_engine, "aquery", logged_aquery)
    object.__setattr__(query_engine, "_retrieval_logging_enabled", True)
    return query_engine
