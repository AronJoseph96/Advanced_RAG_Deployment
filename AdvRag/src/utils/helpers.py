"""
utils/helpers.py
----------------
Two utilities that extend the base ingestion pipeline:

1. LlamaParse integration  — layout-aware parsing for PDFs and DOCX that
   preserves tables, headings, and column structure that PyMuPDF misses.

2. Structured data helpers — loads CSV / XLSX into a pandas DataFrame and
   wraps it in a LlamaIndex PandasQueryEngine so the agent can answer
   natural-language questions against tabular data using Python code execution
   (not Text-to-SQL, which means no SQLite schema required).

When to use which
-----------------
* PDF / DOCX with complex layouts, tables, multi-column text → LlamaParse
* Simple PDFs / markdown / plain text → PyMuPDFReader (loader.py, faster)
* Structured tabular data (CSV, XLSX) → build_pandas_query_engine (this file)
* Structured data that is already in SQLite → SQLStoreManager (sql_store.py)
"""

import asyncio
import re
import os
from pathlib import Path
from typing import List, Optional

import pandas as pd

from llama_index.core import Document, Settings
from llama_index.core.query_engine import PandasQueryEngine
from llama_index.core.tools import QueryEngineTool, ToolMetadata

from config import settings   # single, correct import


# ---------------------------------------------------------------------------
# 1. LlamaParse — layout-aware document parsing
# ---------------------------------------------------------------------------

def _check_llama_cloud_key() -> bool:
    """Returns True if a LlamaCloud API key is configured."""
    return bool(settings.LLAMA_CLOUD_API_KEY)


async def aparse_with_llamaparse(
    file_paths: List[str | Path],
    result_type: str = "markdown",
    language: str = "en",
) -> List[Document]:
    """
    Parses PDF and DOCX files via the LlamaParse cloud API.

    LlamaParse understands document layout — it correctly extracts:
      • Multi-column text (common in academic papers)
      • Tables (converted to markdown table format)
      • Headings and section structure
      • Figures / image captions (as alt-text)

    Falls back gracefully (warning + empty list) if LLAMA_CLOUD_API_KEY is
    not set, so the rest of the pipeline (PyMuPDFReader path) continues.

    Args:
        file_paths:  List of absolute or relative paths to PDF / DOCX files.
        result_type: "markdown" (default) or "text".
        language:    ISO 639-1 language code for OCR hinting (default "en").

    Returns:
        Flat list of LlamaIndex Document objects, one per file.
    """
    if not _check_llama_cloud_key():
        print(
            "[LlamaParse] LLAMA_CLOUD_API_KEY not set — skipping LlamaParse. "
            "Add the key to .env or use PyMuPDFReader instead."
        )
        return []

    try:
        from llama_parse import LlamaParse
    except ImportError:
        raise ImportError(
            "llama-parse is not installed. Run: pip install llama-parse"
        )

    parser = LlamaParse(
        api_key=settings.LLAMA_CLOUD_API_KEY,
        result_type=result_type,
        language=language,
        verbose=False,
    )

    all_documents: List[Document] = []

    for path in file_paths:
        path = Path(path)
        if not path.exists():
            print(f"[LlamaParse] File not found, skipping: {path}")
            continue

        suffix = path.suffix.lower()
        if suffix not in {".pdf", ".docx", ".doc"}:
            print(f"[LlamaParse] Unsupported type '{suffix}', skipping: {path.name}")
            continue

        print(f"[LlamaParse] Parsing: {path.name} …")
        try:
            # load_data is synchronous — offload to thread pool
            loop = asyncio.get_running_loop()
            docs = await loop.run_in_executor(None, parser.load_data, str(path))

            for doc in docs:
                doc.metadata.update({
                    "file_name": path.name,
                    "file_path": str(path),
                    "file_type": suffix.lstrip("."),
                    "parser":    "llamaparse",
                })

            all_documents.extend(docs)
            print(f"[LlamaParse] → {len(docs)} document(s) from '{path.name}'")

        except Exception as exc:
            print(f"[LlamaParse] ERROR parsing '{path.name}': {exc}")

    return all_documents


# ---------------------------------------------------------------------------
# 2. Structured data — CSV / XLSX → PandasQueryEngine
# ---------------------------------------------------------------------------

def load_dataframe(file_path: str | Path) -> pd.DataFrame:
    """
    Loads a CSV or XLSX file into a pandas DataFrame.

    Column names are sanitised (spaces → underscores, stripped of leading/
    trailing underscores) so PandasQueryEngine's code-gen produces valid
    Python identifiers.

    Raises:
        ValueError:       If the file extension is not supported.
        FileNotFoundError: If the file does not exist.
    """
    path = Path(file_path)
    if not path.exists():
        raise FileNotFoundError(f"Structured data file not found: {path}")

    suffix = path.suffix.lower()
    if suffix == ".csv":
        df = pd.read_csv(path)
    elif suffix in {".xlsx", ".xls"}:
        df = pd.read_excel(path)
    else:
        raise ValueError(
            f"Unsupported structured data format: '{suffix}'. "
            "Supported: .csv, .xlsx, .xls"
        )

    df.columns = [
        re.sub(r"[^a-zA-Z0-9_]", "_", c).strip("_")
        for c in df.columns
    ]

    print(
        f"[Helpers] Loaded '{path.name}' — "
        f"{len(df)} rows × {len(df.columns)} cols"
    )
    return df


def build_pandas_query_engine(
    file_path: str | Path,
    df: Optional[pd.DataFrame] = None,
    tool_name: Optional[str] = None,
    tool_description: Optional[str] = None,
) -> QueryEngineTool:
    """
    Wraps a CSV / XLSX file (or an already-loaded DataFrame) in a
    PandasQueryEngine and returns it as a LlamaIndex QueryEngineTool
    for use by the FunctionCallingAgent.

    PandasQueryEngine asks the LLM to write a pandas expression and then
    executes it in a sandboxed Python environment. More flexible than
    Text-to-SQL for ad-hoc tabular analysis.

    Args:
        file_path:        Path to the CSV / XLSX file.
        df:               Optional pre-loaded DataFrame.
        tool_name:        Override the tool name the agent sees.
        tool_description: Override the tool description.

    Returns:
        A QueryEngineTool the agent can call with a plain-English question.
    """
    path = Path(file_path)

    if df is None:
        df = load_dataframe(path)

    if Settings.llm is None:
        raise RuntimeError(
            "Settings.llm is not set. Call get_llm() before build_pandas_query_engine()."
        )

    engine = PandasQueryEngine(
        df=df,
        llm=Settings.llm,
        verbose=False,
        synthesize_response=True,   # narrate result in plain English
    )

    safe_stem   = path.stem.replace(" ", "_").replace("-", "_")
    name        = tool_name or f"tabular_{safe_stem}"
    description = tool_description or (
        f"Use this tool to answer questions about the structured tabular data "
        f"in '{path.name}'. Ideal for counts, sums, averages, filters, and "
        f"comparisons across rows and columns. "
        f"Columns: {', '.join(df.columns.tolist())}. "
        f"Input should be a plain-English question."
    )

    return QueryEngineTool(
        query_engine=engine,
        metadata=ToolMetadata(name=name, description=description),
    )


async def abuild_pandas_tools_from_directory(
    directory: str | Path,
) -> List[QueryEngineTool]:
    """
    Scans a directory for CSV and XLSX files and returns one
    PandasQueryEngine tool per file.

    Args:
        directory: Path to a directory containing .csv / .xlsx files.

    Returns:
        List of QueryEngineTool objects, one per structured data file.
    """
    directory = Path(directory)
    tools: List[QueryEngineTool] = []

    for file_path in sorted(directory.rglob("*")):
        if file_path.suffix.lower() not in {".csv", ".xlsx", ".xls"}:
            continue

        print(f"[Helpers] Building Pandas tool for: {file_path.name}")
        try:
            loop = asyncio.get_running_loop()
            df   = await loop.run_in_executor(None, load_dataframe, file_path)
            tool = build_pandas_query_engine(file_path, df=df)
            tools.append(tool)
        except Exception as exc:
            print(f"[Helpers] ERROR loading '{file_path.name}': {exc}")

    print(f"[Helpers] Registered {len(tools)} Pandas tool(s).")
    return tools


# ---------------------------------------------------------------------------
# Standalone smoke-test
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import tempfile
    import csv

    async def _smoke_test():
        from core.llm import get_llm
        get_llm()  # sets Settings.llm (Groq)

        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".csv", delete=False, newline=""
        ) as f:
            writer = csv.writer(f)
            writer.writerow(["product", "quarter", "revenue"])
            writer.writerow(["Widget A", "Q1", 15000])
            writer.writerow(["Widget B", "Q1", 9000])
            writer.writerow(["Widget A", "Q2", 18000])
            csv_path = f.name

        tool     = build_pandas_query_engine(csv_path)
        response = await tool.query_engine.aquery("What is the total revenue for Widget A?")
        print(f"\n[PandasTool] Answer: {response}")

        if _check_llama_cloud_key():
            print("\n[LlamaParse] Key found — skipping live call in smoke-test.")
        else:
            print("\n[LlamaParse] No LLAMA_CLOUD_API_KEY — skipping LlamaParse test.")

    asyncio.run(_smoke_test())