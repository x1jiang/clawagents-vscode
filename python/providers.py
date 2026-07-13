"""Provider catalog + key verification."""

from __future__ import annotations

import os
from typing import Any

from clawagents.provider_profiles import BUILTIN_PROVIDER_PROFILES, load_provider_profiles

from pricing import attach_prices


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
            {"id": "deepseek.r1-v1:0", "label": "DeepSeek R1"},
        ],
    },
]


def _has_aws_credentials() -> bool:
    """True when native Bedrock can use the AWS credential chain."""
    if os.environ.get("AWS_ACCESS_KEY_ID") and os.environ.get("AWS_SECRET_ACCESS_KEY"):
        return True
    if os.environ.get("AWS_PROFILE") or os.environ.get("AWS_DEFAULT_PROFILE"):
        return True
    # Instance / task / SSO role often set region only; boto3 still resolves creds.
    if os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION"):
        return True
    # Shared credentials file under $HOME (common local setup).
    home = os.path.expanduser("~")
    for rel in (".aws/credentials", ".aws/config"):
        path = os.path.join(home, rel)
        if os.path.isfile(path):
            return True
    return False


def build_provider_catalog() -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for p in _CATALOG:
        env_key = p.get("env_key")
        available = True if env_key is None else bool(
            os.environ.get(str(env_key))
            or (env_key == "GEMINI_API_KEY" and os.environ.get("GOOGLE_API_KEY"))
            or (
                env_key == "BEDROCK_API_KEY"
                and (
                    os.environ.get("OPENAI_API_KEY")
                    or _has_aws_credentials()
                )
            )
        )
        out.append(
            {
                "id": p["id"],
                "name": p["name"],
                "available": available,
                "base_url": p.get("base_url"),
                "models": attach_prices(
                    [{**m, "available": available} for m in p["models"]]
                ),
            }
        )
    # Named profiles
    for name, profile in load_provider_profiles().items():
        if name in BUILTIN_PROVIDER_PROFILES and name in {p["id"] for p in out}:
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
    import json

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
    # Framework Python's default SSL context often has no CA bundle; use
    # certifi's (always present - the openai package depends on it).
    ssl_ctx = None
    try:
        import certifi
        import ssl

        ssl_ctx = ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        pass
    try:
        with urllib.request.urlopen(req, timeout=8, context=ssl_ctx):
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
        return {
            "ok": True,
            "provider": provider,
            "detail": f"Gateway key present{source} (live check needs Base URL Test)",
        }
    ok, detail = _probe_key(provider, key)
    return {"ok": ok, "provider": provider, "detail": f"{detail}{source}"}
