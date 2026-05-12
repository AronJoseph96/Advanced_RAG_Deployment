"""
test_pipeline.py
----------------
Drop this in AdvRag/ (next to pyproject.toml) and run:

    python test_pipeline.py

It wires loader.py → transformation.py against your real DOCX file,
so you can verify the pipeline actually reads YOUR document, not the
hardcoded smoke-test text inside transformation.py's __main__ block.
"""

import asyncio
import sys
from pathlib import Path

# ── Make sure the src/ package is on sys.path ──────────────────────────────
SRC = Path(__file__).resolve().parent / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from core.llm import get_llm
from data_pipeline.loader import aload_documents_from_directory
from data_pipeline.transformation import arun_pipeline


# ── Config ──────────────────────────────────────────────────────────────────
DOCS_DIR   = Path(__file__).resolve().parent / "data" / "docs"
CACHE_DIR  = Path(__file__).resolve().parent / "storage" / "pipeline_cache_test"

# Set False to skip LLM metadata extraction (faster, no Groq calls).
# Set True  to get Title / Summary / Keywords / Questions per node.
USE_METADATA = True


async def main():
    print(f"\n{'='*60}")
    print(f"  Pipeline test")
    print(f"  Docs dir : {DOCS_DIR}")
    print(f"  Metadata : {'ON' if USE_METADATA else 'OFF (fast mode)'}")
    print(f"{'='*60}\n")

    # 1. LLM must be set before any extractor is instantiated
    get_llm()

    # 2. Load raw documents from the real directory
    print(f"[Test] Loading documents from: {DOCS_DIR}")
    docs = await aload_documents_from_directory(DOCS_DIR)

    if not docs:
        print("\n[Test] ❌  No supported files found in data/docs/")
        print("       Check the directory path and make sure the DOCX is there.")
        return

    print(f"\n[Test] ✅  Loaded {len(docs)} document(s):\n")
    for d in docs:
        print(f"  • {d.metadata.get('file_name')} "
              f"| type={d.metadata.get('file_type')} "
              f"| header={d.metadata.get('section_header')!r}")
        print(f"    first 120 chars: {d.get_content()[:120]!r}")

    # 3. Run through IngestionPipeline
    print(f"\n[Test] Running IngestionPipeline …")
    nodes = await arun_pipeline(
        docs,
        use_metadata_extractors=USE_METADATA,
        cache_dir=str(CACHE_DIR),
    )

    print(f"\n[Test] ✅  Pipeline produced {len(nodes)} nodes.\n")

    # 4. Show first 3 nodes
    for i, node in enumerate(nodes[:3]):
        m = node.metadata
        print(f"--- Node {i} ---")
        print(f"  file_name : {m.get('file_name')}")
        print(f"  Title     : {m.get('document_title', '(not extracted)')}")
        print(f"  Summary   : {m.get('section_summary', '(not extracted)')[:120]}")
        print(f"  Keywords  : {m.get('excerpt_keywords', '(not extracted)')[:80]}")
        print(f"  Content   : {node.get_content()[:150]!r}")
        print()


if __name__ == "__main__":
    asyncio.run(main())