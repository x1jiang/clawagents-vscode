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
    """Reconcile provider env aliases before anything reads them.

    clawagents reads GEMINI_API_KEY only; users (and Google's own docs)
    often export GOOGLE_API_KEY instead. Mirror it so availability checks
    and the runtime agree.
    """
    if os.environ.get("GOOGLE_API_KEY") and not os.environ.get("GEMINI_API_KEY"):
        os.environ["GEMINI_API_KEY"] = os.environ["GOOGLE_API_KEY"]


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
            "Optional extras: pip install 'clawagents[gemini,anthropic,mcp]'",
            file=sys.stderr,
        )
        sys.exit(1)


def _patch_gemini_array_schemas() -> None:
    """Gemini rejects ARRAY tool params without ``items`` (MCP schemas often omit it).

    Back-compat shim for pip-installed clawagents releases that predate the
    upstream fix. Self-disables when the installed converters already handle
    ``items`` so it can never mask newer upstream behavior.
    """
    import inspect

    try:
        from clawagents.providers import llm as llm_mod
    except Exception:  # noqa: BLE001
        return

    def _already_fixed(fn) -> bool:  # type: ignore[no-untyped-def]
        try:
            return '"items"' in inspect.getsource(fn)
        except (OSError, TypeError):
            return False

    if _already_fixed(getattr(llm_mod, "_to_gemini_tools", None)):
        try:
            from clawagents.mcp import tool_bridge as bridge_mod

            if _already_fixed(getattr(bridge_mod, "_normalize_input_schema", None)):
                return  # upstream carries both fixes — nothing to patch
        except Exception:  # noqa: BLE001
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

    try:
        from clawagents.mcp import tool_bridge as bridge_mod
    except Exception:  # noqa: BLE001
        return

    _orig = bridge_mod._normalize_input_schema

    def _normalize_input_schema(input_schema):  # type: ignore[no-untyped-def]
        out = _orig(input_schema)
        if not isinstance(input_schema, dict):
            return out
        props = input_schema.get("properties") or {}
        if not isinstance(props, dict):
            return out
        for pname, raw in props.items():
            if pname not in out or not isinstance(raw, dict):
                continue
            if out[pname].get("type") != "array":
                continue
            if "items" in out[pname]:
                continue
            items = raw.get("items")
            item_type = "string"
            if isinstance(items, dict):
                t = items.get("type", "string")
                if isinstance(t, list):
                    t = next((x for x in t if x != "null"), "string")
                if isinstance(t, str):
                    item_type = t
            out[pname]["items"] = {"type": item_type}
        return out

    bridge_mod._normalize_input_schema = _normalize_input_schema  # type: ignore[attr-defined]


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
    _patch_gemini_array_schemas()

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
