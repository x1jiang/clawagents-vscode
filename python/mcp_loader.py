"""MCP server loading from .clawagents/mcp.json + built-in Context Mode."""

from __future__ import annotations

import json
import shutil
from pathlib import Path
from typing import Any

from paths import WORKSPACE

# Context Mode (https://github.com/mksglu/context-mode): token-efficiency MCP
# server — sandboxed code execution (only stdout enters context), FTS5/BM25
# indexed search, batch execution. Wired in programmatically when the
# `context_mode` setting is on and the binary is installed; users never have
# to touch mcp.json for it.
CONTEXT_MODE_BINARY = "context-mode"

# ctx tools that execute arbitrary code or mutate state. The bridge's
# permission gate treats these like the built-in `execute` tool: blocked in
# read_only, confirmed in ask/auto (no file path to auto-allow), allowed in
# full_access. ctx_execute is NOT a security sandbox — it can write files.
CONTEXT_MODE_WRITE_TOOLS = frozenset({
    "ctx_execute",
    "ctx_execute_file",
    "ctx_batch_execute",
    "ctx_purge",
    "ctx_upgrade",
})

CONTEXT_MODE_ROUTING_INSTRUCTION = (
    "Context Mode tools are available for token-efficient work. For bulk "
    "analysis (many files, logs, large outputs) prefer ctx_execute or "
    "ctx_batch_execute and print only the summary you need, instead of "
    "reading raw content into context. Prefer ctx_search over re-reading "
    "content you already indexed."
)


def context_mode_available() -> bool:
    return shutil.which(CONTEXT_MODE_BINARY) is not None


def create_context_mode_server() -> Any | None:
    """Build the MCPServerStdio for Context Mode, or None if unavailable."""
    if not context_mode_available():
        return None
    try:
        from clawagents import MCPServerStdio
    except ImportError:
        return None
    storage = WORKSPACE / ".clawagents" / "context-mode"
    try:
        storage.mkdir(parents=True, exist_ok=True)
    except OSError:
        return None
    return MCPServerStdio(
        {
            "command": CONTEXT_MODE_BINARY,
            "args": [],
            "env": {"CONTEXT_MODE_DIR": str(storage)},
        },
        name="context-mode",
        # Sandboxed code execution legitimately runs for a while; the default
        # 5s MCP session read timeout kills ctx_execute mid-run.
        client_session_timeout_seconds=120.0,
    )


def _mcp_paths() -> list[Path]:
    return [
        WORKSPACE / ".clawagents" / "mcp.json",
        Path.home() / ".clawagents" / "mcp.json",
    ]


def load_mcp_servers() -> list[Any]:
    """Return MCP server objects for create_claw_agent(mcp_servers=...)."""
    try:
        from clawagents import MCPServerStdio, MCPServerSse, MCPServerStreamableHttp
    except ImportError:
        return []

    config: dict[str, Any] = {}
    for path in _mcp_paths():
        if not path.is_file():
            continue
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if isinstance(raw, dict):
            servers = raw.get("mcpServers") or raw.get("servers") or raw
            if isinstance(servers, dict):
                config.update(servers)

    out: list[Any] = []
    for name, spec in config.items():
        if not isinstance(spec, dict) or spec.get("disabled"):
            continue
        try:
            if "command" in spec:
                params: dict[str, Any] = {
                    "command": spec["command"],
                    "args": list(spec.get("args") or []),
                }
                if spec.get("env"):
                    params["env"] = dict(spec["env"])
                out.append(MCPServerStdio(params, name=name))
            elif spec.get("url"):
                transport = str(spec.get("transport") or "sse").lower()
                if transport == "sse":
                    out.append(MCPServerSse({"url": spec["url"]}, name=name))
                else:
                    out.append(MCPServerStreamableHttp({"url": spec["url"]}, name=name))
        except Exception:  # noqa: BLE001
            continue
    return out


def list_mcp_config() -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = [
        {
            "name": "context-mode",
            "disabled": not context_mode_available(),
            "command": CONTEXT_MODE_BINARY,
            "url": None,
            "source": "builtin (settings: context_mode)"
            + ("" if context_mode_available() else " — binary not found"),
        }
    ]
    for path in _mcp_paths():
        if not path.is_file():
            continue
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        servers = raw.get("mcpServers") or raw.get("servers") or raw
        if not isinstance(servers, dict):
            continue
        for name, spec in servers.items():
            if not isinstance(spec, dict):
                continue
            items.append(
                {
                    "name": name,
                    "disabled": bool(spec.get("disabled")),
                    "command": spec.get("command"),
                    "url": spec.get("url"),
                    "source": str(path),
                }
            )
    return items
