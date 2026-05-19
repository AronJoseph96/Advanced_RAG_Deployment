"""
storage/sql_store.py
--------------------
SQLite-backed structured data store for the Agentic RAG system using LlamaIndex.

Uses LlamaIndex's NLSQLTableQueryEngine to convert natural-language questions
into SQL queries automatically. The resulting QueryEngineTool is handed to
the FunctionCallingAgent so it can query structured data on demand.
"""

import re
import asyncio
from pathlib import Path
from typing import Optional

import pandas as pd
from dotenv import load_dotenv

from llama_index.core import SQLDatabase
from llama_index.core.query_engine import NLSQLTableQueryEngine
from llama_index.core.tools import QueryEngineTool, ToolMetadata
from sqlalchemy import create_engine

from config import settings   # single, correct import
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
    df.columns = [re.sub(r"[^a-zA-Z0-9_]", "_", c).strip("_") for c in df.columns]

    engine = create_engine(f"sqlite:///{db_path}")
    df.to_sql(table_name, engine, if_exists=if_exists, index=False)

    print(f"[SQLStore] Loaded '{csv_path.name}' → table '{table_name}'")
    return table_name


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
        llm=None,                        # defaults to Settings.llm if None
        db_path: str = DEFAULT_DB_PATH,
    ):
        self.db_path      = db_path
        self.llm          = llm
        self._db:          Optional[SQLDatabase]            = None
        self._query_engine: Optional[NLSQLTableQueryEngine] = None

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _init_db(self) -> None:
        """Initialises SQLAlchemy engine and LlamaIndex SQLDatabase wrapper."""
        db_path = Path(self.db_path)
        db_path.parent.mkdir(parents=True, exist_ok=True)

        engine   = create_engine(f"sqlite:///{db_path}")
        self._db = SQLDatabase(engine)

    def _get_query_engine(self) -> NLSQLTableQueryEngine:
        """Builds the NL-to-SQL Query Engine."""
        if self._db is None:
            self._init_db()
        return NLSQLTableQueryEngine(
            sql_database=self._db,
            llm=self.llm,
        )

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def aload_csv(
        self,
        csv_path: str | Path,
        table_name: Optional[str] = None,
        if_exists: str = "replace",
    ) -> str:
        """Async wrapper for load_csv_to_sqlite. Refreshes the query engine."""
        loop = asyncio.get_running_loop()
        name = await loop.run_in_executor(
            None, load_csv_to_sqlite, csv_path, self.db_path, table_name, if_exists
        )
        # Force refresh so the new table appears in the schema
        self._init_db()
        self._query_engine = None
        return name

    async def aquery(self, question: str) -> str:
        """Executes a natural-language query against the SQL database."""
        if self._query_engine is None:
            self._query_engine = self._get_query_engine()
        response = await self._query_engine.aquery(question)
        return str(response)

    def get_tool(self) -> QueryEngineTool:
        """
        Returns a LlamaIndex QueryEngineTool for the FunctionCallingAgent.
        """
        if self._query_engine is None:
            self._query_engine = self._get_query_engine()

        return QueryEngineTool(
            query_engine=enable_query_logging(self._query_engine, "SQLite"),
            metadata=ToolMetadata(
                name="structured_data_analytics",
                return_direct=True,
                description=(
                    "Use this tool only for uploaded structured tables or CSV-like "
                    "data. Ideal for counting, sums, averages, rankings, or finding "
                    "records in table columns. Do not use it for document text, "
                    "report sections, clauses, or requirement IDs. Input should be "
                    "a plain-English analytics question."
                ),
            ),
        )


# ---------------------------------------------------------------------------
# Standalone smoke-test
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import tempfile
    import csv

    async def _smoke_test():
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".csv", delete=False, newline=""
        ) as f:
            writer = csv.writer(f)
            writer.writerow(["candidate_name", "years_experience", "primary_skill"])
            writer.writerow(["Alice", 5, "Python"])
            writer.writerow(["Bob",   2, "Java"])
            csv_path = f.name

        from core.llm import get_llm
        manager = SQLStoreManager(llm=get_llm(), db_path="storage/smoke_test.db")
        await manager.aload_csv(csv_path, table_name="candidates")

        answer = await manager.aquery(
            "How many candidates have more than 3 years of experience?"
        )
        print("Answer:", answer)

    asyncio.run(_smoke_test())
