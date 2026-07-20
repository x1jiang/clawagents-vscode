"""MCP server loading from .clawagents/mcp.json + built-in Context Mode / Graphify."""

from __future__ import annotations

import json
import shutil
import sys
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

# Graphify (https://github.com/Graphify-Labs/graphify): local knowledge-graph
# MCP over graph.json. Wired when `graphify` setting is on and graphifyy is
# installed in the sidecar interpreter.
GRAPHIFY_OUT_REL = Path(".clawagents") / "graphify"
GRAPHIFY_GRAPH_NAME = "graph.json"

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

# Graphify MCP tools are query-only today; extract/update is an extension
# command. Keep this set for future mutate tools / permission parity.
GRAPHIFY_WRITE_TOOLS: frozenset[str] = frozenset()

CONTEXT_MODE_ROUTING_INSTRUCTION = (
    "Context Mode tools are available for token-efficient work. For bulk "
    "analysis (many files, logs, large outputs) prefer ctx_execute or "
    "ctx_batch_execute and print only the summary you need, instead of "
    "reading raw content into context. Prefer ctx_search over re-reading "
    "content you already indexed."
)

GRAPHIFY_ROUTING_INSTRUCTION = (
    "Graphify knowledge-graph tools are available. For architecture, "
    "dependency, and 'how does X connect to Y?' questions, prefer "
    "query_graph, get_neighbors, shortest_path, or god_nodes before dumping "
    "many files with read_file/grep. Do not paste graph.json into context."
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


# Fallback floors when clawagents<6.19.0 is briefly installed.
_FALLBACK_MIN_CONTEXT_MODE = (1, 0, 169)


def _min_context_mode() -> tuple[int, int, int]:
    try:
        from clawagents.companions import MIN_CONTEXT_MODE

        return MIN_CONTEXT_MODE
    except ImportError:
        return _FALLBACK_MIN_CONTEXT_MODE


def context_mode_available() -> bool:
    return shutil.which(CONTEXT_MODE_BINARY) is not None


def context_mode_status() -> dict[str, Any]:
    """Version-aware Context Mode status for doctor / diagnostics."""
    try:
        from clawagents.companions import probe_context_mode

        s = probe_context_mode()
        return {
            "found": s.found,
            "version": s.version,
            "ok": s.ok_vs_floor,
            "min_version": s.min_version,
            "path": s.path,
            "hint": s.hint,
            "summary": s.summary(),
        }
    except ImportError:
        path = shutil.which(CONTEXT_MODE_BINARY)
        found = path is not None
        min_v = ".".join(str(x) for x in _min_context_mode())
        return {
            "found": found,
            "version": None,
            "ok": found,  # presence-only without companions module
            "min_version": min_v,
            "path": path,
            "hint": "ok" if found else "npm install -g context-mode@latest",
            "summary": (
                f"context-mode: found (version unknown; upgrade clawagents>=6.19.0 for floors)"
                if found
                else f"context-mode: missing — need >={min_v}"
            ),
        }


def create_context_mode_server() -> Any | None:
    """Build the MCPServerStdio for Context Mode, or None if unavailable/outdated."""
    status = context_mode_status()
    if not status.get("ok"):
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


_FALLBACK_MIN_GRAPHIFY = (0, 9, 20)


def _min_graphify() -> tuple[int, int, int]:
    try:
        from clawagents.companions import MIN_GRAPHIFY

        return MIN_GRAPHIFY
    except ImportError:
        return _FALLBACK_MIN_GRAPHIFY


def resolve_graphify_graph_path(
    *,
    graph_path: str | None = None,
    corpus: str | None = None,
    workspace: Path | None = None,
) -> Path | None:
    """Resolve which graph.json to serve.

    Order:
    1. Explicit ``graph_path`` (absolute or workspace-relative) when set
    2. ``{workspace}/.clawagents/graphify/graph.json``
    3. ``{workspace}/graphify-out/graph.json`` if present
    """
    root = (workspace or WORKSPACE).resolve()
    explicit = (graph_path or "").strip()
    if explicit or (corpus or "").strip().lower() == "path":
        if not explicit:
            return None
        candidate = Path(explicit).expanduser()
        if not candidate.is_absolute():
            candidate = (root / candidate).resolve()
        else:
            candidate = candidate.resolve()
        if candidate.is_dir():
            nested = candidate / GRAPHIFY_GRAPH_NAME
            return nested
        return candidate

    preferred = root / GRAPHIFY_OUT_REL / GRAPHIFY_GRAPH_NAME
    if preferred.is_file():
        return preferred
    upstream = root / "graphify-out" / GRAPHIFY_GRAPH_NAME
    if upstream.is_file():
        return upstream
    return preferred


def graphify_status(
    *,
    graph_path: str | None = None,
    corpus: str | None = None,
    workspace: Path | None = None,
) -> dict[str, Any]:
    """Version + graph path status for doctor / diagnostics."""
    try:
        from clawagents.companions import probe_graphify

        s = probe_graphify(python=sys.executable)
        package = {
            "found": s.found,
            "version": s.version,
            "ok": s.ok_vs_floor,
            "min_version": s.min_version,
            "path": s.path,
            "hint": s.hint,
            "summary": s.summary(),
        }
    except ImportError:
        min_v = ".".join(str(x) for x in _min_graphify())
        package = {
            "found": False,
            "version": None,
            "ok": False,
            "min_version": min_v,
            "path": None,
            "hint": "pip install 'graphifyy[mcp]'",
            "summary": f"graphify: missing — need >={min_v}",
        }

    resolved = resolve_graphify_graph_path(
        graph_path=graph_path,
        corpus=corpus,
        workspace=workspace,
    )
    graph_exists = bool(resolved and resolved.is_file())
    node_count: int | None = None
    if graph_exists and resolved is not None:
        try:
            data = json.loads(resolved.read_text(encoding="utf-8"))
            nodes = data.get("nodes") if isinstance(data, dict) else None
            if isinstance(nodes, list):
                node_count = len(nodes)
        except (OSError, json.JSONDecodeError, TypeError):
            node_count = None

    ok = bool(package.get("ok")) and graph_exists
    summary = str(package.get("summary") or "graphify")
    if not graph_exists:
        summary += (
            f" — no graph at {resolved or '(unset)'}; "
            "run ClawAgents: Graphify — Extract/Update Workspace"
        )
    elif node_count is not None:
        summary += f" — graph {node_count} nodes @ {resolved}"

    return {
        "found": bool(package.get("found")),
        "version": package.get("version"),
        "ok": ok,
        "package_ok": bool(package.get("ok")),
        "min_version": package.get("min_version"),
        "path": package.get("path"),
        "hint": package.get("hint"),
        "summary": summary,
        "graph_path": str(resolved) if resolved else None,
        "graph_exists": graph_exists,
        "node_count": node_count,
    }


def create_graphify_server(
    *,
    graph_path: str | None = None,
    corpus: str | None = None,
    workspace: Path | None = None,
) -> Any | None:
    """Build MCPServerStdio for Graphify, or None if package/graph unavailable."""
    status = graphify_status(
        graph_path=graph_path,
        corpus=corpus,
        workspace=workspace,
    )
    if not status.get("package_ok"):
        return None
    resolved = status.get("graph_path")
    if not resolved or not status.get("graph_exists"):
        return None
    try:
        from clawagents import MCPServerStdio
    except ImportError:
        return None
    return MCPServerStdio(
        {
            "command": sys.executable,
            "args": ["-m", "graphify.serve", str(resolved)],
            "env": {},
        },
        name="graphify",
        client_session_timeout_seconds=60.0,
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
        # Session read timeout: long-running tools (code execution, big
        # fetches) legitimately exceed the SDK's 5s default. Configurable per
        # server via a "timeout" key (seconds), clamped to sane bounds.
        try:
            timeout = float(spec.get("timeout", 60.0))
        except (TypeError, ValueError):
            timeout = 60.0
        timeout = min(max(timeout, 5.0), 600.0)
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
                out.append(
                    MCPServerStdio(
                        params, name=name, client_session_timeout_seconds=timeout
                    )
                )
            elif spec.get("url"):
                url = str(spec["url"])
                if not _url_allowed(url):
                    continue
                transport = str(spec.get("transport") or "sse").lower()
                if transport == "sse":
                    out.append(
                        MCPServerSse(
                            {"url": url},
                            name=name,
                            client_session_timeout_seconds=timeout,
                        )
                    )
                else:
                    out.append(
                        MCPServerStreamableHttp(
                            {"url": url},
                            name=name,
                            client_session_timeout_seconds=timeout,
                        )
                    )
        except Exception:  # noqa: BLE001
            continue
    return out


def list_mcp_config(*, trust_workspace: bool = False) -> list[dict[str, Any]]:
    cm = context_mode_status()
    gf = graphify_status()
    items: list[dict[str, Any]] = [
        {
            "name": "context-mode",
            "disabled": not bool(cm.get("ok")),
            "command": CONTEXT_MODE_BINARY,
            "url": None,
            "source": "builtin (settings: context_mode) — " + str(cm.get("summary") or ""),
        },
        {
            "name": "graphify",
            "disabled": not bool(gf.get("ok")),
            "command": sys.executable,
            "url": None,
            "source": "builtin (settings: graphify) — " + str(gf.get("summary") or ""),
        },
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
