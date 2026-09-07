#!/usr/bin/env python3
"""
Ditherra — AI-powered pixel art generator with agent-based painting.

Generates sprites as palette-indexed 2D arrays via Gemini,
constructs images, and iterates through visual feedback loops.
"""

import os
import re
import json
import base64
import io
import uuid
import sqlite3
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from pydantic import BaseModel, field_validator

# Colors reach pixels_to_image as #RRGGBB and get sliced with int(h[1:3],16).
# Anything else ("red", "") raises ValueError deep in a request handler → 500.
# Validate once at the trust boundary instead.
_HEX = re.compile(r"^#[0-9a-fA-F]{6}$")

def _valid_hex(colors: list[str]) -> list[str]:
    bad = [c for c in colors if not _HEX.match(c)]
    if bad:
        raise ValueError(f"colors must be #RRGGBB hex; got {bad[:3]}")
    return colors

def _valid_name(v: str) -> str:
    if not re.fullmatch(r"[\w-]+", v):
        raise ValueError("name must be letters, numbers, _ or -")
    return v
from PIL import Image
from google import genai

import providers
import codex_app_server
import storage

# ── Config ──

load_dotenv()

# Exports GOOGLE_APPLICATION_CREDENTIALS if a service account is present.
providers.google_service_account()

# Models come from providers.json — see providers.py. Nothing hardcoded here.
# The DB sits with the rest of the data, wherever storage put it (DITHERRA_DATA).
DB_PATH = storage.BASE_DIR / "ditherra.db"

# ── Gemini Client ──

def get_client():
    """Gemini client for concept art. Three ways in, tried in this order:
    an API key (env or the settings panel), a service account, or the OAuth
    login that Antigravity / gemini-cli leaves in ~/.gemini/oauth_creds.json.

    That third one is why an Antigravity-only setup can now generate concept
    art — the agent had always read those credentials, this client hadn't, so
    signing in with Antigravity got you painting but never a reference image."""
    saved = providers._saved_keys()
    api_key = (os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY")
               or saved.get("GEMINI_API_KEY") or saved.get("GOOGLE_API_KEY"))
    if api_key:
        return genai.Client(api_key=api_key)

    project = providers.google_service_account()
    if project:
        return genai.Client(vertexai=True, project=project,
                            location=os.getenv("GOOGLE_CLOUD_LOCATION", "global"))

    creds = providers.gemini_oauth_credentials()
    if creds:
        return genai.Client(vertexai=True, credentials=creds,
                            project=providers.gemini_oauth_project(),
                            location=os.getenv("GOOGLE_CLOUD_LOCATION", "global"))

    raise RuntimeError("No Gemini credentials. Add a GEMINI_API_KEY in Settings, "
                       "sign in with Antigravity, or set GOOGLE_SERVICE_ACCOUNT_JSON.")


client = None

def gemini():
    global client
    if client is None:
        client = get_client()
    return client

# ── Database ──

def _has_column(conn, table: str, column: str) -> bool:
    """Check if a column exists in a SQLite table."""
    cols = conn.execute(f"PRAGMA table_info({table})").fetchall()
    return any(c[1] == column for c in cols)

def init_db():
    conn = sqlite3.connect(DB_PATH)
    # The generation worker writes while the UI reads. Without WAL the default
    # rollback journal blocks readers for the length of every write.
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("""
        CREATE TABLE IF NOT EXISTS palettes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            colors TEXT NOT NULL,
            created_at INTEGER DEFAULT (CAST(strftime('%s','now') AS INTEGER))
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS generations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            prompt TEXT NOT NULL,
            system_prompt TEXT,
            colors TEXT,
            size INTEGER NOT NULL,
            model TEXT,
            reference_id TEXT,
            sprite_type TEXT DEFAULT 'block',
            pixel_data TEXT,
            iterations INTEGER DEFAULT 0,
            status TEXT DEFAULT 'pending',
            image_path TEXT,
            created_at INTEGER DEFAULT (CAST(strftime('%s','now') AS INTEGER))
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS generation_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            generation_id INTEGER NOT NULL,
            step TEXT NOT NULL,
            message TEXT,
            created_at INTEGER DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
            FOREIGN KEY (generation_id) REFERENCES generations(id)
        )
    """)

    # Auto-migrate: add columns that may be missing from older DBs
    if not _has_column(conn, "generations", "colors"):
        conn.execute("ALTER TABLE generations ADD COLUMN colors TEXT")
    if not _has_column(conn, "generations", "sprite_type"):
        conn.execute("ALTER TABLE generations ADD COLUMN sprite_type TEXT DEFAULT 'block'")
    if not _has_column(conn, "generations", "reference_id"):
        conn.execute("ALTER TABLE generations ADD COLUMN reference_id TEXT")

    # Workers are in-memory threads, so nothing survives a restart. Any row still
    # claiming to be running is a job whose process is gone; leaving it alone
    # showed a spinner in the history that never resolved.
    stale = [r[0] for r in conn.execute(
        "SELECT id FROM generations WHERE status IN ('generating', 'pending')")]
    if stale:
        marks = ",".join("?" * len(stale))
        conn.execute(f"UPDATE generations SET status = 'error' WHERE id IN ({marks})", stale)
        conn.executemany(
            "INSERT INTO generation_logs (generation_id, step, message) VALUES (?, ?, ?)",
            [(i, "error", "Interrupted: the server restarted while this was running.")
             for i in stale],
        )
        print(f"[db] marked {len(stale)} interrupted generation(s) as failed")

    # Insert default palette if none exist
    if conn.execute("SELECT COUNT(*) FROM palettes").fetchone()[0] == 0:
        conn.execute(
            "INSERT INTO palettes (name, colors) VALUES (?, ?)",
            ("Default Earth", json.dumps([
                "#5C3317", "#7B4B2A", "#8B5E3C", "#A0704B",
                "#2D6B12", "#3D8B24", "#4CAF50", "#6ECF5C",
                "#505055", "#68686E", "#7C7C82", "#929298",
                "#C2A65A", "#D4BE6A", "#E8D47A", "#F0E090",
                "#8B6533", "#A67B44", "#C49555", "#D4A866",
                "#C84040", "#D46060", "#4AC8C8", "#80E0E0",
                "#D4A44E", "#E8BC60", "#FFFFFF", "#000000",
            ]))
        )
    conn.commit()
    conn.close()

init_db()

def get_db():
    # timeout: worker threads and request handlers write concurrently; without it
    # a collision raises "database is locked" instead of waiting for the lock.
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    return conn

# ── Image construction ──

def pixels_to_image(pixel_data: list[list[int]], palette: list[str], size: int) -> Image.Image:
    """Convert 2D array of palette indices to PIL Image."""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    for y, row in enumerate(pixel_data):
        for x, idx in enumerate(row):
            if idx < 0 or idx >= len(palette):
                continue  # transparent
            hex_color = palette[idx]
            r = int(hex_color[1:3], 16)
            g = int(hex_color[3:5], 16)
            b = int(hex_color[5:7], 16)
            img.putpixel((x, y), (r, g, b, 255))
    return img

def save_sprite(img: Image.Image, gen_id: int, size: int) -> str:
    """Write the sprite + its 512px preview. Returns the image_path stored in the DB.

    delete_generation and the UI thumbnail both derive the preview name from this
    one, so keep the two writes together.
    """
    filename = f"gen_{gen_id}_{size}x{size}.png"
    storage.save_image(img, f"output/{filename}")
    storage.save_image(img.resize((512, 512), Image.NEAREST), f"output/{filename.replace('.png', '_preview.png')}")
    return filename

def palette_of(gen) -> list[str]:
    """Palette snapshot stored with the generation, with a fallback for old rows."""
    return json.loads(gen["colors"]) if gen["colors"] else ["#c8a44e"]

from tiles import generate_autotile_variant, generate_tileset

# ── Phased generation pipeline ──

DEFAULT_SYSTEM_PROMPT = """You are a pixel art artist.
Style: warm, organic, hand-crafted pixel art. NOT flat or sterile.
Every pixel matters at this scale."""

from sprite_types import SPRITE_TYPES

def _image_via_google(model: str, prompt: str) -> bytes:
    """Concept art through the Google GenAI SDK (Gemini / Nano Banana)."""
    try:
        # response_modalities is required on Vertex and harmless on AI Studio,
        # but older SDK builds reject the argument outright.
        response = gemini().models.generate_content(
            model=model, contents=[prompt],
            config=genai.types.GenerateContentConfig(response_modalities=["Image", "Text"]),
        )
    except TypeError:
        response = gemini().models.generate_content(model=model, contents=[prompt])

    parts = list(getattr(response, "parts", None) or [])
    for c in getattr(response, "candidates", None) or []:
        if getattr(c, "content", None):
            parts.extend(c.content.parts or [])
    for part in parts:
        if getattr(part, "inline_data", None) is None:
            continue
        try:
            buf = io.BytesIO()
            part.as_image().save(buf, format="PNG")
            return buf.getvalue()
        except Exception:
            raw = part.inline_data.data
            return base64.b64decode(raw) if isinstance(raw, str) else raw
    raise RuntimeError("The model replied without an image.")


def _image_via_openai(p: dict, model: str, prompt: str) -> bytes:
    """Concept art through the OpenAI-compatible /images/generations endpoint.

    Deliberately generic rather than OpenAI-specific: it reads base_url and the
    key from the provider entry, so enabling any server that speaks this shape
    is one line of image_models in providers.json, with no code change here.
    """
    import urllib.request
    body = json.dumps({"model": model, "prompt": prompt, "n": 1, "size": "1024x1024"}).encode()
    req = urllib.request.Request(
        p["base_url"].rstrip("/") + "/images/generations",
        data=body,
        headers={"Content-Type": "application/json",
                 "Authorization": f"Bearer {providers.api_key(p) or 'not-needed'}"},
    )
    with urllib.request.urlopen(req, timeout=180) as r:
        data = json.load(r)
    first = (data.get("data") or [{}])[0]
    if first.get("b64_json"):
        return base64.b64decode(first["b64_json"])
    # A url-only response would mean a second fetch to whatever host the provider
    # names. Refuse rather than turn this endpoint into a fetcher of arbitrary URLs.
    raise RuntimeError("The provider returned an image URL instead of image data, "
                       "which this endpoint doesn't fetch. Use a model that returns b64_json.")


def _image_via_cloudflare(p: dict, model: str, prompt: str) -> bytes:
    """Concept art through Workers AI (FLUX.1 schnell on the free tier).

    Cloudflare's OpenAI-compatible surface covers chat and embeddings only, so
    this can't reuse the generic path: the model id goes in the URL and the PNG
    comes back base64 inside a result envelope.
    """
    import urllib.request
    account = providers.cloudflare_account()
    if not account:
        raise RuntimeError("Cloudflare needs CLOUDFLARE_ACCOUNT_ID as well as a token. "
                           "The account id is in your dashboard URL; put it in .env.")
    req = urllib.request.Request(
        f"{p['base_url'].rstrip('/')}/accounts/{account}/ai/run/{model}",
        data=json.dumps({"prompt": prompt, "steps": 4}).encode(),
        headers={"Content-Type": "application/json",
                 "Authorization": f"Bearer {providers.api_key(p)}"},
    )
    with urllib.request.urlopen(req, timeout=180) as r:
        data = json.load(r)
    b64 = (data.get("result") or {}).get("image") or data.get("image")
    if not b64:
        errs = "; ".join(e.get("message", "") for e in data.get("errors") or [])
        raise RuntimeError(errs or "Workers AI replied without an image.")
    return base64.b64decode(b64)


def explain_provider_error(raw: str, model: str | None = None) -> str:
    """One actionable sentence out of a provider's error blob.

    Google returns quota failures as ~40 lines of nested JSON. Dumping that into
    a 280px panel is not an error message, it's a wall — the one fact the user
    needs (this model isn't on your plan; pick a cheaper one) is buried in the
    middle of it. Anything unrecognised still falls through verbatim rather than
    being swallowed, so a new failure mode is never hidden.
    """
    m = f" ({model})" if model else ""
    if "RESOURCE_EXHAUSTED" in raw or "429" in raw:
        # "limit: 0" means the plan has no allowance at all for this model —
        # a different message from "you used up today's allowance".
        if "limit: 0" in raw:
            return (f"This model{m} isn't available on your current Gemini plan. "
                    "Pick Nano Banana 2 or 2 Lite, which the free tier does allow, "
                    "or enable billing on your key.")
        wait = re.search(r"retry in ([\d.]+)s", raw)
        when = f" Try again in about {int(float(wait.group(1))) + 1}s." if wait else ""
        return f"Gemini quota exceeded for this model{m}.{when} A lighter model may still work."
    if "PERMISSION_DENIED" in raw or "aiplatform.googleapis.com" in raw or "default-cli-project" in raw:
        return ("Vertex AI isn't enabled for this Google project. Add a GEMINI_API_KEY "
                "in Settings, which doesn't need a GCP project at all.")
    if "API key not valid" in raw or "API_KEY_INVALID" in raw or "UNAUTHENTICATED" in raw:
        return "Google rejected the credentials. Check the key in Settings."
    if "not found" in raw.lower() and "model" in raw.lower():
        return (f"Google doesn't know this model{m} any more — it was probably retired. "
                "Run `python providers.py` to see which declared models are still live.")
    return raw


def load_reference_b64(ref_id: str | None) -> str | None:
    """Load a reference image as base64, if it exists."""
    if not ref_id:
        return None
    data = storage.read_file(f"references/{ref_id}")
    if not data:
        return None
    return base64.b64encode(data).decode()

def sse_event(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"

# Real token usage for this process. reported=False until a provider actually
# returns usage_metadata — we never estimate.
# ponytail: process-global, resets on restart, no per-client isolation (single
# local user). Add a per-session key if this ever serves multiple clients at once.
_session_tokens = {"total": 0, "input": 0, "output": 0, "reported": False}

def _accumulate_usage(um: dict):
    _session_tokens["input"] += um.get("input_tokens") or 0
    _session_tokens["output"] += um.get("output_tokens") or 0
    _session_tokens["total"] += um.get("total_tokens") or 0
    _session_tokens["reported"] = True

# ponytail: in-memory cancel flags. Single process, one local user — resets on
# restart. Swap for Redis/DB if you ever run multiple workers or need durability.
_cancelled: set[int] = set()
# Generations with a live worker. A cancel for anything else is a no-op: STOP pressed
# just as the agent finished used to leave the id in _cancelled forever, and the next
# chat edit on that sprite then aborted on its first chunk with no explanation.
_running: set[int] = set()


def painted_pixels(canvas) -> list[list[int]] | None:
    """A copy of the canvas grid, or None if nothing was ever painted on it.

    Guards the error path: overwriting a sprite's pixel_data with an untouched
    grid (all -1) would erase the previous art instead of rescuing the new one.
    """
    px = getattr(canvas, "pixels", None)
    if not px or all(p == -1 for row in px for p in row):
        return None
    return [row[:] for row in px]


def _run_agent_sse(generation_id: int, message: str, is_continuation: bool = False,
                   colors: list[str] | None = None, quality: str = "normal",
                   step_ceiling: int | None = None):
    """Shared SSE generator for initial generation and chat continuation."""
    import threading
    import queue as queue_mod
    from agent import run_agent_stream as agent_run

    db = get_db()
    gen = db.execute("SELECT * FROM generations WHERE id = ?", (generation_id,)).fetchone()
    if not gen:
        db.close()
        yield sse_event("error", {"message": "Generation not found"})
        return

    palette = colors or palette_of(gen)
    size = gen["size"]
    model = gen["model"] or providers.default_model()
    if not model:
        db.close()
        yield sse_event("error", {"message": "Select an AI model before generating"})
        return
    sprite_type = gen["sprite_type"] or "block"
    system_prompt = gen["system_prompt"] or DEFAULT_SYSTEM_PROMPT
    ref_b64 = load_reference_b64(gen["reference_id"]) if not is_continuation else None

    if not is_continuation:
        # The old line named the size and the model and stopped there, which is
        # the half you can already see in the UI. What you cannot see is what
        # the model is being handed — how many tool schemas, whether it gets the
        # preview image, how many colours — and that is what explains a run that
        # goes nowhere. Cheap to say, and it is the first thing you want when
        # the next line never arrives.
        import agent as _agent
        q = _agent.QUALITY.get(quality, _agent.QUALITY["normal"])
        sees = providers.has_vision(model)
        n_tools = len(_agent.make_tools(_agent.Canvas(size, palette),
                                        vision=sees and q["preview"],
                                        full_toolset=sees,
                                        require_review=q["review"]))
        detail = (f"{size}x{size} · {quality} · {n_tools} tools · {len(palette)} colours"
                  f" · {'sees the canvas' if sees and q['preview'] else 'paints blind'}"
                  f"{' · with reference' if ref_b64 else ''}")
        db.execute("INSERT INTO generation_logs (generation_id, step, message) VALUES (?, ?, ?)",
                   (generation_id, "start", f"{model} · {detail}"))
        db.execute("UPDATE generations SET status = 'generating' WHERE id = ?", (generation_id,))
        db.commit()
        yield sse_event("log", {"step": "start", "message": f"{model} · {detail}"})
    else:
        db.execute("INSERT INTO generation_logs (generation_id, step, message) VALUES (?, ?, ?)",
                   (generation_id, "chat", f"Edit request: {message[:100]}"))
        db.commit()
        yield sse_event("log", {"step": "chat", "message": f"Editing: {message[:100]}..."})

    # Load existing pixels for continuation
    existing_pixels = None
    if is_continuation and gen["pixel_data"]:
        existing_pixels = json.loads(gen["pixel_data"])

    # Everything below uses the worker's own connections. Close this one now so a
    # client disconnecting mid-stream (GeneratorExit in the loop below) can't leak
    # it — the old close() after the loop never ran on early exit.
    db.close()

    event_queue = queue_mod.Queue()
    step_count = [0]
    last_pixel_step = [0]
    # The agent only returns its canvas on success, but on_step sees the same object
    # every step — hold it so the error path can still save whatever got painted.
    last_canvas = [None]

    def on_step(canvas, step_type, msg):
        last_canvas[0] = canvas
        # Token usage isn't a log line — accumulate the real counts and stop.
        if step_type == "usage":
            _accumulate_usage(msg)
            return

        step_count[0] += 1
        event_queue.put(sse_event("log", {"step": f"{step_type}_{step_count[0]}", "message": msg}))

        # Send pixel snapshots on tool_result (AFTER execution, canvas is updated)
        # Send on every tool result, or at least every 2 steps
        if step_type == "tool_result" and (step_count[0] - last_pixel_step[0] >= 1):
            last_pixel_step[0] = step_count[0]
            px_copy = [row[:] for row in canvas.pixels]
            event_queue.put(sse_event("pixels", {
                "pixel_data": px_copy, "iteration": step_count[0],
                "notes": f"Step {step_count[0]}", "gen_id": generation_id,
            }))

    def worker():
        try:
            canvas = agent_run(
                gen_id=generation_id,
                message=message,
                palette=palette,
                size=size,
                model_name=model,
                style_prompt=system_prompt,
                sprite_type=sprite_type,
                reference_b64=ref_b64,
                on_step=on_step,
                existing_pixels=existing_pixels,
                quality=quality,
                step_ceiling=step_ceiling,
                cancel_check=lambda: generation_id in _cancelled,
            )

            pixel_data = [row[:] for row in canvas.pixels]
            event_queue.put(sse_event("pixels", {
                "pixel_data": pixel_data, "iteration": step_count[0],
                "notes": "Agent finished", "gen_id": generation_id,
            }))

            db2 = get_db()
            db2.execute("UPDATE generations SET pixel_data = ?, iterations = ? WHERE id = ?",
                       (json.dumps(pixel_data), step_count[0], generation_id))

            filename = save_sprite(canvas.to_image(), generation_id, size)

            db2.execute("UPDATE generations SET status = 'complete', image_path = ? WHERE id = ?",
                       (filename, generation_id))
            db2.commit()
            db2.close()

            event_queue.put(sse_event("log", {"step": "complete", "message": f"Done in {step_count[0]} steps"}))
            event_queue.put(sse_event("complete", {"id": generation_id, "image_path": filename}))

        except Exception as e:
            raw = str(e)
            # deepseek-chat and other OpenAI-compatible models sometimes break the
            # tool-calling protocol mid-run (unpaired tool_calls -> 400). The
            # sanitizer in agent.py repairs the history we send, but if the API
            # still rejects it, give the user something actionable instead of raw JSON.
            if "tool_calls" in raw and ("400" in raw or "invalid_request_error" in raw):
                msg = (f"The model '{model}' broke the tool-calling protocol. "
                       "Try another model, or a lower quality setting.")
            else:
                # Quota, credentials and retired models read the same whether they
                # come from the agent or from concept art — one explainer for both.
                msg = explain_provider_error(raw, model)
            db2 = get_db()
            db2.execute("UPDATE generations SET status = 'error' WHERE id = ?", (generation_id,))
            db2.execute("INSERT INTO generation_logs (generation_id, step, message) VALUES (?, ?, ?)",
                       (generation_id, "error", raw))
            # Whatever the agent painted before it died is still worth keeping — a
            # half-finished sprite beats an empty one, and the client already saw
            # those pixels stream by.
            canvas = last_canvas[0]
            salvaged = painted_pixels(canvas)
            if salvaged:
                db2.execute("UPDATE generations SET pixel_data = ?, iterations = ? WHERE id = ?",
                           (json.dumps(salvaged), step_count[0], generation_id))
                try:
                    filename = save_sprite(canvas.to_image(), generation_id, size)
                    db2.execute("UPDATE generations SET image_path = ? WHERE id = ?",
                               (filename, generation_id))
                except Exception:
                    pass  # the pixels are saved; a missing PNG is recoverable, losing art isn't
            db2.commit()
            db2.close()
            event_queue.put(sse_event("error", {"message": msg}))
        finally:
            _running.discard(generation_id)
            _cancelled.discard(generation_id)  # ponytail: in-memory cancel set
            event_queue.put(None)

    # ponytail: one daemon thread per generation, no cancel and no concurrency cap.
    # Fine for one local user; add a semaphore + cooperative cancel if you ever
    # run more than one generation at a time. The thread outlives the timeout below.
    _running.add(generation_id)  # marked before start so an instant cancel isn't dropped
    t = threading.Thread(target=worker, daemon=True)
    t.start()

    # The old rule was "no event in 5 minutes = error, stop streaming". That
    # punished slow, not dead: a big local model on a 64x64 can easily think
    # longer than that, and the worker kept painting after the client had been
    # told it timed out — the DB then said complete while the user saw a failure.
    # The stream ends when the worker ends, and only a thread that has actually
    # died is reported as an error.
    #
    # The wait itself is now reported. This loop already knew how long it had
    # been silent and said nothing — the activity log went "start" and then
    # blank for as long as the model took, which reads identical to a hang. A
    # line every 20s costs nothing and turns "is it dead?" into a number.
    import time as _time
    began = _time.monotonic()
    while True:
        try:
            ev = event_queue.get(timeout=20)
            if ev is None:
                break
            yield ev
        except queue_mod.Empty:
            if not t.is_alive():
                yield sse_event("error", {"message": "The agent stopped unexpectedly."})
                break
            waited = int(_time.monotonic() - began)
            # Before the first step the model hasn't answered once — that is a
            # different problem from a model that is answering but slowly, and
            # the two used to look the same from here.
            msg = (f"Waiting for the model's first reply · {waited}s"
                   if step_count[0] == 0 else
                   f"No reply for {waited}s · {step_count[0]} steps so far")
            yield sse_event("log", {"step": "waiting", "message": msg})

# ── FastAPI ──

app = FastAPI(title="Ditherra")

# Middleware order matters: add_middleware prepends, so the LAST one added runs
# FIRST. CORS must be added after the auth middleware, otherwise preflight
# OPTIONS requests get a 401 with no CORS headers and every browser call fails.

# Optional API key auth — set API_KEY env var to enable
_API_KEY = os.getenv("API_KEY")

if _API_KEY:
    from starlette.middleware.base import BaseHTTPMiddleware

    class ApiKeyMiddleware(BaseHTTPMiddleware):
        async def dispatch(self, request, call_next):
            # Preflight carries no headers to check; CORS handles it.
            if request.method == "OPTIONS" or request.url.path == "/health":
                return await call_next(request)
            key = request.headers.get("x-api-key") or request.query_params.get("api_key")
            if key != _API_KEY:
                return JSONResponse({"error": "Invalid or missing API key"}, status_code=401)
            return await call_next(request)

    app.add_middleware(ApiKeyMiddleware)

from fastapi.middleware.cors import CORSMiddleware
# The UI is served same-origin by this app; CORS only exists for `npm run dev`
# on :3000. allow_credentials stays False — nothing here uses cookies, and
# browsers reject credentials + wildcard origin anyway.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in os.getenv("CORS_ORIGINS", "http://localhost:3000").split(",") if o.strip()],
    allow_methods=["*"],
    allow_headers=["*"],
)

# API models
class PaletteCreate(BaseModel):
    name: str
    colors: list[str]

    _check = field_validator("colors")(lambda cls, v: _valid_hex(v))

class PaletteUpdate(BaseModel):
    name: Optional[str] = None
    colors: Optional[list[str]] = None

    _check = field_validator("colors")(lambda cls, v: _valid_hex(v) if v else v)

class ReferenceRequest(BaseModel):
    size: int = 16   # what the sprite will be painted at, so the art matches
    prompt: str
    feedback: Optional[str] = None
    model: Optional[str] = None
    sprite_type: str = "block"

class GenerateRequest(BaseModel):
    quality: str = "normal"   # draft | normal | high | max
    # None = no step cap: only the agent's own finish and the user's STOP end the
    # run. Sent by the UI when "cost doesn't matter" is on. Anything else caps it.
    step_ceiling: Optional[int] = None
    prompt: str
    colors: list[str]
    size: int = 16
    system_prompt: Optional[str] = None
    model: Optional[str] = None
    reference_id: Optional[str] = None
    sprite_type: str = "block"

    _check = field_validator("colors")(lambda cls, v: _valid_hex(v))

class ManualPixelUpdate(BaseModel):
    # generation_id comes from the path, not the body
    updates: list[dict]  # [{x, y, color}]

# ── Palette endpoints ──

@app.get("/api/palettes")
def list_palettes():
    db = get_db()
    rows = db.execute("SELECT * FROM palettes ORDER BY created_at DESC").fetchall()
    db.close()
    return [{"id": r["id"], "name": r["name"], "colors": json.loads(r["colors"]), "created_at": r["created_at"]} for r in rows]

@app.post("/api/palettes")
def create_palette(data: PaletteCreate):
    db = get_db()
    cur = db.execute("INSERT INTO palettes (name, colors) VALUES (?, ?)",
                     (data.name, json.dumps(data.colors)))
    db.commit()
    pid = cur.lastrowid
    db.close()
    return {"id": pid, "name": data.name, "colors": data.colors}

@app.put("/api/palettes/{palette_id}")
def update_palette(palette_id: int, data: PaletteUpdate):
    db = get_db()
    if data.name:
        db.execute("UPDATE palettes SET name = ? WHERE id = ?", (data.name, palette_id))
    if data.colors:
        db.execute("UPDATE palettes SET colors = ? WHERE id = ?", (json.dumps(data.colors), palette_id))
    db.commit()
    row = db.execute("SELECT * FROM palettes WHERE id = ?", (palette_id,)).fetchone()
    db.close()
    if not row:
        raise HTTPException(404)
    return {"id": row["id"], "name": row["name"], "colors": json.loads(row["colors"])}

@app.delete("/api/palettes/{palette_id}")
def delete_palette(palette_id: int):
    db = get_db()
    db.execute("DELETE FROM palettes WHERE id = ?", (palette_id,))
    db.commit()
    db.close()
    return {"ok": True}

# ── Reference image endpoints ──

@app.post("/api/reference")
def generate_reference(data: ReferenceRequest):
    """Generate a concept/reference image using image generation model."""

    img_model = None   # named in the error message, so it must exist before the try
    try:
        type_config = SPRITE_TYPES.get(data.sprite_type, SPRITE_TYPES["block"])
        # A reference for a 16x16 tile and one for a 64x64 character are different
        # drawings: at 16px you need bold shapes and few colours, at 64px you can
        # afford detail. The concept model was never told which one it was making.
        detail = ("Extremely simple and bold — this becomes a 16x16 sprite, so only the "
                  "largest shapes survive." if data.size <= 16 else
                  "Moderate detail — this becomes a 32x32 sprite." if data.size <= 32 else
                  "Detailed — this becomes a 64x64 sprite and can carry small features.")
        ref_prompt = (f"{data.prompt}\n\n{type_config['ref_prompt']}\n"
                      f"- Target resolution: {data.size}x{data.size} pixels. {detail}")
        if data.feedback:
            ref_prompt += f"\n\nRevision feedback: {data.feedback}"

        wanted = data.model if data.model in providers.image_models() else providers.default_image_model()
        if not wanted:
            return JSONResponse(
                {"error": "No concept-art provider configured. Add a Gemini or OpenAI key in "
                          "Settings, or sign in with Antigravity."}, status_code=400)

        # Which SDK to reach for is the provider's business, not this handler's.
        _, provider, img_model = providers.resolve(wanted)
        kind = provider.get("kind", "openai")
        if kind == "gemini":
            png = _image_via_google(img_model, ref_prompt)
        elif kind == "cloudflare":
            png = _image_via_cloudflare(provider, img_model, ref_prompt)
        else:
            png = _image_via_openai(provider, img_model, ref_prompt)

        ref_id = f"ref_{uuid.uuid4().hex[:12]}.png"
        storage.save_file(f"references/{ref_id}", png)
        return {"reference_id": ref_id}
    except Exception as e:
        import traceback
        # Log the traceback server-side; return only the message. The traceback
        # leaks internal paths and is useless to the browser.
        print(f"[REFERENCE ERROR]\n{traceback.format_exc()}")
        return JSONResponse({"error": explain_provider_error(str(e), img_model)}, status_code=500)

MAX_UPLOAD_BYTES = 10 * 1024 * 1024

@app.post("/api/reference/upload")
async def upload_reference(request: Request):
    """Upload a local image as reference."""
    content_type = request.headers.get("content-type", "")

    # The body is read fully into memory, so check the declared size first and
    # re-check after reading: Content-Length is a claim, not a guarantee.
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, f"Image is larger than {MAX_UPLOAD_BYTES // (1024 * 1024)}MB")

    if "multipart/form-data" in content_type:
        form = await request.form()
        file = form.get("file")
        if not file:
            raise HTTPException(400, "No file uploaded")
        data = await file.read()
    else:
        data = await request.body()

    if not data:
        raise HTTPException(400, "Empty file")
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, f"Image is larger than {MAX_UPLOAD_BYTES // (1024 * 1024)}MB")

    ref_id = f"ref_{uuid.uuid4().hex[:12]}.png"

    # A reference is fed back to a vision model, so it has to be a real raster.
    # Storing bytes PIL cannot open under a .png name only moves the failure.
    try:
        image = Image.open(io.BytesIO(data))
        image.load()
    except Exception:
        raise HTTPException(400, "That file is not a readable image")

    storage.save_image(image, f"references/{ref_id}")
    return {"reference_id": ref_id}

@app.get("/api/reference/{ref_id}")
def serve_reference(ref_id: str):
    data = storage.read_file(f"references/{ref_id}")
    if not data:
        raise HTTPException(404)
    return Response(content=data, media_type="image/png")


@app.get("/api/reference/{ref_id}/palette")
def reference_palette(ref_id: str, n: int = 24):
    """The dominant colours of a reference image, so you can paint the sprite
    with the concept art's own palette. Quantize to n colours, dedup, return hex."""
    data = storage.read_file(f"references/{ref_id}")
    if not data:
        raise HTTPException(404)
    n = max(2, min(n, 48))
    img = Image.open(io.BytesIO(data)).convert("RGB")
    pal = img.quantize(colors=n, method=Image.Quantize.FASTOCTREE).getpalette() or []
    seen: set[str] = set()
    colors: list[str] = []
    for i in range(0, min(len(pal), n * 3), 3):
        hex_c = "#%02x%02x%02x" % (pal[i], pal[i + 1], pal[i + 2])
        if hex_c not in seen:
            seen.add(hex_c)
            colors.append(hex_c)
    return {"colors": colors}

# ── Generation endpoints ──

@app.get("/api/generations")
def list_generations():
    db = get_db()
    rows = db.execute("""
        SELECT * FROM generations
        ORDER BY created_at DESC
        LIMIT 50
    """).fetchall()
    db.close()
    return [dict(r) for r in rows]

@app.delete("/api/generations/{gen_id}")
def delete_generation(gen_id: int):
    db = get_db()
    gen = db.execute("SELECT image_path FROM generations WHERE id = ?", (gen_id,)).fetchone()
    if gen and gen["image_path"]:
        for suffix in ("", "_preview"):
            f = storage.resolve(f"output/{gen['image_path'].replace('.png', f'{suffix}.png')}")
            f.unlink(missing_ok=True)
    db.execute("DELETE FROM generation_logs WHERE generation_id = ?", (gen_id,))
    db.execute("DELETE FROM generations WHERE id = ?", (gen_id,))
    db.commit()
    db.close()
    return {"ok": True}

@app.get("/api/generations/{gen_id}")
def get_generation(gen_id: int):
    db = get_db()
    gen = db.execute("SELECT * FROM generations WHERE id = ?", (gen_id,)).fetchone()
    if not gen:
        raise HTTPException(404)
    logs = db.execute("SELECT * FROM generation_logs WHERE generation_id = ? ORDER BY created_at",
                      (gen_id,)).fetchall()
    db.close()
    return {
        **dict(gen),
        "pixel_data": json.loads(gen["pixel_data"]) if gen["pixel_data"] else None,
        "colors": json.loads(gen["colors"]) if gen["colors"] else None,
        "logs": [dict(l) for l in logs],
    }

@app.post("/api/generate")
# Deliberately sync: providers.models() below does blocking HTTP (provider discovery,
# and a JSON-RPC to codex that can spawn a subprocess). On the event loop that froze
# the whole app — including in-flight SSE streams — for up to 30s. FastAPI runs a
# plain `def` in the threadpool, where blocking is fine.
def start_generation(data: GenerateRequest):
    if data.size not in (8, 16, 32, 64):
        raise HTTPException(400, "Size must be 8, 16, 32, or 64")
    if not data.colors:
        raise HTTPException(400, "Colors array is required")

    db = get_db()
    usable = providers.models()
    if not usable:
        raise HTTPException(400, "No AI provider configured. Add a key to .env — see .env.example")
    model = data.model or providers.default_model()
    if not model:
        raise HTTPException(400, "Select an AI model before generating")
    if model not in usable:
        raise HTTPException(400, "Unknown or unavailable AI model")
    cur = db.execute(
        "INSERT INTO generations (prompt, system_prompt, colors, size, model, reference_id, sprite_type) VALUES (?, ?, ?, ?, ?, ?, ?)",
        (data.prompt, data.system_prompt, json.dumps(data.colors), data.size, model, data.reference_id, data.sprite_type),
    )
    gen_id = cur.lastrowid
    db.commit()
    db.close()

    return StreamingResponse(
        _run_agent_sse(gen_id, data.prompt, colors=data.colors, quality=data.quality,
                       step_ceiling=data.step_ceiling),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


class BlankRequest(BaseModel):
    size: int = 16
    colors: list[str]

    _check = field_validator("colors")(lambda cls, v: _valid_hex(v))


class ImportRequest(BaseModel):
    size: int = 16
    colors: list[str]
    pixel_data: list[list[int]]

    _check = field_validator("colors")(lambda cls, v: _valid_hex(v))


@app.post("/api/generations/blank")
def create_blank(data: BlankRequest):
    """A fresh empty canvas to draw on from scratch — no AI. Stored like any
    generation so it lands in history and its pixels persist."""
    if data.size not in (8, 16, 32, 64):
        raise HTTPException(400, "Size must be 8, 16, 32, or 64")
    pixel_data = [[-1] * data.size for _ in range(data.size)]
    db = get_db()
    cur = db.execute(
        "INSERT INTO generations (prompt, colors, size, pixel_data, status, sprite_type) VALUES (?, ?, ?, ?, ?, ?)",
        ("(blank)", json.dumps(data.colors), data.size, json.dumps(pixel_data), "complete", "freeform"),
    )
    gen_id = cur.lastrowid
    filename = save_sprite(pixels_to_image(pixel_data, data.colors, data.size), gen_id, data.size)
    db.execute("UPDATE generations SET image_path = ? WHERE id = ?", (filename, gen_id))
    db.commit()
    db.close()
    return {"id": gen_id, "image_path": filename, "size": data.size, "colors": data.colors, "pixel_data": pixel_data}

@app.post("/api/generations/import")
def create_import(data: ImportRequest):
    """A sprite built from an uploaded image, already pixelated to size×size and
    quantised to a palette on the client. Stored like any generation so it lands
    in history and is immediately editable."""
    n = data.size
    if n not in (8, 16, 32, 64):
        raise HTTPException(400, "Size must be 8, 16, 32, or 64")
    if not data.colors:
        raise HTTPException(400, "No colors")
    if len(data.pixel_data) != n or any(len(row) != n for row in data.pixel_data):
        raise HTTPException(400, "pixel_data must be size×size")
    ncol = len(data.colors)
    # Clamp every index into the palette, exactly like update_pixels does.
    pd = [[c if -1 <= c < ncol else -1 for c in row] for row in data.pixel_data]
    db = get_db()
    cur = db.execute(
        "INSERT INTO generations (prompt, colors, size, pixel_data, status, sprite_type) VALUES (?, ?, ?, ?, ?, ?)",
        ("(import)", json.dumps(data.colors), n, json.dumps(pd), "complete", "freeform"),
    )
    gen_id = cur.lastrowid
    filename = save_sprite(pixels_to_image(pd, data.colors, n), gen_id, n)
    db.execute("UPDATE generations SET image_path = ? WHERE id = ?", (filename, gen_id))
    db.commit()
    db.close()
    return {"id": gen_id, "image_path": filename, "size": n, "colors": data.colors, "pixel_data": pd}


@app.post("/api/generations/{gen_id}/update_pixels")
def manual_pixel_update(gen_id: int, data: ManualPixelUpdate):
    db = get_db()
    gen = db.execute("SELECT * FROM generations WHERE id = ?", (gen_id,)).fetchone()
    if not gen or not gen["pixel_data"]:
        raise HTTPException(404)

    pixel_data = json.loads(gen["pixel_data"])
    palette = palette_of(gen)
    size = gen["size"]

    for u in data.updates:
        x, y, c = u.get("x", 0), u.get("y", 0), u.get("color", -1)
        # Clamp color to the palette, like Canvas.set_pixel does — an out-of-range
        # index would persist as inconsistent data (later rendered as transparent).
        if 0 <= y < size and 0 <= x < size and -1 <= c < len(palette):
            pixel_data[y][x] = c

    save_sprite(pixels_to_image(pixel_data, palette, size), gen_id, size)

    db.execute("UPDATE generations SET pixel_data = ? WHERE id = ?",
               (json.dumps(pixel_data), gen_id))
    db.commit()
    db.close()
    return {"ok": True, "pixel_data": pixel_data}

# ── Image serving ──

@app.get("/api/images/{filename}")
def serve_image(filename: str):
    data = storage.read_file(f"output/{filename}")
    if not data:
        raise HTTPException(404)
    return Response(content=data, media_type="image/png")

# ── Chat (continue agent session) ──

class ChatRequest(BaseModel):
    generation_id: int
    message: str

@app.post("/api/chat")
# Sync for the same reason as /api/generate: sqlite plus a blocking SSE generator.
def chat_with_agent(data: ChatRequest):
    db = get_db()
    gen = db.execute("SELECT * FROM generations WHERE id = ?", (data.generation_id,)).fetchone()
    db.close()
    if not gen:
        raise HTTPException(404)

    return StreamingResponse(
        _run_agent_sse(data.generation_id, data.message, is_continuation=True),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )

# ── Cancel (stop the agent, keep what's painted) ──

@app.post("/api/generations/{gen_id}/cancel")
def cancel_generation(gen_id: int):
    # ponytail: cooperative cancel — the worker checks this between agent steps and
    # stops before the next model call. Whatever's on the canvas is saved normally.
    # No live worker means the run already ended: setting the flag would only poison
    # the next one, so say so instead.
    if gen_id not in _running:
        return {"ok": False, "reason": "not running"}
    _cancelled.add(gen_id)
    return {"ok": True}


# ── Finalize (skip remaining iterations) ──

@app.post("/api/generations/{gen_id}/finalize")
def finalize_generation(gen_id: int):
    db = get_db()
    gen = db.execute("SELECT * FROM generations WHERE id = ?", (gen_id,)).fetchone()
    if not gen or not gen["pixel_data"]:
        raise HTTPException(404)

    palette = palette_of(gen)
    pixel_data = json.loads(gen["pixel_data"])
    size = gen["size"]

    filename = save_sprite(pixels_to_image(pixel_data, palette, size), gen_id, size)

    db.execute("UPDATE generations SET status = 'complete', image_path = ? WHERE id = ?",
               (filename, gen_id))
    db.execute("INSERT INTO generation_logs (generation_id, step, message) VALUES (?, ?, ?)",
               (gen_id, "finalized", "Manually finalized — skipped remaining iterations"))
    db.commit()
    db.close()
    return {"ok": True, "id": gen_id, "image_path": filename}

# ── Tileset generation ──

class TilesetRequest(BaseModel):
    generation_id: int
    name: str  # e.g. "Dirt" — files will be Dirt_00.png through Dirt_15.png

    # Name becomes a directory and a filename prefix — keep it a plain identifier
    # so it can't inject path separators or traversal.
    _check = field_validator("name")(lambda cls, v: _valid_name(v))

@app.post("/api/tileset")
def generate_tileset_endpoint(data: TilesetRequest):
    db = get_db()
    gen = db.execute("SELECT * FROM generations WHERE id = ?", (data.generation_id,)).fetchone()
    if not gen or not gen["pixel_data"]:
        raise HTTPException(404, "Generation not found or has no pixel data")

    palette = palette_of(gen)
    pixel_data = json.loads(gen["pixel_data"])
    size = gen["size"]
    db.close()

    # Build base image (this is variant 15 — fully surrounded)
    base_img = pixels_to_image(pixel_data, palette, size)

    # Generate all 16 variants
    variants = generate_tileset(base_img)

    # Save to output/tilesets/<name>/  (name is user input — resolve() blocks traversal)
    try:
        tileset_dir = storage.resolve(f"output/tilesets/{data.name}")
    except ValueError:
        raise HTTPException(400, "Invalid tileset name")
    tileset_dir.mkdir(parents=True, exist_ok=True)

    files = []
    for mask in range(16):
        filename = f"{data.name}_{mask:02d}.png"
        variants[mask].save(tileset_dir / filename)
        files.append(filename)

    return {
        "name": data.name,
        "path": str(tileset_dir),
        "files": files,
        "count": len(files),
    }

@app.get("/api/tileset/{name}/{filename}")
def serve_tileset_file(name: str, filename: str):
    try:
        path = storage.resolve(f"output/tilesets/{name}/{filename}")
    except ValueError:
        raise HTTPException(404)
    if not path.is_file() or path.suffix.lower() != ".png":
        raise HTTPException(404)
    return FileResponse(path, media_type="image/png")

@app.get("/api/tileset/{name}")
def get_tileset_preview(name: str):
    try:
        tileset_dir = storage.resolve(f"output/tilesets/{name}")
    except ValueError:
        raise HTTPException(404)
    if not tileset_dir.is_dir():
        raise HTTPException(404)
    files = sorted([f.name for f in tileset_dir.glob("*.png")])
    return {"name": name, "files": files}

@app.get("/health")
def health():
    return {"status": "ok"}

# ── Providers / keys ──
#
# Keys are write-only across this boundary: the panel can set or clear one and
# ask whether it's configured, but no endpoint ever returns a key. A browser is
# a hostile place to hand secrets back to.

class ProviderKey(BaseModel):
    key: str


class DefaultModel(BaseModel):
    model: str | None = None


@app.get("/api/providers")
def list_providers():
    return providers.status()


@app.get("/api/codex/account")
def codex_account():
    """Sanitized account state only; OAuth tokens never cross into the browser."""
    try:
        return codex_app_server.account_status()
    except codex_app_server.CodexError as exc:
        raise HTTPException(503, str(exc))


@app.post("/api/codex/login")
def codex_login():
    try:
        return codex_app_server.login_chatgpt()
    except codex_app_server.CodexError as exc:
        raise HTTPException(503, str(exc))


@app.post("/api/codex/logout")
def codex_logout():
    try:
        codex_app_server.logout()
        return {"ok": True}
    except codex_app_server.CodexError as exc:
        raise HTTPException(503, str(exc))


@app.put("/api/providers/{name}/key")
def set_provider_key(name: str, data: ProviderKey):
    p = providers.config().get("providers", {}).get(name)
    if not p:
        raise HTTPException(404, "Unknown provider")
    env = providers._env_names(p)
    if not env:
        raise HTTPException(400, f"{name} runs locally and takes no key")
    key = data.key.strip()
    if not key:
        raise HTTPException(400, "Key is empty")
    providers.save_key(env[0], key)
    providers._discovery_cache.clear()   # the provider may have models now
    global client
    client = None                        # rebuild the Gemini client with the new key
    return {"ok": True}


class ProviderTestRequest(BaseModel):
    # A key to probe without saving it. Omitted means "test what's stored".
    key: Optional[str] = None


@app.post("/api/providers/{name}/test")
def test_provider(name: str, data: ProviderTestRequest | None = None):
    """Probe a provider now, so a wrong key or a stopped Ollama shows up here
    instead of halfway through a generation.

    With a key in the body it probes that one instead of the stored one, and
    never persists it — so you find out a key is wrong before it reaches disk.
    """
    try:
        return providers.test_connection(name, (data.key or None) if data else None)
    except KeyError:
        raise HTTPException(404, "Unknown provider")


@app.delete("/api/providers/{name}/key")
def clear_provider_key(name: str):
    p = providers.config().get("providers", {}).get(name)
    if not p:
        raise HTTPException(404, "Unknown provider")
    for env in providers._env_names(p):
        providers.forget_key(env)
    providers._discovery_cache.clear()
    global client
    client = None
    return {"ok": True}


@app.put("/api/settings/default_model")
def set_default_model(data: DefaultModel):
    """Persist which model is used when a generation doesn't name one."""
    if data.model and data.model not in providers.models():
        raise HTTPException(400, "unknown or unusable model")
    providers.save_default(data.model)
    return {"ok": True, "default_model": providers.default_model()}


@app.get("/api/settings")
def get_settings():
    return {
        "system_prompt": DEFAULT_SYSTEM_PROMPT,
        "models": providers.models(),
        "capabilities": providers.capabilities(),   # per model: can it see, can it call tools
        "default_model": providers.default_model(),
        "image_models": providers.image_models(),
        # Every declared concept-art model, including the ones you can't use yet
        # — the dropdown greys those out instead of hiding that they exist.
        "image_model_options": providers.image_model_options(),
        "google_credential": providers.google_credential_kind(),
        "default_image_model": providers.default_image_model(),
        "sprite_types": {k: {"label": v["label"], "has_tileset": v["has_tileset"]} for k, v in SPRITE_TYPES.items()},
        "session_usage": dict(_session_tokens),
    }

# ── Static files (UI) ──

STATIC_DIR = Path(__file__).parent / "static"
# The UI is a build artifact and isn't in git — without this a fresh clone crashes
# on startup with "Directory 'static' does not exist" instead of saying what to do.
STATIC_DIR.mkdir(exist_ok=True)
if not (STATIC_DIR / "index.html").exists():
    print("\n  UI not built. Run:  cd frontend && npm install && npm run build")
    print("  (or just use ./start.sh, which does it for you)\n")
class BuildAwareStatic(StaticFiles):
    """Cache the fingerprinted assets forever, never cache the HTML.

    Starlette sends no Cache-Control at all, so browsers fall back to heuristic
    freshness and keep index.html for minutes or hours without asking. You
    rebuild, you reload, and you get the previous HTML — which points at the
    previous chunk hashes, so the whole old app loads. That is the bug where
    "my changes don't show up".

    Files under /_next/static carry a content hash in their name, so they can be
    cached forever; index.html must revalidate every time. The ETag makes that
    a 304 in practice, not a re-download.
    """

    async def get_response(self, path: str, scope):
        response = await super().get_response(path, scope)
        immutable = path.startswith("_next/static/")
        response.headers["Cache-Control"] = (
            "public, max-age=31536000, immutable" if immutable else "no-cache"
        )
        return response


app.mount("/", BuildAwareStatic(directory=STATIC_DIR, html=True), name="static")

_index = STATIC_DIR / "index.html"
if _index.exists():
    from datetime import datetime
    built = datetime.fromtimestamp(_index.stat().st_mtime).strftime("%H:%M:%S")
    print(f"  UI build: {built}   (if the page looks old, this is the number to check)")

if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", "8500"))
    # Local app: bind to localhost only. Set HOST=0.0.0.0 to reach it from
    # another device on your network — and set API_KEY too if you do.
    host = os.getenv("HOST", "127.0.0.1")
    # Off localhost the app is reachable by anything on the network, and it has
    # no auth of its own. Refuse rather than trust the README to be read.
    if host not in ("127.0.0.1", "localhost", "::1") and not os.getenv("API_KEY"):
        raise SystemExit(
            f"Refusing to bind {host} without API_KEY.\n"
            "Anyone who can reach this port could spend your provider credit.\n"
            "Set API_KEY=<a long random string>, or drop HOST to stay on localhost."
        )
    # Auto-reload is for editing the code, not for using the app: it restarts the
    # process, which drops the in-memory agent conversation mid-generation.
    uvicorn.run("server:app", host=host, port=port, reload=os.getenv("DEV") == "1")
