"""Readiness / diagnostics for the VS Code sidecar."""

from __future__ import annotations

import importlib
import os
import sys
from typing import Any

from paths import MODEL, WORKSPACE
from providers import verify_api_key
from settings_store import load_settings


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

    mcp_path = WORKSPACE / ".clawagents" / "mcp.json"
    add("mcp_config", mcp_path.is_file(), str(mcp_path) if mcp_path.is_file() else "none")

    try:
        from mcp_loader import context_mode_available

        cm = context_mode_available()
        add(
            "context_mode",
            cm,
            "binary found" if cm else "not installed (npm install -g context-mode)",
        )
    except Exception as exc:  # noqa: BLE001
        add("context_mode", False, str(exc))

    agents = WORKSPACE / "AGENTS.md"
    add("agents_md", agents.is_file(), str(agents) if agents.is_file() else "none")

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
