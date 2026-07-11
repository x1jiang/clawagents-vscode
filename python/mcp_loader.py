"""MCP server loading from .clawagents/mcp.json + built-in Context Mode."""

from __future__ import annotations

import json
import shutil
from pathlib import Path, PurePosixPath
from typing import Any
from urllib.parse import urlparse

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

# Stdio MCP launchers we accept without prompting. Absolute paths and other
# binaries require the command basename to be in this set (or be context-mode).
_ALLOWED_MCP_COMMANDS = frozenset({
    "npx",
    "npm",
    "pnpm",
    "yarn",
    "bun",
    "deno",
    "uvx",
    "uv",
    "node",
    "python",
    "python3",
    "pipx",
    "docker",
    CONTEXT_MODE_BINARY,
})


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


def _mcp_paths(*, trust_workspace: bool) -> list[tuple[Path, str]]:
    """Return (path, origin) pairs. Workspace mcp.json is opt-in."""
    out: list[tuple[Path, str]] = [
        (Path.home() / ".clawagents" / "mcp.json", "user"),
    ]
    if trust_workspace:
        out.insert(0, (WORKSPACE / ".clawagents" / "mcp.json", "workspace"))
    return out


def _command_allowed(command: str) -> bool:
    text = (command or "").strip()
    if not text:
        return False
    name = PurePosixPath(text.replace("\\", "/")).name
    return name in _ALLOWED_MCP_COMMANDS


def _url_allowed(url: str) -> bool:
    """Only loopback MCP HTTP endpoints (no arbitrary remote SSRF)."""
    try:
        parsed = urlparse(url)
    except Exception:  # noqa: BLE001
        return False
    if parsed.scheme not in ("http", "https"):
        return False
    host = (parsed.hostname or "").lower()
    return host in ("localhost", "127.0.0.1", "::1")


def _sanitize_mcp_env(raw: Any) -> dict[str, str]:
    """Drop credential-like keys from MCP child env."""
    if not isinstance(raw, dict):
        return {}
    out: dict[str, str] = {}
    blocked = ("KEY", "TOKEN", "SECRET", "PASSWORD", "CREDENTIAL", "AUTH")
    for k, v in raw.items():
        if not isinstance(k, str) or not isinstance(v, (str, int, float, bool)):
            continue
        upper = k.upper()
        if any(b in upper for b in blocked):
            continue
        if upper.startswith("PYTHON") or upper in ("LD_PRELOAD", "LD_LIBRARY_PATH", "DYLD_LIBRARY_PATH"):
            continue
        out[k] = str(v)
    return out


def load_mcp_servers(*, trust_workspace: bool = False) -> list[Any]:
    """Return MCP server objects for create_claw_agent(mcp_servers=...)."""
    try:
        from clawagents import MCPServerStdio, MCPServerSse, MCPServerStreamableHttp
    except ImportError:
        return []

    config: dict[str, Any] = {}
    for path, _origin in _mcp_paths(trust_workspace=trust_workspace):
        if not path.is_file():
            continue
        try:
            # Refuse symlink escape for workspace mcp.json
            resolved = path.resolve()
            if trust_workspace and path == WORKSPACE / ".clawagents" / "mcp.json":
                try:
                    resolved.relative_to(WORKSPACE.resolve())
                except ValueError:
                    continue
            raw = json.loads(resolved.read_text(encoding="utf-8"))
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
                command = str(spec["command"])
                if not _command_allowed(command):
                    continue
                params: dict[str, Any] = {
                    "command": command,
                    "args": [str(a) for a in list(spec.get("args") or [])],
                }
                env = _sanitize_mcp_env(spec.get("env"))
                if env:
                    params["env"] = env
                out.append(MCPServerStdio(params, name=name))
            elif spec.get("url"):
                url = str(spec["url"])
                if not _url_allowed(url):
                    continue
                transport = str(spec.get("transport") or "sse").lower()
                if transport == "sse":
                    out.append(MCPServerSse({"url": url}, name=name))
                else:
                    out.append(MCPServerStreamableHttp({"url": url}, name=name))
        except Exception:  # noqa: BLE001
            continue
    return out


def list_mcp_config(*, trust_workspace: bool = False) -> list[dict[str, Any]]:
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
    for path, origin in _mcp_paths(trust_workspace=True):
        # Always list workspace file for UI visibility, even if not trusted yet.
        if not path.is_file():
            continue
        if origin == "workspace" and not trust_workspace:
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
                        "disabled": True,
                        "command": spec.get("command"),
                        "url": spec.get("url"),
                        "source": f"{path} (workspace — enable 'Trust workspace MCP' to load)",
                    }
                )
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
