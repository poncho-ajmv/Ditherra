"""
Test setup. Two jobs, both of which have to happen before `import server`.

1. Put the repo root on sys.path, so tests in this folder can import the app
   modules that live one level up.
2. Point DITHERRA_DATA at a throwaway directory. server.py runs init_db() at
   import time and storage.py mkdirs output/ and references/ at import time,
   so by the time a test body runs it is already too late to redirect them.
   Without this the suite wrote into the real ditherra.db and left a file in
   references/ on every run.
"""

import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

# Not tmp_path: that fixture is per-test, and this has to be set once, before
# the first import. The directory is left for the OS to reap.
os.environ.setdefault("DITHERRA_DATA", tempfile.mkdtemp(prefix="ditherra-test-"))

# Keys must never leak in from the developer's own machine — several tests
# assert on which providers are configured, and a real key in the environment
# would silently change the answer.
for _var in ("GEMINI_API_KEY", "GOOGLE_API_KEY", "OPENAI_API_KEY",
             "GROQ_API_KEY", "DEEPSEEK_API_KEY", "OPENROUTER_API_KEY",
             "GOOGLE_SERVICE_ACCOUNT_JSON", "GOOGLE_SERVICE_ACCOUNT_JSON_CONTENT"):
    os.environ.pop(_var, None)
