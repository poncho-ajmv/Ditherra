"""
Provider registry — every model the app can use comes from providers.json.

Nothing is hardcoded. Almost every AI service (Ollama, LM Studio, vLLM,
DeepSeek, Qwen, GLM, Kimi, Groq, OpenRouter…) speaks the OpenAI protocol, so
"adding a provider" is a base_url and a key, not code.

Secrets never live in providers.json: it names an env var, .env holds the value.
A provider whose key is missing simply doesn't appear — you can't pick a model
you have no credentials for.

Model ids are namespaced `provider/model` so two providers can offer the same
model name (deepseek-chat direct vs through OpenRouter, say).
"""

import json
import os
import tempfile
import time
import urllib.error
import urllib.request
from fnmatch import fnmatch
from pathlib import Path

import codex_app_server

CONFIG_PATH = Path(__file__).parent / "providers.json"

# Keys saved from the settings panel. Same shape as .env — env var name to value —
# so moving a key between the two is copy-paste. Gitignored, chmod 600.
# Saved API keys live with the rest of the app's data, so DITHERRA_DATA moves
# them too — which is what keeps the test suite from reading (or worse, writing)
# the developer's real keys.
SECRETS_PATH = Path(os.getenv("DITHERRA_DATA") or Path(__file__).parent) / "secrets.json"

_DISCOVERY_TTL = 60  # seconds
_discovery_cache: dict[str, tuple[float, list[dict]]] = {}


def config() -> dict:
    if not CONFIG_PATH.exists():
        return {"providers": {}}
    return json.loads(CONFIG_PATH.read_text())


GEMINI_OAUTH_PATH = Path(os.path.expanduser("~/.gemini/oauth_creds.json"))


def gemini_oauth_credentials():
    """Credentials from the Antigravity / gemini-cli login, or None.

    The fourth way to reach Google, after an API key, a service account and
    plain ADC — and the one a user who only signed in with Antigravity has.
    The agent already knew how to read this file; concept art didn't, so an
    Antigravity-only setup could paint but never generate a reference.
    """
    if not GEMINI_OAUTH_PATH.exists():
        return None
    try:
        from google.oauth2.credentials import Credentials
        d = json.loads(GEMINI_OAUTH_PATH.read_text())
        return Credentials(
            token=d.get("access_token"),
            refresh_token=d.get("refresh_token"),
            token_uri="https://oauth2.googleapis.com/token",
            client_id=d.get("client_id"),
            client_secret=d.get("client_secret"),
        )
    except Exception:
        return None


def gemini_oauth_project() -> str:
    return os.getenv("ANTIGRAVITY_PROJECT_ID", "default-cli-project")


def google_service_account() -> str | None:
    """Locate the Google service account, export it, and return its project id.

    Three places needed this — server startup, the Gemini image client and the
    Vertex branch of the agent — and each had its own copy of "look here, then
    there, then read project_id". Returns None when there's no service account,
    which is the normal case for an API-key setup.
    """
    # Inline JSON, for containers where you can't drop a file in.
    content = os.getenv("GOOGLE_SERVICE_ACCOUNT_JSON_CONTENT")
    if content:
        tmp = Path(tempfile.gettempdir()) / "ditherra-service-account.json"
        tmp.write_text(content)
        os.chmod(tmp, 0o600)
        os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = str(tmp)
        return json.loads(content).get("project_id")

    name = os.getenv("GOOGLE_SERVICE_ACCOUNT_JSON", "service-account.json")
    for candidate in (Path(os.getenv("GOOGLE_APPLICATION_CREDENTIALS", "")), Path(name),
                      Path(__file__).parent / name):
        if candidate.name and candidate.is_file():
            os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = str(candidate.resolve())
            try:
                return json.loads(candidate.read_text()).get("project_id")
            except Exception:
                return None
    return None


def _saved_keys() -> dict[str, str]:
    if not SECRETS_PATH.exists():
        return {}
    try:
        return json.loads(SECRETS_PATH.read_text())
    except Exception:
        return {}


def _env_names(p: dict) -> list[str]:
    return [e.strip() for e in (p.get("api_key_env") or "").split(",") if e.strip()]


def api_key(p: dict) -> str | None:
    """Resolve a provider's key. None means unconfigured.

    The environment wins over the saved file so a .env, a shell export or a
    container secret always overrides whatever the settings panel stored.
    """
    if p.get("api_key"):
        return p["api_key"]
    saved = _saved_keys()
    for env in _env_names(p):
        if os.getenv(env):
            return os.getenv(env)
        if saved.get(env):
            return saved[env]
    return None


def save_key(env_name: str, value: str) -> None:
    """Store a key under its env var name. Owner-readable only."""
    keys = _saved_keys()
    keys[env_name] = value
    SECRETS_PATH.write_text(json.dumps(keys, indent=2) + "\n")
    os.chmod(SECRETS_PATH, 0o600)


def forget_key(env_name: str) -> None:
    keys = _saved_keys()
    if keys.pop(env_name, None) is not None:
        SECRETS_PATH.write_text(json.dumps(keys, indent=2) + "\n")
        os.chmod(SECRETS_PATH, 0o600)


def status() -> list[dict]:
    """Everything the settings panel needs — and never the key itself.

    `hint` is the last four characters, enough to tell two keys apart without
    handing the whole thing back to the browser.
    """
    out = []
    for name, p in config().get("providers", {}).items():
        envs = _env_names(p)
        key = api_key(p)
        from_env = any(os.getenv(e) for e in envs)
        is_conf = _configured(p)
        kind = p.get("kind", "openai")
        codex_account = {}
        if kind == "codex":
            if codex_app_server.has_cached_login():
                try:
                    codex_account = codex_app_server.account_status()
                except Exception as exc:
                    codex_account = {"configured": False, "error": str(exc)}
            is_conf = bool(codex_account.get("configured"))
        found = _models_of(name, p) if is_conf else []
        out.append({
            "name": name,
            "kind": kind,
            "note": p.get("note", ""),
            # Where to go when it isn't usable yet: an installer for the local
            # ones, the page that mints a key for the rest. A provider that says
            # "no key" without saying where to get one is a dead end.
            "setup_url": p.get("setup_url"),
            # Installing Ollama gives you an empty Ollama. This is the command
            # that actually makes it usable, and nothing was telling you.
            "setup_cmd": p.get("setup_cmd"),
            "needs_key": bool(envs),
            "key_env": envs[0] if envs else None,
            "configured": is_conf,
            "hint": (codex_account.get("email") if kind == "codex" else
                     "OAuth" if kind == "antigravity" else
                     key[-4:] if key and envs else None),
            "locked": from_env,  # set in the environment: the panel can't override it
            # OAuth/SDK accounts are remote services even when they do not use
            # a conventional API-key field. Only actual on-device endpoints
            # belong under "Local · free" in Settings.
            "local": kind not in ("codex", "antigravity") and not envs,
            "models": len(found),
            "vision_models": sum(1 for m in found if m["vision"]),
            "account_email": codex_account.get("email"),
            "account_plan": codex_account.get("plan"),
            "error": codex_account.get("error"),
        })
    return out


def test_connection(name: str, candidate_key: str | None = None) -> dict:
    """Actually talk to a provider and say what happened.

    `candidate_key` probes a key that hasn't been saved yet. It is used for this
    one request and never written anywhere: a key that fails should not end up
    in secrets.json, which is exactly what happened when the only way to test
    one was to save it first.

    Returns a code, not a sentence — the UI owns the wording so the diagnosis
    lands in the user's language. The codes distinguish the failures that need
    different fixes: nothing listening (start Ollama) is not the same problem as
    a rejected key, which is not the same as a URL that isn't an OpenAI API.
    """
    p = config().get("providers", {}).get(name)
    if p is None:
        raise KeyError(name)
    if p.get("kind") == "antigravity":
        is_conf = _configured(p)
        return {
            "code": "ok" if is_conf else "no_key",
            "configured": is_conf,
            "models": 2 if is_conf else 0,
            "tool_models": 2 if is_conf else 0,
            "vision_models": 2 if is_conf else 0,
            "sample": ["antigravity/antigravity-flash", "antigravity/antigravity-pro"],
        }
    if p.get("kind") == "codex":
        try:
            account = codex_app_server.account_status()
            if not account.get("configured"):
                return {"code": "no_key", "configured": False}
            found = codex_app_server.models()
            return {
                "code": "ok" if found else "no_models",
                "configured": True,
                "models": len(found),
                "tool_models": len(found),
                "vision_models": sum(1 for m in found if m["vision"]),
                "sample": [f"codex/{m['id']}" for m in found[:3]],
            }
        except Exception as exc:
            return {"code": "error", "detail": str(exc)}
    if not p.get("base_url"):
        # Gemini via the Google SDK has no /models endpoint to probe here.
        return {"code": "no_endpoint", "configured": (candidate_key or api_key(p)) is not None}

    key = candidate_key or api_key(p)
    if _env_names(p) and key is None:
        return {"code": "no_key"}

    url = p["base_url"].rstrip("/") + "/models"
    headers = {"User-Agent": "ditherra/1.0"}
    if key:
        headers["Authorization"] = f"Bearer {key}"
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=8) as r:
            data = json.load(r)
    except urllib.error.HTTPError as e:
        return {"code": {401: "unauthorized", 403: "unauthorized", 404: "not_found"}.get(e.code, "error"),
                "detail": f"HTTP {e.code}"}
    except urllib.error.URLError as e:
        reason = str(getattr(e, "reason", e))
        return {"code": "timeout" if "timed out" in reason.lower() else "refused", "detail": reason}
    except Exception as e:
        return {"code": "error", "detail": str(e)}

    entries = [m for m in data.get("data", []) if m.get("id")]
    if not entries:
        return {"code": "no_models", "models": 0, "tool_models": 0, "vision_models": 0}

    _discovery_cache.pop(name, None)   # a successful probe should refresh the dropdown
    usable = _discover(p, candidate_key)   # same rules the dropdown uses
    return {
        "code": "ok",
        "models": len(entries),
        "tool_models": sum(1 for m in usable if m["tools"]),
        "vision_models": sum(1 for m in usable if m["vision"]),
        "sample": [m["id"] for m in usable[:3]],
    }


def _configured(p: dict) -> bool:
    """A provider is usable if it needs no key (local) or its key is present."""
    if p.get("kind") == "antigravity":
        creds_path = Path(os.path.expanduser("~/.gemini/oauth_creds.json"))
        saved = _saved_keys()
        gkey = (os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY")
                or saved.get("GEMINI_API_KEY") or saved.get("GOOGLE_API_KEY"))
        return creds_path.exists() or gkey is not None
    if p.get("kind") == "codex":
        if not codex_app_server.has_cached_login():
            return False
        try:
            return bool(codex_app_server.account_status().get("configured"))
        except Exception:
            return False
    return not p.get("api_key_env") or api_key(p) is not None


def _discover(p: dict, candidate_key: str | None = None) -> list[dict]:
    """Ask an OpenAI-compatible endpoint what it serves, and what each model can do.

    Returns [{id, vision, tools}]. Capability comes from the endpoint when it
    reports any — OpenRouter publishes `architecture.input_modalities` and
    `supported_parameters` per model — and falls back to the provider default
    otherwise. `vision_match` covers endpoints that report nothing: Ollama's
    /v1/models is a bare list, but its names are honest (llava, qwen2.5-vl,
    llama3.2-vision), so a glob is the whole solution.

    Failure is normal — Ollama may just not be running — so it returns [] and the
    provider quietly disappears instead of breaking the app.
    """
    url = p["base_url"].rstrip("/") + "/models"
    # candidate_key: probing a key that isn't saved yet. Without threading it
    # here the capability counts came back from an unauthenticated call, so a
    # valid key reported "0 models" and looked broken.
    key = candidate_key or api_key(p)
    headers = {"User-Agent": "ditherra/1.0"}
    if key:
        headers["Authorization"] = f"Bearer {key}"
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            data = json.load(r)
    except Exception:
        return []

    default_vision = bool(p.get("vision", False))
    patterns = p.get("vision_match") or []
    needs = set(p.get("requires") or [])

    found = []
    for m in data.get("data", []):
        mid = m.get("id")
        if not mid:
            continue
        params = m.get("supported_parameters")
        if needs and params is not None and not needs <= set(params):
            continue

        modalities = (m.get("architecture") or {}).get("input_modalities")
        if modalities is not None:
            vision = "image" in modalities
        elif patterns:
            vision = any(fnmatch(mid.lower(), pat.lower()) for pat in patterns)
        else:
            vision = default_vision

        found.append({
            "id": mid,
            "vision": vision,
            "tools": "tools" in params if params is not None else True,
        })
    return sorted(found, key=lambda m: m["id"])


def _declared(p: dict) -> list[dict]:
    """Normalize compact string entries and per-model capability overrides."""
    default_vision = bool(p.get("vision", False))
    found = []
    for entry in p.get("models", []):
        if isinstance(entry, str):
            found.append({"id": entry, "vision": default_vision, "tools": True})
        elif isinstance(entry, dict) and entry.get("id"):
            found.append({
                "id": entry["id"],
                "vision": bool(entry.get("vision", default_vision)),
                "tools": bool(entry.get("tools", True)),
            })
    return found


def _models_of(name: str, p: dict) -> list[dict]:
    """[{id, vision, tools}] for one provider, discovered or declared."""
    if p.get("kind") == "codex":
        try:
            return codex_app_server.models()
        except Exception:
            return []
    if not p.get("discover"):
        return _declared(p)
    # ponytail: 60s TTL so a locally started Ollama shows up without a restart.
    hit = _discovery_cache.get(name)
    if hit and time.time() - hit[0] < _DISCOVERY_TTL:
        return hit[1]
    found = _discover(p) or _declared(p)
    _discovery_cache[name] = (time.time(), found)
    return found


def available() -> dict[str, list[dict]]:
    """{provider_name: [{id, vision, tools}]} for providers that are usable."""
    return {
        name: found
        for name, p in config().get("providers", {}).items()
        if _configured(p) and (found := _models_of(name, p))
    }


def models() -> list[str]:
    """Flat list of `provider/model` ids for the UI dropdown."""
    return [f"{name}/{m['id']}" for name, ms in available().items() for m in ms]


def capabilities() -> dict[str, dict]:
    """`provider/model` -> {vision, tools}, so the UI can say what each one does."""
    return {f"{name}/{m['id']}": {"vision": m["vision"], "tools": m["tools"]}
            for name, ms in available().items() for m in ms}


def resolve(model_id: str) -> tuple[str, dict, str]:
    """`provider/model` -> (provider_name, provider_config, bare_model_name).

    Bare names without a slash are also accepted so generations saved before
    namespacing existed still load.
    """
    provs = config().get("providers", {})
    if "/" in model_id:
        name, _, bare = model_id.partition("/")
        if name in provs:
            return name, provs[name], bare
    for name, ms in available().items():
        if any(m["id"] == model_id for m in ms):
            return name, provs[name], model_id
    raise ValueError(f"unknown model: {model_id!r}. Configured: {models() or 'none'}")


def has_vision(model_id: str) -> bool:
    """Whether to send the canvas as a base64 image alongside the text grid.

    Defaults to False: sending an image to a text-only model breaks the request,
    while withholding it from a vision model just makes it work slightly harder.
    """
    cap = capabilities().get(model_id)
    if cap is not None:
        return cap["vision"]
    try:
        return bool(resolve(model_id)[1].get("vision", False))
    except ValueError:
        return False


def default_model() -> str | None:
    """The user's configured default, or None when they have not chosen one."""
    preferred = config().get("default")
    return preferred if preferred and preferred in models() else None


def save_default(model_id: str | None) -> None:
    """Persist the user's preferred default model into providers.json (empty
    clears it, so the UI requires an explicit model selection)."""
    cfg = config()
    if model_id:
        cfg["default"] = model_id
    else:
        cfg.pop("default", None)
    CONFIG_PATH.write_text(json.dumps(cfg, indent=2) + "\n")


def is_local(p: dict) -> bool:
    """Runs on this machine: no key, not an account-backed service."""
    return p.get("kind", "openai") not in ("codex", "antigravity", "gemini") and not _env_names(p)


def google_reachable() -> bool:
    """True if ANY Google credential is present: key, service account or OAuth.

    Deliberately broader than _configured("gemini"), and only used for concept
    art. The image endpoint goes through the GenAI SDK, which takes all three;
    the text path goes through LangChain, which in this codebase only knows the
    key and the service account. Widening _configured would therefore offer
    Gemini *text* models to an OAuth-only user and fail at generation time.
    """
    saved = _saved_keys()
    if (os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY")
            or saved.get("GEMINI_API_KEY") or saved.get("GOOGLE_API_KEY")):
        return True
    return bool(google_service_account()) or GEMINI_OAUTH_PATH.exists()


def _missing_for(p: dict) -> str:
    """What exactly is missing, named precisely enough to act on."""
    if p.get("kind") == "cloudflare":
        parts = [n for n, ok in (("CLOUDFLARE_API_TOKEN", api_key(p)),
                                 ("CLOUDFLARE_ACCOUNT_ID", cloudflare_account())) if not ok]
        return "needs " + " + ".join(parts)
    if p.get("kind") == "gemini":
        return "needs a Google key or Antigravity sign-in"
    return "needs " + (p.get("api_key_env") or "a key").split(",")[0]


def cloudflare_account() -> str | None:
    """Cloudflare account id. Not a secret — it's in every dashboard URL — but
    the API needs it in the path, so it's a second thing to configure."""
    return os.getenv("CLOUDFLARE_ACCOUNT_ID") or _saved_keys().get("CLOUDFLARE_ACCOUNT_ID")


def _image_provider_ready(p: dict) -> bool:
    if p.get("kind") == "gemini":
        return google_reachable()
    # Cloudflare needs a token AND an account id; a token alone would render as
    # available and then fail on use.
    if p.get("kind") == "cloudflare":
        return bool(api_key(p)) and bool(cloudflare_account())
    return _configured(p)


def image_models() -> list[str]:
    """Concept-art models you can actually use right now."""
    return [o["id"] for o in image_model_options() if o["available"]]


def image_model_options() -> list[dict]:
    """Every declared concept-art model, available or not, with the reason.

    Filtering the unusable ones out of the list entirely made the feature
    invisible: adding an OpenAI key grew the dropdown from four entries to
    seven with nothing anywhere saying that was possible. Showing them greyed
    out with what's missing turns the dropdown into the answer.
    """
    out = []
    for name, p in config().get("providers", {}).items():
        for m in p.get("image_models", []):
            ready = _image_provider_ready(p)
            out.append({
                "id": f"{name}/{m}",
                "available": ready,
                "reason": "" if ready else _missing_for(p),
            })
    return out


def google_credential_kind() -> str | None:
    """Which Google credential concept art would use: key, service account or
    the Antigravity/gemini-cli login. Shown in the UI so an Antigravity user can
    see that the gemini/* entries are reachable through their own sign-in."""
    saved = _saved_keys()
    if (os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY")
            or saved.get("GEMINI_API_KEY") or saved.get("GOOGLE_API_KEY")):
        return "key"
    if google_service_account():
        return "service account"
    if GEMINI_OAUTH_PATH.exists():
        return "antigravity"
    return None


def default_image_model() -> str | None:
    imgs = image_models()
    return imgs[0] if imgs else None


def gemini_live_models() -> set[str]:
    """Model ids the configured Gemini key can actually see, or an empty set.

    Declared ids rot: providers.json once pointed at gemini-3.1-flash-image-preview
    for months after Google shut it down, and the only symptom was concept art
    failing at generation time with a provider error. `python providers.py` diffs
    this against what's declared so the rot is visible before it bites.
    """
    p = config().get("providers", {}).get("gemini") or {}
    key = api_key(p)
    if not key:
        return set()
    try:
        req = urllib.request.Request(
            "https://generativelanguage.googleapis.com/v1beta/models?pageSize=200",
            headers={"x-goog-api-key": key})
        with urllib.request.urlopen(req, timeout=10) as r:
            data = json.load(r)
    except Exception:
        return set()   # offline, or the key can't list — not this function's problem
    return {m["name"].split("/")[-1] for m in data.get("models", [])}


if __name__ == "__main__":
    cfg = config()
    print(f"providers.json: {len(cfg.get('providers', {}))} declarados\n")
    for name, p in cfg.get("providers", {}).items():
        if not _configured(p):
            print(f"  {name:12} — sin configurar (falta {p.get('api_key_env')})")
            continue
        ms = _models_of(name, p)
        how = "descubiertos" if p.get("discover") else "declarados"
        # _models_of returns [{id, vision, tools}], not bare strings — joining the
        # dicts raised TypeError and took this whole check down with it.
        ids = ", ".join(m["id"] for m in ms[:4])
        print(f"  {name:12} — {len(ms)} modelos {how}" + (f": {ids}" if ms else " (endpoint no responde)"))
    print(f"\ntotal usable: {len(models())} modelos | default: {default_model()}")
    print(f"concept art: {image_models() or 'ninguno'}")

    # Declared vs. alive. A dead id here is invisible until a generation fails,
    # so surface it in the check the README already tells you to run.
    live = gemini_live_models()
    gem = config().get("providers", {}).get("gemini") or {}
    declared = list(gem.get("models", [])) + list(gem.get("image_models", []))
    if not live:
        print("\n(no pude listar los modelos vivos de Gemini — sin key, sin red, o la key no puede listar)")
    elif declared:
        dead = [m for m in declared if m not in live]
        print(f"\nchequeo contra la API de Gemini: {len(declared) - len(dead)}/{len(declared)} declarados siguen vivos")
        for m in dead:
            print(f"  MUERTO  {m}  — sacalo de providers.json")
        extra = sorted(m for m in live if "image" in m and m not in declared)
        if extra:
            print(f"  disponibles y no declarados: {', '.join(extra)}")
