"""Provider catalog + key verification."""

from __future__ import annotations

import json
import os
from typing import Any
from urllib.parse import urlparse

from clawagents.provider_profiles import BUILTIN_PROVIDER_PROFILES, load_provider_profiles

from pricing import attach_prices
from url_trust import is_trusted_base_url


_CATALOG: list[dict[str, Any]] = [
    {
        "id": "openai",
        "name": "OpenAI",
        "env_key": "OPENAI_API_KEY",
        "models": [
            # GPT-5.6 family (current flagship ladder)
            {"id": "gpt-5.6-sol", "label": "GPT-5.6 Sol"},
            {"id": "gpt-5.6-terra", "label": "GPT-5.6 Terra"},
            {"id": "gpt-5.6-luna", "label": "GPT-5.6 Luna"},
            {"id": "gpt-5.6", "label": "GPT-5.6 (alias → Sol)"},
            # GPT-5.5
            {"id": "gpt-5.5", "label": "GPT-5.5"},
            {"id": "gpt-5.5-pro", "label": "GPT-5.5 Pro"},
            # GPT-5.4
            {"id": "gpt-5.4", "label": "GPT-5.4"},
            {"id": "gpt-5.4-mini", "label": "GPT-5.4 mini"},
            {"id": "gpt-5.4-nano", "label": "GPT-5.4 nano"},
            {"id": "gpt-5.4-pro", "label": "GPT-5.4 Pro"},
            {"id": "gpt-4o", "label": "GPT-4o"},
        ],
    },
    {
        "id": "anthropic",
        "name": "Anthropic",
        "env_key": "ANTHROPIC_API_KEY",
        "models": [
            {"id": "claude-sonnet-4-5", "label": "Claude Sonnet 4.5"},
            {"id": "claude-opus-4-6", "label": "Claude Opus 4.6"},
            {"id": "claude-haiku-4-5-20251001", "label": "Claude Haiku 4.5"},
        ],
    },
    {
        "id": "gemini",
        "name": "Google Gemini",
        "env_key": "GEMINI_API_KEY",
        "models": [
            {"id": "gemini-3.5-flash", "label": "Gemini 3.5 Flash"},
            {"id": "gemini-3.1-pro-preview", "label": "Gemini 3.1 Pro"},
            {"id": "gemini-3.1-flash-lite", "label": "Gemini 3.1 Flash-Lite"},
            {"id": "gemini-3-flash-preview", "label": "Gemini 3 Flash (preview)"},
            {"id": "gemini-2.5-pro", "label": "Gemini 2.5 Pro"},
            {"id": "gemini-2.5-flash", "label": "Gemini 2.5 Flash"},
        ],
    },
    {
        "id": "ollama",
        "name": "Ollama (local)",
        "env_key": None,
        "base_url": "http://localhost:11434/v1",
        "models": [
            {"id": "llama3.1", "label": "Llama 3.1"},
        ],
    },
    {
        "id": "bedrock",
        "name": "AWS Bedrock",
        # Native IAM uses AWS credential chain (no gateway key).
        # BEDROCK_API_KEY is only for optional OpenAI-compatible gateway (BAG).
        "env_key": "BEDROCK_API_KEY",
        "base_url": "",
        "models": [
            {
                "id": "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
                "label": "Claude Sonnet 4.5 (US)",
            },
            {
                "id": "us.anthropic.claude-opus-4-6-20251101-v1:0",
                "label": "Claude Opus 4.6 (US)",
            },
            {
                "id": "us.anthropic.claude-haiku-4-5-20251001-v1:0",
                "label": "Claude Haiku 4.5 (US)",
            },
            {
                "id": "anthropic.claude-3-5-sonnet-20241022-v2:0",
                "label": "Claude 3.5 Sonnet v2",
            },
            {"id": "amazon.nova-pro-v1:0", "label": "Amazon Nova Pro"},
            {"id": "amazon.nova-lite-v1:0", "label": "Amazon Nova Lite"},
            {"id": "amazon.nova-micro-v1:0", "label": "Amazon Nova Micro"},
            {"id": "amazon.nova-premier-v1:0", "label": "Amazon Nova Premier"},
            {"id": "meta.llama3-3-70b-instruct-v1:0", "label": "Llama 3.3 70B"},
            {"id": "meta.llama3-1-70b-instruct-v1:0", "label": "Llama 3.1 70B"},
            {"id": "meta.llama3-1-8b-instruct-v1:0", "label": "Llama 3.1 8B"},
            {"id": "mistral.mistral-large-2407-v1:0", "label": "Mistral Large"},
            {"id": "openai.gpt-oss-120b-1:0", "label": "GPT-OSS 120B"},
            {"id": "openai.gpt-oss-20b-1:0", "label": "GPT-OSS 20B"},
        ],
    },
]

# Non-chat IDs from OpenAI-compatible /models lists.
_NON_CHAT_MODEL_HINTS = (
    "embedding",
    "whisper",
    "tts-",
    "tts_",
    "dall-e",
    "moderation",
    "transcribe",
    "realtime",
    "image-",
    "davinci",
    "babbage",
    "curie",
    "ada-",
)


def _has_aws_credentials() -> bool:
    """True when native Bedrock can use the AWS credential chain.

    Region alone is not enough — that used to mark Bedrock "available" for
    everyone with ``AWS_REGION`` set and flooded the model dropdown.
    """
    if os.environ.get("AWS_ACCESS_KEY_ID") and os.environ.get("AWS_SECRET_ACCESS_KEY"):
        return True
    if os.environ.get("AWS_PROFILE") or os.environ.get("AWS_DEFAULT_PROFILE"):
        return True
    # Shared credentials file under $HOME (common local setup).
    home = os.path.expanduser("~")
    creds = os.path.join(home, ".aws", "credentials")
    if os.path.isfile(creds) and os.path.getsize(creds) > 0:
        return True
    return False


def _ollama_reachable() -> bool:
    """True when a local Ollama daemon answers quickly."""
    import urllib.request

    try:
        urllib.request.urlopen("http://127.0.0.1:11434/api/tags", timeout=0.35)
        return True
    except Exception:  # noqa: BLE001 — offline / refused ⇒ not available
        return False


def _provider_credentials_present(provider_id: str, env_key: str | None) -> bool:
    """Whether this provider has local credentials (before live probe)."""
    if provider_id == "ollama":
        return _ollama_reachable()
    if env_key is None:
        return True
    if env_key == "GEMINI_API_KEY":
        return bool(os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY"))
    if env_key == "BEDROCK_API_KEY":
        # Do NOT treat OPENAI_API_KEY as Bedrock access — that listed every
        # Bedrock model whenever OpenAI was configured.
        return bool(os.environ.get("BEDROCK_API_KEY") or _has_aws_credentials())
    return bool(os.environ.get(str(env_key)))


def _settings_base_url() -> tuple[str, bool]:
    """Return (trusted base_url or '', ssl_verify) from vscode settings."""
    try:
        from settings_store import load_settings

        settings = load_settings()
    except Exception:  # noqa: BLE001
        return "", True
    raw = str(settings.get("base_url") or "").strip()
    ssl_verify = settings.get("ssl_verify", True) is not False
    if not raw:
        return "", ssl_verify
    if is_trusted_base_url(raw) or settings.get("trust_custom_base_url"):
        return raw.rstrip("/"), ssl_verify
    return "", ssl_verify


def _ssl_context(ssl_verify: bool) -> Any:
    import ssl

    if not ssl_verify:
        return ssl._create_unverified_context()
    try:
        import certifi

        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        return ssl.create_default_context()


def _http_get_json(
    url: str,
    *,
    headers: dict[str, str] | None = None,
    ssl_verify: bool = True,
    timeout: float = 8.0,
) -> Any:
    import urllib.request

    req = urllib.request.Request(url, headers=headers or {})
    with urllib.request.urlopen(
        req, timeout=timeout, context=_ssl_context(ssl_verify)
    ) as resp:
        return json.loads(resp.read().decode("utf-8", "replace"))


def _looks_like_chat_model(model_id: str) -> bool:
    mid = (model_id or "").strip().lower()
    if not mid:
        return False
    return not any(h in mid for h in _NON_CHAT_MODEL_HINTS)


def _fetch_compatible_models(
    base_url: str,
    key: str,
    *,
    ssl_verify: bool = True,
) -> list[dict[str, Any]]:
    """GET ``{base_url}/models`` and return chat-ish ``{id,label}`` rows."""
    url = f"{base_url.rstrip('/')}/models"
    headers: dict[str, str] = {}
    if key:
        headers["Authorization"] = f"Bearer {key}"
    data = _http_get_json(url, headers=headers, ssl_verify=ssl_verify, timeout=12.0)
    rows = data.get("data") if isinstance(data, dict) else data
    if not isinstance(rows, list):
        return []
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for row in rows:
        if not isinstance(row, dict):
            continue
        mid = str(row.get("id") or "").strip()
        if not mid or mid in seen or not _looks_like_chat_model(mid):
            continue
        seen.add(mid)
        out.append({"id": mid, "label": mid})
    out.sort(key=lambda m: m["id"].lower())
    return out


def _probe_compatible_endpoint(
    base_url: str,
    key: str,
    *,
    ssl_verify: bool = True,
) -> tuple[bool, str, list[dict[str, Any]]]:
    """Live-check an OpenAI-compatible ``/models`` and return models on success."""
    import ssl
    import urllib.error

    try:
        models = _fetch_compatible_models(base_url, key, ssl_verify=ssl_verify)
    except Exception as exc:  # noqa: BLE001
        # Private-CA corporate gateways often fail default verify even when the
        # Settings checkbox is still on — retry once without verify.
        if ssl_verify and isinstance(exc, (ssl.SSLError, urllib.error.URLError)):
            try:
                models = _fetch_compatible_models(base_url, key, ssl_verify=False)
                host = urlparse(base_url).netloc or base_url
                if models:
                    return (
                        True,
                        f"Key valid — {len(models)} models from {host} (TLS verify skipped)",
                        models,
                    )
                return True, f"Key valid at {host} (TLS verify skipped; no chat models)", []
            except Exception as retry_exc:  # noqa: BLE001
                exc = retry_exc
        if isinstance(exc, urllib.error.HTTPError) and exc.code in (400, 401, 403):
            return False, f"Key REJECTED by endpoint (HTTP {exc.code})", []
        msg = str(exc).encode("ascii", "replace").decode("ascii")
        return False, f"Endpoint check failed ({type(exc).__name__}: {msg})", []
    host = urlparse(base_url).netloc or base_url
    if models:
        return True, f"Key valid — {len(models)} models from {host}", models
    return True, f"Key valid at {host} (no chat models listed)", []


def build_provider_catalog(*, probe_keys: bool = True) -> list[dict[str, Any]]:
    """Build the sidebar provider/model catalog.

    ``available`` means credentials are present and (when ``probe_keys``) a
    cheap live check did not reject the key. The chat model dropdown only
    lists models from available providers.

    When Settings ``base_url`` is a trusted OpenAI-compatible endpoint, OpenAI
    (and Bedrock gateway mode) probe/list models from that host instead of
    api.openai.com.
    """
    settings_base, ssl_verify = _settings_base_url()
    out: list[dict[str, Any]] = []
    for p in _CATALOG:
        env_key = p.get("env_key")
        ek: str | None = env_key if env_key is None or isinstance(env_key, str) else str(env_key)
        available = _provider_credentials_present(str(p["id"]), ek)
        models = list(p["models"])
        pid = str(p["id"])

        # Custom OpenAI-compatible base URL (Settings) → probe + list that host.
        use_custom = bool(settings_base and pid == "openai")

        if use_custom and available:
            key = _sanitize_api_key(os.environ.get("OPENAI_API_KEY"))
            ok, _detail, remote_models = _probe_compatible_endpoint(
                settings_base, key or "", ssl_verify=ssl_verify
            )
            # Key is present — never flip to "(no key)" just because the gateway
            # probe failed (TLS, timeout). Prefer remote /models when it works.
            if ok and remote_models:
                models = remote_models
        elif available and probe_keys and pid in ("openai", "anthropic", "gemini"):
            checked = verify_api_key(pid, probe=True)
            # Missing/rejected key → unavailable. Network blips keep available.
            detail = str(checked.get("detail") or "")
            if not checked.get("ok") and (
                "REJECTED" in detail or "Missing" in detail or "empty" in detail.lower()
            ):
                available = False
            elif not checked.get("ok"):
                available = True

        out.append(
            {
                "id": pid,
                "name": p["name"],
                "available": available,
                "base_url": settings_base if use_custom else p.get("base_url"),
                "models": attach_prices(
                    [{**m, "available": available} for m in models]
                ),
            }
        )
    # Named profiles from ~/.clawagents/profiles.json (and cwd). Skip library
    # builtins — those are already listed above (openai/anthropic/gemini/ollama/
    # bedrock). Exposing ``profile:bedrock-gateway`` duplicated AWS Bedrock in
    # the Settings dropdown; gateway mode lives on the Bedrock card (Base URL).
    catalog_ids = {p["id"] for p in out}
    for name, profile in load_provider_profiles().items():
        if name in BUILTIN_PROVIDER_PROFILES or name in catalog_ids:
            continue
        out.append(
            {
                "id": f"profile:{name}",
                "name": f"Profile: {name}",
                "available": True,
                "base_url": profile.base_url or None,
                "models": attach_prices(
                    [{"id": profile.model, "label": profile.model, "available": True}]
                ),
            }
        )
    return out


def _sanitize_api_key(raw: str | None) -> str:
    """Normalize pasted keys so HTTP header encoding cannot fail."""
    text = (raw or "").replace("\ufeff", "").strip()
    for ch in ("\u200b", "\u200c", "\u200d", "\u2060"):
        text = text.replace(ch, "")
    if (text.startswith('"') and text.endswith('"')) or (
        text.startswith("'") and text.endswith("'")
    ):
        text = text[1:-1].strip()
    if "=" in text:
        left, right = text.split("=", 1)
        if left.strip().upper().endswith("KEY"):
            text = right.strip().strip('"').strip("'")
    # HTTP headers are latin-1; provider keys are ASCII.
    text = "".join(ch for ch in text if ord(ch) < 128).strip()
    return text


def _key_source(provider: str) -> str:
    """Where the effective key came from (provenance passed by the host)."""
    raw = os.environ.get("CLAW_KEY_SOURCES", "")
    try:
        sources = json.loads(raw) if raw else {}
    except json.JSONDecodeError:
        sources = {}
    src = sources.get(provider)
    return f" (source: {src})" if src else ""


def _probe_key(provider: str, key: str) -> tuple[bool, str]:
    """Cheap live request to distinguish a valid key from a stale one."""
    import urllib.error
    import urllib.parse
    import urllib.request

    key = _sanitize_api_key(key)
    if not key:
        return False, "Key empty after sanitizing (check for hidden/non-ASCII characters)"

    # OpenAI (+ compatible): prefer Settings base_url when trusted.
    if provider == "openai":
        settings_base, ssl_verify = _settings_base_url()
        if settings_base:
            ok, detail, _models = _probe_compatible_endpoint(
                settings_base, key, ssl_verify=ssl_verify
            )
            return ok, detail

    probes: dict[str, tuple[str, dict[str, str]]] = {
        "openai": ("https://api.openai.com/v1/models", {"Authorization": f"Bearer {key}"}),
        "anthropic": (
            "https://api.anthropic.com/v1/models",
            {"x-api-key": key, "anthropic-version": "2023-06-01"},
        ),
        # Query param avoids rare header latin-1 encode failures on pasted keys.
        "gemini": (
            "https://generativelanguage.googleapis.com/v1beta/models?"
            + urllib.parse.urlencode({"key": key, "pageSize": "1"}),
            {},
        ),
    }
    if provider not in probes:
        return True, "Key present in environment"
    url, headers = probes[provider]
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=8, context=_ssl_context(True)):
            return True, "Key valid (live check passed)"
    except urllib.error.HTTPError as exc:
        if exc.code in (400, 401, 403):
            return False, f"Key REJECTED by {provider} (HTTP {exc.code}) - rotate or replace it"
        return True, f"Key present; endpoint returned HTTP {exc.code}"
    except UnicodeEncodeError:
        return False, "Key has non-ASCII characters that break HTTP; re-paste a plain ASCII key"
    except Exception as exc:  # noqa: BLE001 - offline is not an invalid key
        msg = str(exc)
        # Keep detail ASCII-safe for webview / logs on constrained locales.
        msg = msg.encode("ascii", "replace").decode("ascii")
        return True, f"Key present; live check unavailable ({type(exc).__name__}: {msg})"


def verify_api_key(provider: str, *, probe: bool = False) -> dict[str, Any]:
    """Check the effective key. ``probe=True`` also validates it live."""
    mapping = {
        "openai": "OPENAI_API_KEY",
        "anthropic": "ANTHROPIC_API_KEY",
        "gemini": "GEMINI_API_KEY",
        "bedrock": "BEDROCK_API_KEY",
        "ollama": None,
    }
    key_name = mapping.get(provider)
    if key_name is None and provider == "ollama":
        return {"ok": True, "provider": provider, "detail": "Ollama needs no API key"}
    if not key_name:
        return {"ok": False, "provider": provider, "detail": "Unknown provider"}
    key = _sanitize_api_key(
        os.environ.get(key_name)
        or (os.environ.get("GOOGLE_API_KEY") if key_name == "GEMINI_API_KEY" else None)
        or (os.environ.get("OPENAI_API_KEY") if key_name == "BEDROCK_API_KEY" else None)
    )
    if provider == "bedrock" and not key:
        if _has_aws_credentials():
            return {
                "ok": True,
                "provider": provider,
                "detail": (
                    "Native AWS credentials detected — Base URL empty uses Bedrock IAM "
                    "(HIPAA). Set Base URL only for BAG / LiteLLM gateway."
                ),
            }
        return {
            "ok": False,
            "provider": provider,
            "detail": (
                "No AWS credentials (~/.aws or AWS_*) and no BEDROCK_API_KEY. "
                "Configure IAM for native Bedrock, or a gateway key + Base URL."
            ),
        }
    if not key:
        return {"ok": False, "provider": provider, "detail": f"Missing {key_name}"}
    source = _key_source(provider if provider != "bedrock" else (
        "bedrock" if os.environ.get("BEDROCK_API_KEY") else "openai"
    ))
    if provider == "bedrock" and not probe:
        return {
            "ok": True,
            "provider": provider,
            "detail": (
                f"Gateway key present{source} — leave Base URL empty for native IAM, "
                "or set it for BAG/LiteLLM"
            ),
        }
    if not probe:
        return {"ok": True, "provider": provider, "detail": f"Key present{source}"}
    if provider == "bedrock":
        settings_base, ssl_verify = _settings_base_url()
        if settings_base:
            ok, detail, models = _probe_compatible_endpoint(
                settings_base, key, ssl_verify=ssl_verify
            )
            extra = f" · {len(models)} models" if models else ""
            return {
                "ok": ok,
                "provider": provider,
                "detail": f"{detail}{extra}{source}",
            }
        return {
            "ok": True,
            "provider": provider,
            "detail": f"Gateway key present{source} (live check needs Base URL Test)",
        }
    ok, detail = _probe_key(provider, key)
    return {"ok": ok, "provider": provider, "detail": f"{detail}{source}"}
