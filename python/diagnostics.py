"""Readiness / diagnostics for the VS Code sidecar."""

from __future__ import annotations

import importlib
import os
import sys
from typing import Any
from urllib.parse import urlparse

from paths import MODEL, WORKSPACE
from providers import verify_api_key
from settings_store import load_settings
from url_trust import is_trusted_base_url


def run_diagnostics() -> dict[str, Any]:
    checks: list[dict[str, Any]] = []

    def add(name: str, ok: bool, detail: str = "") -> None:
        checks.append({"name": name, "ok": ok, "detail": detail})

    add("python", True, sys.version.split()[0])
    add("workspace", WORKSPACE.is_dir(), str(WORKSPACE))

    try:
        import clawagents  # noqa: F401

        add("clawagents", True, getattr(clawagents, "__version__", "installed"))
    except ImportError as exc:
        add("clawagents", False, str(exc))

    for mod in ("fastapi", "uvicorn", "pydantic"):
        try:
            importlib.import_module(mod)
            add(mod, True)
        except ImportError as exc:
            add(mod, False, str(exc))

    settings = load_settings()
    provider = settings.get("provider") or "auto"
    if provider == "auto":
        any_key = any(
            verify_api_key(p)["ok"] for p in ("openai", "anthropic", "gemini", "bedrock", "ollama")
        )
        add("api_key", any_key, "at least one provider key, bedrock gateway, or ollama")
    else:
        v = verify_api_key(str(provider))
        add("api_key", bool(v["ok"]), v.get("detail", ""))

    add("model", True, settings.get("model") or MODEL or "default")

    base_url = str(settings.get("base_url") or "").strip()
    trusted_custom = bool(
        base_url
        and not is_trusted_base_url(base_url)
        and settings.get("trust_custom_base_url")
    )
    if trusted_custom:
        host = urlparse(base_url if "://" in base_url else f"https://{base_url}").netloc or base_url
        add("custom_base_url", True, host)
        wire = str(settings.get("wire_api") or "auto").strip().lower()
        if wire in ("", "auto"):
            add(
                "wire_api",
                True,
                "auto — set Wire API to Responses if this gateway 404s on chat/completions",
            )
        else:
            add("wire_api", True, wire)
        if base_url.lower().startswith("https://") and settings.get("ssl_verify") is not False:
            add(
                "ssl_verify",
                False,
                "Verify TLS is on for a custom HTTPS gateway — uncheck if the host uses a private CA",
            )
        else:
            add(
                "ssl_verify",
                True,
                "off" if settings.get("ssl_verify") is False else "on",
            )
    elif base_url:
        add("custom_base_url", True, "localhost / loopback")
    else:
        add("custom_base_url", True, "none (provider default)")

    mcp_path = WORKSPACE / ".clawagents" / "mcp.json"
    add("mcp_config", mcp_path.is_file(), str(mcp_path) if mcp_path.is_file() else "none")

    try:
        from mcp_loader import context_mode_status

        cm = context_mode_status()
        add("context_mode", bool(cm.get("ok")), cm.get("summary") or str(cm))
    except Exception as exc:  # noqa: BLE001
        add("context_mode", False, str(exc))

    try:
        from mcp_loader import graphify_status

        gf = graphify_status(
            graph_path=str(settings.get("graphify_graph_path") or ""),
            corpus=str(settings.get("graphify_corpus") or "workspace"),
        )
        # Soft check: package floor matters when the toggle is on; otherwise report.
        want = bool(settings.get("graphify"))
        add(
            "graphify",
            bool(gf.get("ok")) if want else True,
            gf.get("summary") or str(gf),
        )
    except Exception as exc:  # noqa: BLE001
        add("graphify", False, str(exc))

    try:
        from clawagents.companions import probe_rtk

        rtk = probe_rtk()
        add("rtk", rtk.ok_vs_floor, rtk.summary())
    except ImportError:
        add("rtk", False, "clawagents.companions missing — upgrade clawagents>=6.20.1")
    except Exception as exc:  # noqa: BLE001
        add("rtk", False, str(exc))

    agents = WORKSPACE / "AGENTS.md"
    add("agents_md", agents.is_file(), str(agents) if agents.is_file() else "none")

    try:
        from clawagents.tokenizer import token_estimator_info

        model_id = str(settings.get("model") or MODEL or "")
        info = token_estimator_info(model_id or None)
        add(
            "token_estimator",
            bool(info.get("accurate")),
            str(info.get("detail") or info.get("estimator") or ""),
        )
    except Exception as exc:  # noqa: BLE001
        add("token_estimator", False, str(exc))

    return {
        "ok": all(c["ok"] for c in checks if c["name"] in ("clawagents", "workspace", "api_key")),
        "checks": checks,
        "env_keys_present": {
            k: bool(os.environ.get(k))
            for k in (
                "OPENAI_API_KEY",
                "ANTHROPIC_API_KEY",
                "GEMINI_API_KEY",
                "GOOGLE_API_KEY",
                "BEDROCK_API_KEY",
                "AWS_REGION",
                "AWS_DEFAULT_REGION",
                "AWS_PROFILE",
                "AWS_ACCESS_KEY_ID",
            )
        },
    }
