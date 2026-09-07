"""Small JSON-RPC bridge to an isolated ``codex app-server`` process.

The profile is deliberately separate from ``~/.codex`` so connecting Ditherra
never changes the account used by the Codex CLI or desktop app.
"""

from __future__ import annotations

import atexit
import json
import os
import queue
import shutil
import subprocess
import sys
import threading
from pathlib import Path
from typing import Any, Callable


class CodexError(RuntimeError):
    pass


def profile_dir() -> Path:
    configured = os.getenv("DITHERRA_CODEX_HOME")
    if configured:
        return Path(configured).expanduser()
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "Ditherra" / "codex"
    return Path(os.getenv("XDG_DATA_HOME", Path.home() / ".local" / "share")) / "ditherra" / "codex"


def has_cached_login() -> bool:
    """Cheap check that avoids launching Codex until the user connects it."""
    return (profile_dir() / "auth.json").is_file()


def _tool_specs(tools: list) -> list[dict]:
    return [{
        "type": "function",
        "name": tool.name,
        "description": tool.description or tool.name,
        "inputSchema": tool.get_input_schema().model_json_schema(),
    } for tool in tools]


class AppServer:
    def __init__(self):
        self.process: subprocess.Popen[str] | None = None
        self._next_id = 1
        self._pending: dict[int, queue.Queue] = {}
        self._events: dict[str, queue.Queue] = {}
        self._tool_handlers: dict[str, Callable[[str, dict], dict]] = {}
        self._lock = threading.RLock()
        self._write_lock = threading.Lock()
        self._stderr: list[str] = []

    def _start(self) -> None:
        with self._lock:
            if self.process and self.process.poll() is None:
                return
            binary = os.getenv("CODEX_BINARY") or shutil.which("codex")
            if not binary:
                raise CodexError("Codex CLI is not installed or is not on PATH")

            home = profile_dir()
            workspace = home / "workspace"
            home.mkdir(parents=True, exist_ok=True, mode=0o700)
            workspace.mkdir(exist_ok=True, mode=0o700)
            config = home / "config.toml"
            if not config.exists():
                config.write_text('cli_auth_credentials_store = "file"\n\n[analytics]\nenabled = false\n')
                os.chmod(config, 0o600)

            env = os.environ.copy()
            env["CODEX_HOME"] = str(home)
            self.process = subprocess.Popen(
                [binary, "app-server", "--stdio"],
                cwd=workspace,
                env=env,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                bufsize=1,
            )
            threading.Thread(target=self._read_stdout, daemon=True).start()
            threading.Thread(target=self._read_stderr, daemon=True).start()

        self._request_raw("initialize", {
            "clientInfo": {"name": "ditherra", "title": "Ditherra", "version": "1.0"},
            "capabilities": {"experimentalApi": True},
        })
        self.notify("initialized", {})

    def _read_stdout(self) -> None:
        assert self.process and self.process.stdout
        for line in self.process.stdout:
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue
            if msg.get("method") and "id" in msg:
                self._handle_server_request(msg)
                continue
            if "id" in msg:
                with self._lock:
                    waiter = self._pending.get(msg["id"])
                if waiter:
                    waiter.put(msg)
                continue
            params = msg.get("params") or {}
            thread_id = params.get("threadId")
            if thread_id:
                with self._lock:
                    events = self._events.get(thread_id)
                if events:
                    events.put(msg)
        self._fail_pending("Codex app-server stopped")

    def _read_stderr(self) -> None:
        assert self.process and self.process.stderr
        for line in self.process.stderr:
            self._stderr.append(line.strip())
            del self._stderr[:-40]

    def _handle_server_request(self, msg: dict) -> None:
        if msg.get("method") != "item/tool/call":
            self._send({"id": msg["id"], "error": {"code": -32601, "message": "Unsupported request"}})
            return
        params = msg.get("params") or {}
        with self._lock:
            handler = self._tool_handlers.get(params.get("threadId"))
        try:
            if not handler:
                raise CodexError("No tool handler for this Codex thread")
            result = handler(params.get("tool", ""), params.get("arguments") or {})
            self._send({"id": msg["id"], "result": result})
        except Exception as exc:
            self._send({
                "id": msg["id"],
                "result": {"success": False, "contentItems": [{"type": "inputText", "text": str(exc)}]},
            })

    def _fail_pending(self, message: str) -> None:
        with self._lock:
            waiters = list(self._pending.values())
        for waiter in waiters:
            waiter.put({"error": {"message": message}})

    def _send(self, message: dict) -> None:
        if not self.process or not self.process.stdin or self.process.poll() is not None:
            raise CodexError("Codex app-server is not running")
        with self._write_lock:
            self.process.stdin.write(json.dumps(message, separators=(",", ":")) + "\n")
            self.process.stdin.flush()

    def _request_raw(self, method: str, params: dict | None = None, timeout: float = 30) -> dict:
        with self._lock:
            request_id = self._next_id
            self._next_id += 1
            waiter: queue.Queue = queue.Queue(maxsize=1)
            self._pending[request_id] = waiter
        try:
            self._send({"method": method, "id": request_id, "params": params or {}})
            try:
                message = waiter.get(timeout=timeout)
            except queue.Empty as exc:
                raise CodexError(f"Codex timed out during {method}") from exc
            if message.get("error"):
                error = message["error"]
                raise CodexError(error.get("message") if isinstance(error, dict) else str(error))
            return message.get("result") or {}
        finally:
            with self._lock:
                self._pending.pop(request_id, None)

    def request(self, method: str, params: dict | None = None, timeout: float = 30) -> dict:
        self._start()
        return self._request_raw(method, params, timeout)

    def notify(self, method: str, params: dict | None = None) -> None:
        self._send({"method": method, "params": params or {}})

    def account(self) -> dict:
        result = self.request("account/read", {"refreshToken": False})
        account = result.get("account")
        if not account:
            return {"configured": False}
        return {
            "configured": True,
            "type": account.get("type"),
            "email": account.get("email"),
            "plan": account.get("planType"),
        }

    def login_chatgpt(self) -> dict:
        return self.request("account/login/start", {"type": "chatgpt"}, timeout=60)

    def logout(self) -> None:
        self.request("account/logout")

    def models(self) -> list[dict]:
        result = self.request("model/list", {"limit": 100, "includeHidden": False})
        return [{
            "id": item.get("model") or item.get("id"),
            "vision": "image" in item.get("inputModalities", ["text", "image"]),
            "tools": True,
        } for item in result.get("data", []) if item.get("model") or item.get("id")]

    def start_thread(self, model: str, tools: list) -> str:
        result = self.request("thread/start", {
            "model": model,
            "cwd": str(profile_dir() / "workspace"),
            "approvalPolicy": "never",
            "sandbox": "read-only",
            "ephemeral": True,
            "serviceName": "ditherra",
            "developerInstructions": (
                "You are Ditherra's pixel-painting engine. Use only the supplied dynamic drawing "
                "tools. Never run shell commands, read files, edit files, browse, delegate, or ask "
                "questions. Paint the requested sprite and call finish when satisfied."
            ),
            "dynamicTools": _tool_specs(tools),
        })
        thread_id = (result.get("thread") or {}).get("id")
        if not thread_id:
            raise CodexError("Codex did not return a thread id")
        return thread_id

    def run_turn(
        self,
        thread_id: str,
        text: str,
        tools: list,
        reference_b64: str | None,
        on_step: Callable | None,
        canvas: Any,
        max_steps: int,
        cancel_check: Callable | None,
    ) -> None:
        by_name = {tool.name: tool for tool in tools}
        state = {"calls": 0, "limit": False}

        def call_tool(name: str, arguments: dict) -> dict:
            tool = by_name.get(name)
            if not tool:
                raise CodexError(f"Unknown drawing tool: {name}")
            state["calls"] += 1
            if on_step:
                on_step(canvas, "tool_call", f"Tool: {name}({json.dumps(arguments, separators=(',', ':'))})")
            result = str(tool.invoke(arguments))
            if on_step:
                on_step(canvas, "tool_result", result[:200])
            if state["calls"] >= max_steps:
                state["limit"] = True
            return {"success": True, "contentItems": _content_items(result)}

        events: queue.Queue = queue.Queue()
        with self._lock:
            self._events[thread_id] = events
            self._tool_handlers[thread_id] = call_tool
        inputs = [{"type": "text", "text": text}]
        if reference_b64:
            inputs.append({"type": "image", "url": f"data:image/png;base64,{reference_b64}"})
        try:
            self.request("turn/start", {"threadId": thread_id, "input": inputs})
            interrupted = False
            while True:
                if not interrupted and ((cancel_check and cancel_check()) or state["limit"]):
                    self.request("turn/interrupt", {"threadId": thread_id}, timeout=10)
                    interrupted = True
                try:
                    event = events.get(timeout=0.25)
                except queue.Empty:
                    if not self.process or self.process.poll() is not None:
                        raise CodexError("Codex app-server stopped during generation")
                    continue
                if event.get("method") == "turn/completed":
                    turn = (event.get("params") or {}).get("turn") or {}
                    if turn.get("status") == "failed":
                        raise CodexError((turn.get("error") or {}).get("message", "Codex generation failed"))
                    return
        finally:
            with self._lock:
                self._events.pop(thread_id, None)
                self._tool_handlers.pop(thread_id, None)

    def close(self) -> None:
        with self._lock:
            process, self.process = self.process, None
        if process and process.poll() is None:
            process.terminate()


def _content_items(result: str) -> list[dict]:
    marker = "\n\n[PREVIEW base64 PNG 64x64]\n"
    if marker not in result:
        return [{"type": "inputText", "text": result}]
    text, image = result.split(marker, 1)
    return [
        {"type": "inputText", "text": text},
        {"type": "inputImage", "imageUrl": f"data:image/png;base64,{image.strip()}"},
    ]


_client = AppServer()
_threads: dict[str, str] = {}


def account_status() -> dict:
    return _client.account()


def login_chatgpt() -> dict:
    return _client.login_chatgpt()


def logout() -> None:
    _client.logout()
    _threads.clear()


def models() -> list[dict]:
    return _client.models()


def has_thread(gen_id: Any) -> bool:
    return str(gen_id) in _threads


def run_pixel_turn(gen_id: Any, model: str, text: str, tools: list, canvas: Any,
                   reference_b64: str | None, on_step: Callable | None,
                   max_steps: int, cancel_check: Callable | None) -> None:
    key = str(gen_id)
    thread_id = _threads.get(key)
    if not thread_id:
        thread_id = _client.start_thread(model, tools)
        _threads[key] = thread_id
    _client.run_turn(thread_id, text, tools, reference_b64, on_step, canvas, max_steps, cancel_check)


atexit.register(_client.close)
