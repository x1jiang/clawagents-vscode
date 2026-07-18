#!/usr/bin/env python3
"""ClawAgents VS Code sidecar entrypoint."""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

# Ensure this directory is on sys.path for sibling imports.
_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

_MONOREPO_SRC = _HERE.parent.parent / "clawagents_py" / "src"
if _MONOREPO_SRC.is_dir() and str(_MONOREPO_SRC) not in sys.path:
    sys.path.insert(0, str(_MONOREPO_SRC))


def _normalize_env() -> None:
    """Reconcile provider env aliases before anything reads them."""
    from spawn_secrets import normalize_provider_aliases, snapshot_spawn_secrets

    normalize_provider_aliases()
    snapshot_spawn_secrets()


def _check_dependencies() -> None:
    missing: list[str] = []
    for mod, pip_name in (
        ("clawagents", "clawagents"),
        ("fastapi", "fastapi"),
        ("uvicorn", "uvicorn"),
        ("pydantic", "pydantic"),
    ):
        try:
            __import__(mod)
        except ImportError:
            missing.append(pip_name)
    if missing:
        req = _HERE / "requirements.txt"
        print(
            "ERROR: missing Python dependencies for the ClawAgents sidecar:\n  - "
            + "\n  - ".join(missing)
            + "\n\nInstall into the interpreter set in VS Code setting "
            "'clawagents.pythonPath', for example:\n"
            f"  python3 -m pip install -r \"{req}\"\n"
            "Optional extras: pip install 'clawagents[gemini,anthropic,mcp,media]'",
            file=sys.stderr,
        )
        sys.exit(1)


def _maybe_patch_legacy_gemini() -> None:
    """Apply Gemini ARRAY ``items`` shim only when the library lacks the capability.

    Modern clawagents advertises ``gemini_array_items`` via
    ``clawagents.capabilities`` / ``GET /capabilities``. Prefer that contract
    over unconditional private monkey-patches.
    """
    try:
        from clawagents.capabilities import get_capabilities

        if get_capabilities().get("gemini_array_items"):
            return
    except Exception:  # noqa: BLE001
        pass

    # Legacy wheel without the capability flag — last-resort shim.
    try:
        from clawagents.providers import llm as llm_mod
    except Exception:  # noqa: BLE001
        return

    import inspect

    def _already_fixed(fn) -> bool:  # type: ignore[no-untyped-def]
        try:
            return '"items"' in inspect.getsource(fn)
        except (OSError, TypeError):
            return False

    if _already_fixed(getattr(llm_mod, "_to_gemini_tools", None)):
        return

    def _to_gemini_tools(schemas):  # type: ignore[no-untyped-def]
        declarations = []
        for s in schemas:
            properties = {}
            required = []
            for k, v in s.parameters.items():
                ptype = str(v.get("type", "string")).upper()
                prop = {"type": ptype, "description": v.get("description", "")}
                if ptype == "ARRAY":
                    items = v.get("items") if isinstance(v.get("items"), dict) else {}
                    prop["items"] = {"type": str(items.get("type", "string")).upper()}
                elif isinstance(v.get("items"), dict):
                    prop["items"] = {"type": str(v["items"].get("type", "string")).upper()}
                if v.get("required"):
                    required.append(k)
                properties[k] = prop
            decl = {
                "name": s.name,
                "description": s.description,
                "parameters": {"type": "OBJECT", "properties": properties},
            }
            if required:
                decl["parameters"]["required"] = required
            declarations.append(decl)
        return [{"function_declarations": declarations}]

    llm_mod._to_gemini_tools = _to_gemini_tools  # type: ignore[attr-defined]
    print(
        "WARN: applied legacy Gemini ARRAY items shim "
        "(upgrade clawagents for GET /capabilities gemini_array_items)",
        flush=True,
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="ClawAgents VS Code bridge")
    parser.add_argument("--port", type=int, default=3847)
    # Host is fixed to loopback for security; --host is accepted for
    # compatibility but non-loopback values are rejected.
    parser.add_argument("--host", default="127.0.0.1")
    args = parser.parse_args()

    host = (args.host or "127.0.0.1").strip()
    if host not in ("127.0.0.1", "localhost", "::1"):
        print(
            f"ERROR: refusing to bind to {host!r}; ClawAgents sidecar is localhost-only.",
            file=sys.stderr,
        )
        sys.exit(2)
    host = "127.0.0.1"

    if not os.environ.get("GATEWAY_API_KEY", "").strip():
        print(
            "ERROR: GATEWAY_API_KEY is required. Start the sidecar via the VS Code extension.",
            file=sys.stderr,
        )
        sys.exit(2)

    _normalize_env()
    _check_dependencies()
    _maybe_patch_legacy_gemini()

    import clawagents
    import uvicorn
    from app import create_app
    from paths import WORKSPACE

    print(
        f"ClawAgents VS Code bridge (clawagents {getattr(clawagents, '__version__', '?')}) "
        f"on http://{host}:{args.port} (workspace={WORKSPACE})",
        flush=True,
    )
    uvicorn.run(create_app(), host=host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
