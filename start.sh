#!/bin/bash
# Ditherra — one-command setup & start
set -e

cd "$(dirname "$0")"

# Python 3.10+ — langchain 1.x needs it, and so does this code (`str | None`
# annotations). macOS still ships 3.9 as `python3`, and the failure that causes
# is a wall of pip version numbers that says nothing about the real problem.
needs_310() { "$1" -c 'import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)' 2>/dev/null; }

# DITHERRA_PYTHON lets you point at any interpreter — pyenv, uv, python.org, conda —
# without changing what `python3` means for your other projects.
PY=""
if [ -n "$DITHERRA_PYTHON" ]; then
    if needs_310 "$DITHERRA_PYTHON"; then
        PY="$DITHERRA_PYTHON"
    else
        echo "DITHERRA_PYTHON=$DITHERRA_PYTHON is not Python 3.10+ ($("$DITHERRA_PYTHON" -V 2>&1))"
        exit 1
    fi
else
    for candidate in python3.14 python3.13 python3.12 python3.11 python3.10 python3; do
        command -v "$candidate" >/dev/null 2>&1 || continue
        if needs_310 "$candidate"; then PY="$candidate"; break; fi
    done
fi

if [ -z "$PY" ]; then
    echo ""
    echo "  Python 3.10+ required — found $(python3 -V 2>&1) as python3."
    echo ""
    echo "  Everything installs into ./venv, so this won't affect your other projects."
    echo "  Pick whichever you prefer:"
    echo ""
    echo "    brew install python@3.12"
    echo "    curl -LsSf https://astral.sh/uv/install.sh | sh && uv python install 3.12"
    echo ""
    echo "  Already have one somewhere else? Point at it directly:"
    echo "    DITHERRA_PYTHON=/path/to/python3.12 ./start.sh"
    echo ""
    exit 1
fi

# uvicorn's reloader runs a child process, and Ctrl+C does not always take it
# down with the parent. The leftover keeps the port, and the next run dies with
# a bare "[Errno 48] Address already in use" that names no culprit and no fix.
# Reclaim our own leftovers; never kill a process that isn't ours.
free_port() {
    local port="$1" pids pid cmd
    command -v lsof >/dev/null 2>&1 || return 0
    pids=$(lsof -ti "tcp:$port" -sTCP:LISTEN 2>/dev/null) || return 0
    [ -n "$pids" ] || return 0
    for pid in $pids; do
        cmd=$(ps -o command= -p "$pid" 2>/dev/null || true)
        case "$cmd" in
            *server.py*|*uvicorn*)
                echo "Port $port still held by a previous run (pid $pid) — stopping it."
                kill "$pid" 2>/dev/null || true
                ;;
            *)
                echo ""
                echo "  Port $port is in use by something that isn't Ditherra:"
                echo "    pid $pid  $cmd"
                echo ""
                echo "  Stop it, or start on another port:  PORT=8600 ./start.sh"
                echo ""
                exit 1
                ;;
        esac
    done
    # Give the socket a moment to actually close before we bind it.
    sleep 1
}

# A venv built with an older interpreter keeps that interpreter forever, so
# rebuild instead of failing on the same install over and over.
if [ -d "venv" ] && ! needs_310 "venv/bin/python"; then
    echo "Existing venv uses $(venv/bin/python -V 2>&1) — rebuilding with $PY..."
    rm -rf venv
fi

if [ ! -d "venv" ]; then
    echo "Creating virtual environment with $($PY -V 2>&1)..."
    "$PY" -m venv venv
fi
source venv/bin/activate

# Python dependencies
echo "Installing Python dependencies..."
pip install -q --upgrade pip        # the pip bundled with older Pythons resolves badly
pip install -q -r requirements.txt

# .env
if [ ! -f ".env" ]; then
    cp .env.example .env
    echo ""
    echo "Created .env from .env.example"
    echo "Edit .env with your API keys before generating."
    echo ""
fi

# ── Production build: static export served by the backend ────────────────────
#
# `./start.sh --build` (or --prod) compiles the UI into static/ and serves it
# same-origin on :8500. This is the packaged single-process mode — use it to run
# the app, not to develop it.
if [ "$1" = "--build" ] || [ "$1" = "--prod" ]; then
    # `[ frontend/src -nt static/index.html ]` looked right and was wrong: a
    # directory's mtime only moves when a file is added or removed *directly* in
    # it, so editing frontend/src/components/Anything.tsx never bumped
    # frontend/src and the build was skipped. Compare against the newest file
    # anywhere in the tree instead.
    needs_build() {
        [ -f "static/index.html" ] && [ -d "static/_next" ] || return 0
        [ -n "$(find frontend/src frontend/package.json -newer static/index.html 2>/dev/null | head -1)" ]
    }

    # Errors are NOT silenced: a swallowed build failure serves a stale bundle
    # and the app looks broken for reasons nothing explains.
    if needs_build; then
        echo "Building frontend..."
        cd frontend
        npm install --silent
        npm run build
        cd ..
    else
        echo "Frontend up to date."
    fi

    free_port "${PORT:-8500}"

    echo ""
    echo "Starting Ditherra (production build)..."
    echo "Open http://localhost:${PORT:-8500}"
    echo ""
    python server.py   # the venv's python, not the system one
    exit
fi

# ── Default: dev mode, the UI reloads itself ─────────────────────────────────
#
# Developing is the common case, so it's the default. The build-then-restart
# loop is the wrong tool while editing the interface: every change costs a
# rebuild you have to remember to run, and if you forget you're looking at the
# old app with no sign of it — which is exactly the "my changes don't show up"
# bug. Dev mode removes the loop: Next watches the files and pushes changes into
# the open page, usually before you've alt-tabbed back to it.
#
# Run the packaged single-process build with `./start.sh --build`.
free_port "${PORT:-8500}"

echo "NEXT_PUBLIC_API_BASE=http://localhost:${PORT:-8500}/api" > frontend/.env.local
(cd frontend && npm install --silent && npm run dev) &
UI=$!
trap 'kill $UI 2>/dev/null' EXIT INT TERM
echo ""
echo "  Dev mode (default). Edit a file and the page updates itself."
echo "  Open  http://localhost:3000   ← the UI — this is the one you develop against"
echo "        http://localhost:8500   is the API (and the last production build, if any)"
echo ""
echo "  For the packaged single-process build:  ./start.sh --build"
echo ""
DEV=1 python server.py
