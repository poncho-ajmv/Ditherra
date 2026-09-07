"""
Smoke test — no AI calls, no network. Run with `pytest`.

Covers the things that broke silently before: path traversal, the manual
pixel-edit round-trip, and the preview filename the UI derives from image_path.
"""

import io
import base64
import json
import os
import tempfile
from pathlib import Path

from PIL import Image

import providers
import codex_app_server
import storage
import server
from fastapi.testclient import TestClient

c = TestClient(server.app)


def test_basics():
    assert c.get("/health").status_code == 200
    assert c.get("/api/palettes").json()[0]["colors"], "default palette missing"
    assert isinstance(c.get("/api/generations").json(), list)
    # default_model is None when no provider is configured — that's a valid state,
    # the UI shows an empty dropdown instead of models you can't use.
    assert "default_model" in c.get("/api/settings").json()


def test_no_path_traversal():
    """Filenames reach storage straight from the URL — they must not escape it."""
    for bad in ("../../../etc/passwd", "..%2f..%2fetc%2fpasswd"):
        assert c.get(f"/api/images/{bad}").status_code in (400, 404)
        assert c.get(f"/api/reference/{bad}").status_code in (400, 404)
    assert c.get("/api/tileset/../../etc/passwd").status_code in (400, 404)
    assert storage.read_file("../../../etc/passwd") is None


def test_manual_pixel_edit():
    db = server.get_db()
    gen_id = db.execute(
        "INSERT INTO generations (prompt, colors, size, pixel_data, status) VALUES (?,?,?,?,?)",
        ("smoke", '["#000000","#ffffff"]', 2, "[[-1,-1],[-1,-1]]", "complete"),
    ).lastrowid
    db.commit()
    db.close()
    try:
        r = c.post(f"/api/generations/{gen_id}/update_pixels",
                   json={"updates": [{"x": 1, "y": 0, "color": 1}]})
        assert r.status_code == 200, r.text
        assert r.json()["pixel_data"] == [[-1, 1], [-1, -1]]
        assert storage.file_exists(f"output/gen_{gen_id}_2x2.png")
        # The sidebar builds the thumbnail URL by swapping .png -> _preview.png.
        assert storage.file_exists(f"output/gen_{gen_id}_2x2_preview.png"), "preview name mismatch"
    finally:
        c.delete(f"/api/generations/{gen_id}")


def test_reference_upload():
    """Uploads go through storage like everything else, not straight to disk."""
    buf = io.BytesIO()
    Image.new("RGBA", (4, 4), (1, 2, 3, 255)).save(buf, "PNG")
    r = c.post("/api/reference/upload", files={"file": ("a.png", buf.getvalue(), "image/png")})
    assert r.status_code == 200, r.text
    ref_id = r.json()["reference_id"]
    assert storage.file_exists(f"references/{ref_id}")
    assert c.get(f"/api/reference/{ref_id}").status_code == 200


def test_delete_removes_both_files():
    """Deleting a generation must take the preview with it, or previews pile up."""
    db = server.get_db()
    gen_id = db.execute(
        "INSERT INTO generations (prompt, colors, size, pixel_data, status, image_path)"
        " VALUES (?,?,?,?,?,?)",
        ("smoke", '["#000000"]', 2, "[[0,0],[0,0]]", "complete", "PLACEHOLDER"),
    ).lastrowid
    db.execute("UPDATE generations SET image_path = ? WHERE id = ?", (f"gen_{gen_id}_2x2.png", gen_id))
    db.commit()
    db.close()
    c.post(f"/api/generations/{gen_id}/update_pixels", json={"updates": [{"x": 0, "y": 0, "color": 0}]})
    assert storage.file_exists(f"output/gen_{gen_id}_2x2_preview.png")
    c.delete(f"/api/generations/{gen_id}")
    assert not storage.file_exists(f"output/gen_{gen_id}_2x2.png")
    assert not storage.file_exists(f"output/gen_{gen_id}_2x2_preview.png")


def _with_providers(cfg, fn):
    """Run fn against a throwaway providers.json so the test doesn't depend on
    which keys happen to be in the developer's .env."""
    original, tmp = providers.CONFIG_PATH, Path(tempfile.mkdtemp()) / "providers.json"
    tmp.write_text(json.dumps(cfg))
    providers.CONFIG_PATH = tmp
    providers._discovery_cache.clear()
    try:
        return fn()
    finally:
        providers.CONFIG_PATH = original
        providers._discovery_cache.clear()


def test_providers_hide_without_key():
    """A provider you have no key for must not show up — picking it would only
    fail later, mid-generation, with a raw traceback."""
    cfg = {
        "default": "local/m1",
        "providers": {
            "local": {"base_url": "http://x/v1", "api_key": "none", "models": ["m1"], "vision": False},
            "paid": {"base_url": "http://y/v1", "api_key_env": "TEXEL_TEST_KEY_UNSET", "models": ["m2"]},
        },
    }
    os.environ.pop("TEXEL_TEST_KEY_UNSET", None)
    assert _with_providers(cfg, providers.models) == ["local/m1"]

    os.environ["TEXEL_TEST_KEY_UNSET"] = "sk-test"
    try:
        assert _with_providers(cfg, providers.models) == ["local/m1", "paid/m2"]
    finally:
        os.environ.pop("TEXEL_TEST_KEY_UNSET")


def test_provider_resolve_and_vision():
    cfg = {
        "providers": {
            "a": {"base_url": "http://a/v1", "api_key": "k", "models": ["shared"], "vision": False},
            "b": {"base_url": "http://b/v1", "api_key": "k", "models": ["shared"], "vision": True},
        }
    }

    def check():
        # namespacing keeps two providers offering the same model name apart
        assert providers.resolve("b/shared")[1]["base_url"] == "http://b/v1"
        assert providers.has_vision("b/shared") is True
        assert providers.has_vision("a/shared") is False
        # bare names still resolve, so generations saved before namespacing load
        assert providers.resolve("shared")[0] == "a"
        # unknown models fail loudly here, not deep inside a generation
        try:
            providers.resolve("nope/nope")
            raise AssertionError("unknown model was accepted")
        except ValueError:
            pass
        # unreachable endpoint => provider disappears, app keeps working
        assert providers._discover({"base_url": "http://127.0.0.1:9/v1"}) == []

    _with_providers(cfg, check)
    assert providers._declared({
        "vision": False,
        "models": [{"id": "sees", "vision": True}, "text-only"],
    }) == [
        {"id": "sees", "vision": True, "tools": True},
        {"id": "text-only", "vision": False, "tools": True},
    ]


def test_discovery_filters_by_capability():
    """`requires` drops models that can't call tools — but only when the endpoint
    reports capabilities at all, or Ollama (which doesn't) would vanish."""
    reported = {
        "data": [
            {"id": "can-paint", "supported_parameters": ["tools", "temperature"]},
            {"id": "cannot-paint", "supported_parameters": ["temperature"]},
            {"id": "says-nothing"},
        ]
    }
    captured = json.dumps(reported).encode()

    class _Resp(io.BytesIO):
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    import urllib.request
    real = urllib.request.urlopen
    urllib.request.urlopen = lambda *a, **k: _Resp(captured)
    try:
        p = {"base_url": "http://x/v1", "requires": ["tools"]}
        assert [m["id"] for m in providers._discover(p)] == ["can-paint", "says-nothing"]
        # no `requires` => everything the endpoint offers
        assert [m["id"] for m in providers._discover({"base_url": "http://x/v1"})] == [
            "can-paint", "cannot-paint", "says-nothing"
        ]

        # capability travels with the model, not just its name
        reported["data"][0]["architecture"] = {"input_modalities": ["text", "image"]}
        captured = json.dumps(reported).encode()
        urllib.request.urlopen = lambda *a, **k: _Resp(captured)
        seen = {m["id"]: m for m in providers._discover({"base_url": "http://x/v1"})}
        assert seen["can-paint"]["vision"] is True and seen["can-paint"]["tools"] is True
        assert seen["cannot-paint"]["vision"] is False and seen["cannot-paint"]["tools"] is False

        # endpoints that report nothing: the name is the only honest signal
        vm = {"base_url": "http://x/v1", "vision_match": ["*-vl*", "*llava*"]}
        reported["data"] = [{"id": "qwen2.5-vl:7b"}, {"id": "qwen3:8b"}, {"id": "llava:13b"}]
        urllib.request.urlopen = lambda *a, **k: _Resp(json.dumps(reported).encode())
        by_name = {m["id"]: m["vision"] for m in providers._discover(vm)}
        assert by_name == {"qwen2.5-vl:7b": True, "qwen3:8b": False, "llava:13b": True}, by_name
    finally:
        urllib.request.urlopen = real


def test_settings_only_offers_usable_models():
    """The dropdown and the generate endpoint must agree on what's allowed."""
    s = c.get("/api/settings").json()
    assert s["models"] == providers.models()
    assert s["default_model"] is None or s["default_model"] in s["models"]


def test_no_implicit_default_model():
    """An available provider must not become selected until the user chooses it."""
    cfg = {"providers": {
        "antigravity": {"base_url": "http://x/v1", "api_key": "x", "models": ["flash"]},
        "other": {"base_url": "http://y/v1", "api_key": "x", "models": ["m"]},
    }}

    def check():
        assert providers.models() == ["antigravity/flash", "other/m"]
        assert providers.default_model() is None
        r = c.post("/api/generate", json={"prompt": "x", "colors": ["#000000"], "size": 16})
        assert r.status_code == 400, r.text
        assert "select" in r.json()["detail"].lower(), r.text

    _with_providers(cfg, check)


def test_codex_is_separate_and_has_no_implicit_default():
    """Codex is unlocked by its own account and discovers models from App Server;
    neither the ChatGPT catalogue's recommendation nor Antigravity selects one."""
    real_cached = codex_app_server.has_cached_login
    real_account, real_models = codex_app_server.account_status, codex_app_server.models
    codex_app_server.has_cached_login = lambda: True
    codex_app_server.account_status = lambda: {
        "configured": True, "type": "chatgpt", "email": "other@example.com", "plan": "plus",
    }
    codex_app_server.models = lambda: [{"id": "codex-test", "vision": True, "tools": True}]
    cfg = {"providers": {
        "codex": {"kind": "codex", "vision": True},
        "antigravity": {"base_url": "http://x/v1", "api_key": "x", "models": ["flash"]},
    }}

    def check():
        assert providers.models() == ["codex/codex-test", "antigravity/flash"]
        assert providers.default_model() is None
        codex = {p["name"]: p for p in providers.status()}["codex"]
        assert codex["configured"] and not codex["local"]
        assert codex["account_email"] == "other@example.com"
        assert providers.test_connection("codex")["code"] == "ok"

    try:
        _with_providers(cfg, check)
    finally:
        codex_app_server.has_cached_login = real_cached
        codex_app_server.account_status, codex_app_server.models = real_account, real_models

    def check_antigravity_group():
        item = providers.status()[0]
        assert item["kind"] == "antigravity" and not item["local"], \
            "OAuth services must not be presented as on-device"

    _with_providers({"providers": {
        "antigravity": {"kind": "antigravity", "models": ["flash"]},
    }}, check_antigravity_group)


def test_codex_dynamic_tool_protocol():
    try:
        import agent
    except ImportError as e:
        print(f"  (skipped Codex tool check: {e})")
        return
    tools = agent.make_tools(agent.Canvas(8, ["#000000", "#ffffff"]), vision=True)
    specs = codex_app_server._tool_specs(tools)
    draw = next(s for s in specs if s["name"] == "draw_pixel")
    assert draw["type"] == "function"
    assert draw["inputSchema"]["required"] == ["x", "y", "color"]

    items = codex_app_server._content_items("grid\n\n[PREVIEW base64 PNG 64x64]\naGVsbG8=")
    assert [item["type"] for item in items] == ["inputText", "inputImage"]
    assert items[1]["imageUrl"].startswith("data:image/png;base64,")


def test_codex_auth_endpoints_never_return_tokens():
    real_account = codex_app_server.account_status
    real_login = codex_app_server.login_chatgpt
    real_logout = codex_app_server.logout
    codex_app_server.account_status = lambda: {
        "configured": True, "type": "chatgpt", "email": "other@example.com", "plan": "plus",
    }
    codex_app_server.login_chatgpt = lambda: {
        "type": "chatgpt", "loginId": "login-1",
        "authUrl": "https://chatgpt.com/oauth/authorize",
    }
    codex_app_server.logout = lambda: None
    try:
        account = c.get("/api/codex/account")
        login = c.post("/api/codex/login")
        assert account.status_code == 200 and login.status_code == 200
        assert "token" not in (account.text + login.text).lower()
        assert c.post("/api/codex/logout").status_code == 200
    finally:
        codex_app_server.account_status = real_account
        codex_app_server.login_chatgpt = real_login
        codex_app_server.logout = real_logout


def test_generate_explains_missing_provider():
    """With nothing configured the 400 must say why, in the body the UI reads —
    a bare status code sends people hunting through server logs."""
    def check():
        r = c.post("/api/generate", json={
            "prompt": "x", "colors": ["#000000"], "size": 16, "sprite_type": "block",
        })
        assert r.status_code == 400, r.status_code
        assert "provider" in r.json()["detail"].lower(), r.text

    _with_providers({"providers": {}}, check)


def test_keys_are_write_only():
    """The panel can set, check and clear a key — but no endpoint hands one back.
    A browser is the wrong place to receive secrets."""
    cfg = {"providers": {
        "cloudy": {"base_url": "http://x/v1", "api_key_env": "TEXEL_TEST_PANEL_KEY", "models": ["m"]},
        "localy": {"base_url": "http://y/v1", "api_key": "none", "models": ["m"]},
    }}
    secret = "sk-test-abcdefgh1234"
    os.environ.pop("TEXEL_TEST_PANEL_KEY", None)
    original_secrets = providers.SECRETS_PATH
    providers.SECRETS_PATH = Path(tempfile.mkdtemp()) / "secrets.json"

    def check():
        by_name = {p["name"]: p for p in c.get("/api/providers").json()}
        assert by_name["cloudy"]["configured"] is False
        assert by_name["localy"]["local"] is True, "a keyless provider must not ask for one"

        assert c.put("/api/providers/cloudy/key", json={"key": secret}).status_code == 200
        assert secret not in c.get("/api/providers").text, "the key came back over the wire"

        p = {q["name"]: q for q in c.get("/api/providers").json()}["cloudy"]
        assert p["configured"] is True
        assert p["hint"] == secret[-4:], "hint should be the last four characters only"
        assert providers.SECRETS_PATH.stat().st_mode & 0o077 == 0, "secrets.json is group/world readable"

        # a key set in the environment wins and is flagged so the panel won't fight it
        os.environ["TEXEL_TEST_PANEL_KEY"] = "sk-from-env-9999"
        try:
            p = {q["name"]: q for q in c.get("/api/providers").json()}["cloudy"]
            assert p["locked"] is True and p["hint"] == "9999"
        finally:
            os.environ.pop("TEXEL_TEST_PANEL_KEY")

        assert c.delete("/api/providers/cloudy/key").status_code == 200
        assert {q["name"]: q for q in c.get("/api/providers").json()}["cloudy"]["configured"] is False
        assert c.put("/api/providers/nope/key", json={"key": "x"}).status_code == 404
        assert c.put("/api/providers/localy/key", json={"key": "x"}).status_code == 400
        assert c.put("/api/providers/cloudy/key", json={"key": "   "}).status_code == 400

    try:
        _with_providers(cfg, check)
    finally:
        providers.SECRETS_PATH = original_secrets


def test_connection_test_names_the_fix():
    """Each failure a user can actually hit gets its own code, because each one
    needs a different action: start the server, fix the key, fix the URL, pull a
    model. One generic 'failed' would tell them nothing."""
    import threading
    from http.server import BaseHTTPRequestHandler, HTTPServer

    class Stub(BaseHTTPRequestHandler):
        status, payload = 200, {"data": [
            {"id": "paints", "supported_parameters": ["tools"]},
            {"id": "cannot", "supported_parameters": ["temperature"]},
        ]}

        def do_GET(self):
            body = json.dumps(Stub.payload).encode()
            self.send_response(Stub.status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *a):
            pass

    srv = HTTPServer(("127.0.0.1", 11987), Stub)
    threading.Thread(target=srv.serve_forever, daemon=True).start()

    cfg = {"providers": {
        "up": {"base_url": "http://127.0.0.1:11987/v1", "api_key": "x"},
        "down": {"base_url": "http://127.0.0.1:9/v1", "api_key": "x"},
        "nokey": {"base_url": "http://127.0.0.1:11987/v1", "api_key_env": "TEXEL_TEST_ABSENT"},
        "sdk": {"kind": "gemini", "api_key_env": "TEXEL_TEST_ABSENT", "models": ["m"]},
    }}
    os.environ.pop("TEXEL_TEST_ABSENT", None)

    def check():
        ok = providers.test_connection("up")
        assert ok["code"] == "ok", ok
        assert ok["models"] == 2 and ok["tool_models"] == 1, ok

        assert providers.test_connection("down")["code"] == "refused"
        assert providers.test_connection("nokey")["code"] == "no_key"
        # no base_url to probe: say so rather than reporting a false failure
        assert providers.test_connection("sdk")["code"] == "no_endpoint"

        Stub.status, Stub.payload = 401, {}
        assert providers.test_connection("up")["code"] == "unauthorized"
        Stub.status = 404
        assert providers.test_connection("up")["code"] == "not_found"
        Stub.status, Stub.payload = 200, {"data": []}
        assert providers.test_connection("up")["code"] == "no_models"

        # and it must never echo the key back
        assert "x" not in json.dumps(providers.test_connection("up")).replace("code", "")

    try:
        _with_providers(cfg, check)
    finally:
        srv.shutdown()

    assert c.post("/api/providers/nope/test").status_code == 404


def test_only_the_latest_canvas_view_is_sent():
    """The whole conversation is re-sent on every model call, so 30 canvas views
    means 30 pictures of the canvas — 29 of them showing a canvas that no longer
    exists. Only the last one survives; the rest become a one-line stub."""
    try:
        import agent
    except ImportError as e:
        print(f"  (skipped history-trim check: {e})")
        return

    class Msg:
        def __init__(self, name, content):
            self.name, self.content = name, content

        def model_copy(self, update):
            return Msg(self.name, update["content"])

    grid = "   0123456789ABCDEF\n 0 2222222222222222"
    msgs = [
        Msg(None, "system"),
        Msg("view_canvas", grid + " (first)"),
        Msg("fill_rect", "Filled rect, 160 pixels"),
        Msg("view_canvas", grid + " (second)"),
        Msg("fill_rect", "Filled rect, 40 pixels"),
        Msg("view_canvas", grid + " (latest)"),
    ]
    out = agent._drop_stale_canvas_views({"messages": msgs})["llm_input_messages"]

    views = [m.content for m in out if m.name == "view_canvas"]
    assert views[-1].endswith("(latest)"), "the current view must survive intact"
    assert all("superseded" in v for v in views[:-1]), "older views must be stubbed"
    # everything else is untouched, and nothing is dropped
    assert len(out) == len(msgs)
    assert [m.name for m in out] == [m.name for m in msgs]
    assert out[2].content == "Filled rect, 160 pixels", "tool results are not views"


def test_quality_levels_trade_steps_for_tokens():
    try:
        import agent
    except ImportError as e:
        print(f"  (skipped quality check: {e})")
        return
    q = agent.QUALITY
    assert q["draft"]["max_steps"] < q["normal"]["max_steps"] < q["high"]["max_steps"]
    assert q["draft"]["preview"] is False, "draft skips the expensive preview image"
    assert q["normal"]["preview"] and q["high"]["preview"]


def test_prompt_tool_list_matches_real_tools():
    """The tool list in the system prompt is generated, so it can't drift from
    the tools the agent actually has — that drift used to be silent."""
    try:
        import agent
    except ImportError as e:
        print(f"  (skipped tool-list check: {e})")
        return

    canvas = agent.Canvas(8, ["#000000", "#ffffff"])
    for full in (True, False):
        tools = agent.make_tools(canvas, vision=full, full_toolset=full)
        text = agent.describe_tools(tools)
        for tool in tools:
            assert f"- {tool.name}(" in text, f"{tool.name} missing from the prompt"
        assert text.count("\n") + 1 == len(tools), "prompt lists tools the agent doesn't have"

    # the reduced toolset must really be a subset, not a different list
    full_names = {t.name for t in agent.make_tools(canvas, True, True)}
    small_names = {t.name for t in agent.make_tools(canvas, False, False)}
    assert small_names < full_names, "the simplified toolset invented a tool"


def test_crashed_run_keeps_the_art():
    """A failed agent run used to discard everything it had painted. painted_pixels
    is the guard that decides what the error path saves — and it must never hand
    back a blank grid, which would overwrite a previous sprite with nothing."""
    try:
        import agent
    except ImportError as e:
        print(f"  (skipped salvage check: {e})")
        return

    blank = agent.Canvas(8, ["#000000", "#ffffff"])
    assert server.painted_pixels(blank) is None, "an untouched canvas must not be saved"
    assert server.painted_pixels(None) is None

    blank.set_pixel(3, 4, 1)
    saved = server.painted_pixels(blank)
    assert saved is not None and saved[4][3] == 1, "one painted pixel is worth keeping"
    saved[4][3] = 0
    assert blank.pixels[4][3] == 1, "painted_pixels must return a copy, not the live grid"


def test_agent_step_budget_is_actually_applied():
    """QUALITY promised 25/80/120 steps while LangGraph capped every tier at its
    own default of 25 super-steps — and blew up instead of stopping. The config
    must carry a recursion_limit with room for max_steps round trips."""
    try:
        import agent, inspect
    except ImportError as e:
        print(f"  (skipped step-budget check: {e})")
        return
    src = inspect.getsource(agent.run_agent_stream)
    assert "recursion_limit" in src, "the step budget never reaches LangGraph"
    # One round trip is two nodes, so the limit has to clear the budget with slack.
    # Uncapped runs still need a number, and it must be the runaway guard.
    for tier in ("draft", "normal", "high"):
        budget = agent.step_budget(tier)
        assert budget is not None and budget * 2 + 10 > budget
    assert agent.step_budget("max") is None


def test_sprite_types_are_one_catalogue():
    """The UI dropdown, the concept-art prompt and the painting agent all read
    the same entry. They used to read two dicts in two files with nothing
    keeping them in sync, so a type could exist for the UI and be invisible to
    the agent — which produced worse art and no error."""
    import sprite_types
    import agent

    FIELDS = {"label", "ref_prompt", "agent_hint", "has_tileset"}
    assert sprite_types.SPRITE_TYPES, "catalogue is empty"
    for key, entry in sprite_types.SPRITE_TYPES.items():
        assert set(entry) == FIELDS, f"{key} has {sorted(entry)}, expected {sorted(FIELDS)}"
        assert entry["label"] and entry["ref_prompt"] and entry["agent_hint"]
        assert isinstance(entry["has_tileset"], bool)
        # the agent reaches the same entry the API advertises
        assert agent.agent_hint(key) == entry["agent_hint"]

    # everything /api/settings offers is a type the agent can actually paint
    advertised = c.get("/api/settings").json()["sprite_types"]
    assert set(advertised) == set(sprite_types.SPRITE_TYPES)

    # an unknown type falls back rather than raising
    assert agent.agent_hint("nope") == sprite_types.SPRITE_TYPES["block"]["agent_hint"]


def test_max_quality_only_stops_when_asked():
    """`max` is the quality tier where the step budget stops being the dial. It
    must carry no cap of its own, and it must swap in the review workflow — the
    one-pass recipe is what made every tier finish around step 12 regardless of
    how many steps it was given."""
    try:
        import agent
    except ImportError as e:
        print(f"  (skipped max-quality check: {e})")
        return

    assert agent.QUALITY["max"]["max_steps"] is None, "max must not cap itself"
    assert agent.QUALITY["max"]["review"] and agent.QUALITY["max"]["preview"]
    for tier in ("draft", "normal", "high"):
        assert agent.QUALITY[tier]["max_steps"] is not None, f"{tier} lost its cap"
        assert not agent.QUALITY[tier]["review"], f"{tier} must keep the old prompt for comparison"

    canvas = agent.Canvas(8, ["#000000", "#ffffff"])
    tools = agent.make_tools(canvas)
    one_pass = agent.build_system_prompt("x", ["#000000"], 8, "", tools, review=False)
    refine = agent.build_system_prompt("x", ["#000000"], 8, "", tools, review=True)
    assert "Call finish when done" in one_pass
    assert "Call finish when done" not in refine, "review mode still hands out the recipe"
    assert "SILHOUETTE" in refine and "until a full pass finds nothing" in refine


def test_finish_must_be_earned_in_review_mode():
    """finish() straight after a drawing tool means the agent changed the canvas
    and declared it good without looking. Only the review tier enforces it, so
    the other tiers stay byte-identical for comparison."""
    try:
        import agent
    except ImportError as e:
        print(f"  (skipped finish-gate check: {e})")
        return

    def call(tools, name, **kw):
        return next(t for t in tools if t.name == name).invoke(kw)

    canvas = agent.Canvas(8, ["#000000", "#ffffff"])
    gated = agent.make_tools(canvas, require_review=True)

    # painted, never looked -> refused, and the refusal must not read as success
    call(gated, "draw_pixel", x=1, y=1, color=0)
    refusal = call(gated, "finish")
    assert "FINISHED" not in refusal, "the refusal would be read as a finish"
    assert "view_canvas" in refusal

    # looked at what was painted -> allowed
    call(gated, "view_canvas")
    assert call(gated, "finish") == "FINISHED"

    # painted again after looking -> refused again
    call(gated, "draw_pixel", x=2, y=2, color=1)
    assert "FINISHED" not in call(gated, "finish")

    # the other tiers are untouched: finish with no view at all still works
    plain = agent.make_tools(agent.Canvas(8, ["#000000"]), require_review=False)
    call(plain, "draw_pixel", x=0, y=0, color=0)
    assert call(plain, "finish") == "FINISHED"


def test_step_ceiling_caps_but_never_raises():
    """The Settings toggle sends a ceiling. It has to cut an uncapped run down,
    and it must never hand a tier MORE steps than the tier asked for."""
    try:
        import agent
    except ImportError as e:
        print(f"  (skipped ceiling check: {e})")
        return

    budget = agent.step_budget
    assert budget("max", None) is None, "no ceiling means no cap"
    assert budget("max", 500) == 500
    assert budget("draft", 500) == 25, "a high ceiling must not inflate draft"
    assert budget("high", 50) == 50, "a low ceiling must still cut"
    assert budget("nonsense") == budget("normal"), "unknown tier falls back"
    assert agent.RUNAWAY_CEILING > agent.QUALITY["high"]["max_steps"]

    # the request field exists and defaults to no cap
    r = c.post("/api/generate", json={"prompt": "x", "colors": ["#aabbcc"], "size": 16,
                                      "quality": "max", "step_ceiling": None})
    assert r.status_code in (200, 400), r.text  # 400 = no provider configured, fine


def test_provider_errors_become_one_sentence():
    """Google returns quota failures as ~40 lines of nested JSON. The panel that
    shows them is 280px wide, so the one fact that matters has to survive alone —
    and an unrecognised error must still come through verbatim, not be swallowed."""
    quota_zero = ("429 RESOURCE_EXHAUSTED. {'error': {'code': 429, 'message': 'You exceeded "
                  "your current quota... Quota exceeded for metric: generate_content_free_tier, "
                  "limit: 0, model: gemini-3-pro-image. Please retry in 82.94s.'}}")
    out = server.explain_provider_error(quota_zero, "gemini-3-pro-image")
    assert len(out) < len(quota_zero), "the explanation is longer than the error"
    assert "gemini-3-pro-image" in out and "plan" in out
    assert "RESOURCE_EXHAUSTED" not in out and "{" not in out

    # a real quota ceiling (not limit: 0) tells you how long to wait
    out = server.explain_provider_error("429 RESOURCE_EXHAUSTED. Please retry in 12.5s.", "m")
    assert "13s" in out, out

    assert "Vertex AI" in server.explain_provider_error("PERMISSION_DENIED default-cli-project")
    assert "credentials" in server.explain_provider_error("API_KEY_INVALID")

    # unknown errors are passed through, never hidden
    assert server.explain_provider_error("something nobody predicted") == "something nobody predicted"


def test_concept_art_accepts_every_google_credential():
    """Concept art goes through the GenAI SDK, which takes an API key, a service
    account OR the Antigravity/gemini-cli OAuth login. It used to only look for
    the first two, so an Antigravity-only user could paint but never generate a
    reference. The text path is narrower, so this must not widen _configured."""
    import providers as prov

    saved_env = {k: os.environ.pop(k, None) for k in ("GEMINI_API_KEY", "GOOGLE_API_KEY")}
    real_oauth = prov.GEMINI_OAUTH_PATH
    try:
        prov.GEMINI_OAUTH_PATH = Path(tempfile.mkdtemp()) / "oauth_creds.json"
        assert not prov.google_reachable(), "no credentials at all must not be reachable"
        assert prov.image_models() == [], "no credentials, no concept-art models"

        prov.GEMINI_OAUTH_PATH.write_text('{"access_token": "x", "refresh_token": "y"}')
        assert prov.google_reachable(), "OAuth alone must reach Google for concept art"
        assert prov.image_models(), "OAuth alone must offer concept-art models"

        os.environ["GEMINI_API_KEY"] = "k"
        assert prov.google_reachable()
    finally:
        prov.GEMINI_OAUTH_PATH = real_oauth
        os.environ.pop("GEMINI_API_KEY", None)
        for k, v in saved_env.items():
            if v is not None:
                os.environ[k] = v


def test_concept_art_dispatches_by_provider(monkeypatch):
    """Concept art used to call the Google SDK for whatever model you picked, so
    a non-Gemini id would have been handed to the wrong client. The handler must
    route on the provider's kind, and the OpenAI-compatible path must be generic
    enough that a new provider is config, not code."""
    import providers as prov

    # openai declares image models, so it must show up once a key exists
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    offered = prov.image_models()
    assert any(m.startswith("openai/") for m in offered), offered
    # Gemini's own image models are covered by the credentials test; here there
    # are none on purpose, which is exactly why a second provider had to exist.

    # the OpenAI path posts to the provider's own base_url, not a hardcoded host,
    # and decodes b64_json
    seen = {}

    class FakeResponse:
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def read(self):
            return json.dumps({"data": [{"b64_json": base64.b64encode(b"PNGDATA").decode()}]}).encode()

    def fake_urlopen(req, timeout=None):
        seen["url"] = req.full_url
        seen["auth"] = req.headers.get("Authorization")
        seen["body"] = json.loads(req.data)
        return FakeResponse()

    import urllib.request
    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    p_cfg = {"base_url": "https://example.test/v1", "api_key_env": "OPENAI_API_KEY"}
    out = server._image_via_openai(p_cfg, "gpt-image-2", "a dirt block")

    assert out == b"PNGDATA"
    assert seen["url"] == "https://example.test/v1/images/generations"
    assert seen["auth"] == "Bearer sk-test"
    assert seen["body"]["model"] == "gpt-image-2" and seen["body"]["prompt"] == "a dirt block"

    # a url-only reply must be refused, not silently fetched from a third host
    class UrlOnly(FakeResponse):
        def read(self):
            return json.dumps({"data": [{"url": "https://somewhere.test/x.png"}]}).encode()

    monkeypatch.setattr(urllib.request, "urlopen", lambda req, timeout=None: UrlOnly())
    try:
        server._image_via_openai(p_cfg, "gpt-image-2", "x")
        raise AssertionError("a url-only response must not be accepted")
    except RuntimeError as e:
        assert "URL" in str(e)


def test_free_providers_are_wired(monkeypatch):
    """The two free options, and the difference between them. Pollinations speaks
    OpenAI's own image endpoint so it must need no adapter at all; Cloudflare's
    OpenAI compatibility stops at chat, so it gets its own path and needs an
    account id on top of the token."""
    import providers as prov

    ids = {o["id"] for o in prov.image_model_options()}
    assert "pollinations/flux" in ids
    assert "cloudflare/@cf/black-forest-labs/flux-1-schnell" in ids

    # Pollinations rides the generic path: same base_url plumbing as OpenAI
    poll = prov.config()["providers"]["pollinations"]
    assert poll["base_url"].endswith("/v1"), "the generic path appends /images/generations"
    assert not poll.get("kind"), "declaring a kind would mean it needed an adapter"

    # Cloudflare: a token alone is not enough, and the reason says both names
    monkeypatch.setenv("CLOUDFLARE_API_TOKEN", "t")
    monkeypatch.delenv("CLOUDFLARE_ACCOUNT_ID", raising=False)
    cf = next(o for o in prov.image_model_options() if o["id"].startswith("cloudflare/"))
    assert not cf["available"] and "ACCOUNT_ID" in cf["reason"], cf
    monkeypatch.setenv("CLOUDFLARE_ACCOUNT_ID", "abc123")
    cf = next(o for o in prov.image_model_options() if o["id"].startswith("cloudflare/"))
    assert cf["available"], cf

    # and the adapter puts the model in the path and decodes result.image
    seen = {}

    class Reply:
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def read(self):
            return json.dumps({"success": True,
                               "result": {"image": base64.b64encode(b"JPEGBYTES").decode()}}).encode()

    import urllib.request
    monkeypatch.setattr(urllib.request, "urlopen",
                        lambda req, timeout=None: (seen.update(url=req.full_url,
                                                               body=json.loads(req.data)), Reply())[1])
    out = server._image_via_cloudflare(prov.config()["providers"]["cloudflare"],
                                       "@cf/black-forest-labs/flux-1-schnell", "a dirt block")
    assert out == b"JPEGBYTES"
    assert seen["url"].endswith("/accounts/abc123/ai/run/@cf/black-forest-labs/flux-1-schnell"), seen["url"]
    assert seen["body"]["prompt"] == "a dirt block"


def test_key_can_be_tested_before_it_is_saved(monkeypatch):
    """The only way to test a key used to be to save it first, so a wrong key
    landed in secrets.json and stayed there until you deleted it by hand. A
    candidate key must reach the provider and never reach disk."""
    import providers as prov

    sent = {}

    class Reply:
        status = 200
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def read(self): return json.dumps({"data": [{"id": "m-1"}]}).encode()

    # test_connection probes AND then lists models — both calls must carry the
    # candidate, so collect every one instead of only the last.
    seen_auth = []
    import urllib.request
    def fake_urlopen(req, timeout=None):
        seen_auth.append(req.headers.get("Authorization"))
        return Reply()
    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)

    before = prov.SECRETS_PATH.read_text() if prov.SECRETS_PATH.exists() else None
    r = c.post("/api/providers/deepseek/test", json={"key": "sk-candidate-9999"})
    assert r.status_code == 200, r.text
    assert seen_auth, "the provider was never contacted"
    assert all(a == "Bearer sk-candidate-9999" for a in seen_auth), \
        f"a call used the stored key instead of the candidate: {seen_auth}"

    after = prov.SECRETS_PATH.read_text() if prov.SECRETS_PATH.exists() else None
    assert after == before, "testing a key must not write it to disk"
    assert "sk-candidate-9999" not in (after or ""), "the candidate key was persisted"

    # no body at all still means "test whatever is stored"
    assert c.post("/api/providers/deepseek/test").status_code == 200


def test_llm_clients_cannot_hang_forever():
    """A model call with no timeout hung the whole generation: the SSE keepalive
    kept the UI saying "painting", the worker thread stayed alive, and only a
    server restart got you out. Every client must carry a finite deadline."""
    try:
        import agent, inspect
    except ImportError as e:
        print(f"  (skipped timeout check: {e})")
        return

    src = inspect.getsource(agent._get_llm)
    # every client constructed in here has to take the deadline
    made = src.count("ChatOpenAI(") + src.count("ChatGoogleGenerativeAI(") + src.count("ChatVertexAI(")
    assert made >= 3, "the client list changed — re-check the timeouts"
    assert src.count("LLM_TIMEOUT") >= made - 1, \
        f"{made} clients built but only {src.count('LLM_TIMEOUT')} carry a timeout"

    assert agent.LLM_TIMEOUT > 0
    # generous on purpose: a 4B model on a laptop can take minutes on one call
    assert agent.LLM_TIMEOUT >= 300, "too tight — this would kill legitimate local runs"


def test_local_models_do_not_think_themselves_to_death():
    """Ollama enables thinking by default. A 4B model on a 4k context can spend
    its whole budget reasoning and never emit one tool call — the run logs
    "start" and then nothing, forever. Only local providers get the switch;
    a cloud model's reasoning is worth paying for."""
    try:
        import agent, inspect
    except ImportError as e:
        print(f"  (skipped thinking check: {e})")
        return
    import providers as prov

    src = inspect.getsource(agent._get_llm)
    assert '"reasoning_effort": "none"' in src, "thinking is never switched off"
    assert "extra_body" in src, "reasoning_effort must ride in extra_body, not a named param"

    cfg = prov.config()["providers"]
    assert prov.is_local(cfg["ollama"]) and prov.is_local(cfg["lmstudio"])
    for paid in ("deepseek", "groq", "openai", "gemini"):
        assert not prov.is_local(cfg[paid]), f"{paid} would lose its reasoning"


def test_the_silent_window_reports_itself():
    """Activity said "start" and then nothing for as long as the model took,
    which reads exactly like a hang. The stream already knew how long it had
    been waiting — it was spending that knowledge on a silent SSE comment."""
    import inspect
    src = inspect.getsource(server._run_agent_sse)

    assert ": keepalive" not in src, "the silent comment is back"
    assert '"step": "waiting"' in src, "the wait is not reported"
    # the two silences are different problems and must not read the same
    assert "first reply" in src and "steps so far" in src

    # and the start line has to name what the model was handed, not just the
    # size and model you can already see in the UI
    assert "tools ·" in src and "colours" in src, "start line still says nothing useful"


def test_input_validation():
    """Bad hex colors and bad tileset names are rejected at the boundary (422),
    not deep in a handler with a 500."""
    # non-hex color
    r = c.post("/api/generate", json={"prompt": "x", "colors": ["red"], "size": 16})
    assert r.status_code == 422, r.text
    # empty palette color
    r = c.post("/api/palettes", json={"name": "bad", "colors": [""]})
    assert r.status_code == 422, r.text
    # valid hex still accepted
    r = c.post("/api/palettes", json={"name": "ok", "colors": ["#aabbcc"]})
    assert r.status_code == 200, r.text
    c.delete(f"/api/palettes/{r.json()['id']}")
    # tileset name with traversal
    r = c.post("/api/tileset", json={"generation_id": 1, "name": "../evil"})
    assert r.status_code == 422, r.text
