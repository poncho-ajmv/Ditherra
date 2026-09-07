"""
Ditherra — local file storage.

Everything lives under `output/` and `references/` next to this file.
`resolve()` is the only trust boundary: paths are built from user-supplied
prompts and ids, so it refuses anything that escapes BASE_DIR.
"""

import io
import os
from pathlib import Path

# Where the app's data lives: output/, references/ and ditherra.db. Defaults to
# the repo itself, which is what a local run wants. DITHERRA_DATA moves the lot
# somewhere else — a mounted volume in a container, a tmpdir under test. One
# knob, one answer to "where is my data", and server.py derives DB_PATH from it.
BASE_DIR = Path(os.getenv("DITHERRA_DATA") or Path(__file__).parent).resolve()
(BASE_DIR / "output").mkdir(parents=True, exist_ok=True)
(BASE_DIR / "references").mkdir(parents=True, exist_ok=True)


def resolve(path: str) -> Path:
    """Resolve `path` under BASE_DIR. Raises ValueError if it escapes the root."""
    full = (BASE_DIR / path).resolve()
    if not full.is_relative_to(BASE_DIR):
        raise ValueError(f"path escapes storage root: {path!r}")
    return full


def save_file(path: str, data: bytes) -> None:
    """Save bytes. path like 'output/gen_1_16x16.png' or 'references/ref_xxx.png'."""
    # ponytail: no retention policy, output/ grows forever. Add a sweep when it
    # actually bothers you — deleting a generation already removes its files.
    full = resolve(path)
    full.parent.mkdir(parents=True, exist_ok=True)
    full.write_bytes(data)


def read_file(path: str) -> bytes | None:
    """Read a file. Returns None if missing or outside the storage root."""
    try:
        full = resolve(path)
    except ValueError:
        return None
    return full.read_bytes() if full.is_file() else None


def save_image(img, path: str) -> None:
    """Save a PIL Image as PNG."""
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    save_file(path, buf.getvalue())


def file_exists(path: str) -> bool:
    try:
        return resolve(path).is_file()
    except ValueError:
        return False


if __name__ == "__main__":
    assert resolve("output/a.png") == BASE_DIR / "output" / "a.png"
    assert resolve("output/tilesets/Dirt/Dirt_00.png").parent.name == "Dirt"
    for bad in ("../evil.png", "output/../../evil.png", "/etc/passwd", "output/../../../tmp/x"):
        try:
            resolve(bad)
            raise AssertionError(f"traversal not caught: {bad}")
        except ValueError:
            pass
    assert read_file("../evil.png") is None
    assert file_exists("../evil.png") is False
    assert read_file("output/does-not-exist.png") is None
    print("storage self-check OK")
