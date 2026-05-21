"""
storage/sql_store.py
--------------------
SQLite-backed structured data store for the Agentic RAG system using LlamaIndex.

Uses LlamaIndex's NLSQLTableQueryEngine to convert natural-language questions
into SQL queries automatically. The resulting QueryEngineTool is handed to
the FunctionCallingAgent so it can query structured data on demand.

Fixes vs original
-----------------
1. _init_db() reads the actual table list via sqlalchemy inspect() and passes
   include_tables= explicitly to SQLDatabase — avoids silent "no tables" errors.
2. NLSQLTableQueryEngine now receives tables= so the LLM always knows which
   tables exist (accepted parameter confirmed against llama-index-core 0.14.21).
3. _rebuild() is the single entry-point that re-creates engine → db → query
   engine in the correct order after every CSV upload.
4. get_tool() uses the cached self._query_engine (already logging-wrapped) and
   no longer calls _get_query_engine() a second time — fixes double-wrap bug.
5. Tool description injects live schema (table + column names) so the ReAct
   agent routes any CSV question here regardless of the file's subject matter.
"""

import re
import asyncio
from pathlib import Path
from typing import Optional, List

import pandas as pd
from dotenv import load_dotenv

from llama_index.core import SQLDatabase
from llama_index.core.query_engine import NLSQLTableQueryEngine
from llama_index.core.tools import QueryEngineTool, ToolMetadata
from sqlalchemy import create_engine, inspect, text as sa_text

from config import settings
from utils.retrieval_logging import enable_query_logging

load_dotenv()

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

DEFAULT_DB_PATH: str = settings.SQLITE_DB_PATH


# ---------------------------------------------------------------------------
# CSV → SQLite loader (synchronous)
# ---------------------------------------------------------------------------

def load_csv_to_sqlite(
    csv_path: str | Path,
    db_path: str = DEFAULT_DB_PATH,
    table_name: Optional[str] = None,
    if_exists: str = "replace",
) -> str:
    """
    Reads a CSV file into a pandas DataFrame and writes it as a SQLite table.

    Column names are sanitised to valid SQL identifiers.

    Args:
        csv_path:   Path to the CSV file.
        db_path:    Path to the SQLite database file (created if absent).
        table_name: Target table name; defaults to the sanitised CSV stem.
        if_exists:  Pandas behaviour when the table exists: "replace" | "append" | "fail".

    Returns:
        The table name used.
    """
    csv_path   = Path(csv_path)
    table_name = table_name or re.sub(r"[^a-zA-Z0-9_]", "_", csv_path.stem)
    db_path    = Path(db_path)
    db_path.parent.mkdir(parents=True, exist_ok=True)

    df = pd.read_csv(csv_path)
    # Sanitise column names → valid SQL identifiers
    df.columns = [re.sub(r"[^a-zA-Z0-9_]", "_", c).strip("_") for c in df.columns]

    engine = create_engine(f"sqlite:///{db_path}")
    df.to_sql(table_name, engine, if_exists=if_exists, index=False)

    print(f"[SQLStore] Loaded '{csv_path.name}' → table '{table_name}' "
          f"({len(df)} rows, columns: {list(df.columns)})")
    return table_name


# ---------------------------------------------------------------------------
# Schema helpers
# ---------------------------------------------------------------------------

def _get_table_names(engine) -> List[str]:
    """Returns all table names currently in the SQLite database."""
    return inspect(engine).get_table_names()


def _build_schema_description(engine, table_names: List[str]) -> str:
    """
    Returns a plain-English schema string injected into the tool description.

    Example output:
        Table 'fruits': columns Name (TEXT), Color (TEXT), Weight (REAL) |
        Table 'sales': columns product (TEXT), revenue (REAL), quarter (TEXT)

    This lets the LLM know column names without having to query the DB first,
    which is what caused wrong/empty SQL on the first question after upload.
    """
    parts = []
    with engine.connect() as conn:
        for tbl in table_names:
            rows = conn.execute(sa_text(f'PRAGMA table_info("{tbl}")')).fetchall()
            cols = ", ".join(f"{r[1]} ({r[2]})" for r in rows)
            parts.append(f"Table '{tbl}': columns {cols}")
    return " | ".join(parts) if parts else ""


# ---------------------------------------------------------------------------
# SQLStoreManager
# ---------------------------------------------------------------------------

class SQLStoreManager:
    """
    Manages a SQLite database and exposes a LlamaIndex QueryEngineTool.

    The NLSQLTableQueryEngine handles the full Text-to-SQL pipeline:
      1. Inspects the database schema.
      2. Asks the LLM to write a SQL query for the user's question.
      3. Executes the query.
      4. Synthesises a natural-language answer from the results.
    """

    def __init__(
        self,
        llm=None,
        db_path: str = DEFAULT_DB_PATH,
    ):
        self.db_path         = db_path
        self.llm             = llm
        self._engine         = None   # SQLAlchemy engine (kept open)
        self._db:            Optional[SQLDatabase]           = None
        self._query_engine:  Optional[NLSQLTableQueryEngine] = None
        self._table_names:   List[str]                       = []

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _init_db(self) -> None:
        """
        (Re-)creates the SQLAlchemy engine and LlamaIndex SQLDatabase.

        Reads the real table list from the DB every time so include_tables
        is always accurate — even after a flush or a fresh CSV upload.
        """
        db_path = Path(self.db_path)
        db_path.parent.mkdir(parents=True, exist_ok=True)

        self._engine      = create_engine(f"sqlite:///{db_path}")
        self._table_names = _get_table_names(self._engine)

        if self._table_names:
            # include_tables= is mandatory — without it SQLDatabase may silently
            # discover no tables on a freshly written DB due to cache timing.
            self._db = SQLDatabase(
                self._engine,
                include_tables=self._table_names,
            )
            print(f"[SQLStore] DB ready — tables: {self._table_names}")
        else:
            self._db = None
            print("[SQLStore] DB ready — no tables yet.")

    def _build_query_engine(self) -> Optional[NLSQLTableQueryEngine]:
        """
        Builds a fresh NLSQLTableQueryEngine against the current schema.
        Returns None when no tables exist yet.
        """
        if self._db is None:
            return None

        return NLSQLTableQueryEngine(
            sql_database=self._db,
            llm=self.llm,
            # tables= tells the engine exactly which tables to consider;
            # confirmed valid param in llama-index-core 0.14.21
            tables=self._table_names,
            verbose=False,
        )

    def _rebuild(self) -> None:
        """
        Full rebuild sequence: engine → SQLDatabase → query engine → logging wrapper.
        Called after every CSV upload and on first use if not yet initialised.
        """
        self._init_db()
        raw_engine = self._build_query_engine()
        if raw_engine is not None:
            # Wrap once with logging; stored in self._query_engine so get_tool()
            # reuses the same wrapped object without double-wrapping.
            self._query_engine = enable_query_logging(raw_engine, "SQLite")
        else:
            self._query_engine = None

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def aload_csv(
        self,
        csv_path: str | Path,
        table_name: Optional[str] = None,
        if_exists: str = "replace",
    ) -> str:
        """
        Async wrapper for load_csv_to_sqlite.
        Always does a full _rebuild() after the upload so the new table
        (with its columns) is immediately visible to the query engine.
        """
        loop = asyncio.get_running_loop()
        name = await loop.run_in_executor(
            None, load_csv_to_sqlite, csv_path, self.db_path, table_name, if_exists
        )
        self._rebuild()
        return name

    async def aquery(self, question: str) -> str:
        """Executes a natural-language query against the SQL database."""
        if self._query_engine is None:
            self._rebuild()
        if self._query_engine is None:
            return "No structured data has been uploaded yet. Please upload a CSV file first."
        response = await self._query_engine.aquery(question)
        return str(response)

    def get_tool(self) -> QueryEngineTool:
        """
        Returns a QueryEngineTool for the ReAct agent.

        Uses self._query_engine (already logging-wrapped from _rebuild) directly —
        does NOT call _build_query_engine() again to avoid creating a second
        unwrapped engine and double-wrapping it with logging.

        The tool description includes the live schema so the LLM can route
        any CSV question here without needing to know the file subject matter.
        """
        if self._query_engine is None:
            self._rebuild()

        # Build schema hint from live DB (works for any CSV, any column names)
        schema_hint = ""
        if self._engine and self._table_names:
            try:
                schema_hint = "\nLoaded data — " + _build_schema_description(
                    self._engine, self._table_names
                )
            except Exception:
                pass

        description = (
            "Query structured tabular data that was uploaded as a CSV file. "
            "Use this tool for any question about rows, column values, filters, "
            "counts, sums, averages, min/max, rankings, or grouping over the "
            "uploaded dataset — regardless of what the data is about. "
            "Examples: 'list names where color is red', "
            "'how many orders have status Pending', "
            "'average salary by department', "
            "'which employee joined most recently'. "
            "Input: a plain-English question about the data."
            f"{schema_hint}"
        )

        # Guard: if _rebuild produced no engine (no tables yet), return a
        # no-op tool that explains the situation clearly.
        if self._query_engine is None:
            from llama_index.core.query_engine import CustomQueryEngine
            from llama_index.core.base.response.schema import Response

            class _NoDataEngine(CustomQueryEngine):
                def custom_query(self, query_str: str) -> Response:
                    return Response("No CSV data has been uploaded yet.")
                async def acustom_query(self, query_str: str) -> Response:
                    return Response("No CSV data has been uploaded yet.")

            return QueryEngineTool(
                query_engine=_NoDataEngine(),
                metadata=ToolMetadata(
                    name="structured_data_analytics",
                    return_direct=True,
                    description=description,
                ),
            )

        return QueryEngineTool(
            query_engine=self._query_engine,   # reuse cached logged engine
            metadata=ToolMetadata(
                name="structured_data_analytics",
                return_direct=True,
                description=description,
            ),
        )


# ---------------------------------------------------------------------------
# Standalone smoke-test  (works with any two CSV schemas)
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import tempfile, csv as csv_mod

    async def _smoke_test():
        from core.llm import get_llm

        with tempfile.TemporaryDirectory() as tmp:
            # CSV 1 — fruits (colour + weight)
            p1 = Path(tmp) / "fruits.csv"
            p1.write_text("Name,Color,Weight,Sweetness\n"
                          "Apple,Red,150,7\nBanana,Yellow,120,6\n"
                          "Cherry,Red,10,8\nDate,Brown,7,5\n"
                          "Orange,Orange,140,7\nPear,Green,190,5\n")

            # CSV 2 — sales (totally different schema)
            p2 = Path(tmp) / "sales.csv"
            p2.write_text("product,quarter,revenue\n"
                          "Widget A,Q1,15000\nWidget B,Q1,9000\n"
                          "Widget A,Q2,18000\nWidget B,Q2,12000\n")

            manager = SQLStoreManager(llm=get_llm(), db_path=f"{tmp}/test.db")

            await manager.aload_csv(p1)
            await manager.aload_csv(p2)

            for q in [
                "names of fruits with red color",
                "heaviest fruit",
                "total revenue for Widget A",
                "which quarter had the highest revenue for Widget B",
            ]:
                ans = await manager.aquery(q)
                print(f"\nQ: {q}\nA: {ans}")

    asyncio.run(_smoke_test())