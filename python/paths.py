"""Shared paths and helpers for the VS Code bridge."""

from __future__ import annotations

import json
import os
import re
import tempfile
import time
from pathlib import Path
from typing import Any

WORKSPACE = Path(os.getenv("CLAW_WORKSPACE") or os.getcwd()).resolve()
MODEL = os.getenv("CLAW_MODEL", "").strip() or None
GATEWAY_API_KEY = os.getenv("GATEWAY_API_KEY", "")

CLAW_DIR = WORKSPACE / ".clawagents"
SESSIONS_MEMORY_DIR = CLAW_DIR / "sessions-memory"
CHATS_DIR = CLAW_DIR / "vscode-chats"
GRANTS_FILE = CLAW_DIR / "permission_grants.json"
SETTINGS_FILE = CLAW_DIR / "vscode_settings.json"
STATS_FILE = CLAW_DIR / "vscode_stats.json"
SNAPSHOTS_DIR = CLAW_DIR / "snapshots"

INSTRUCTION_FILES = ("CLAUDE.md", ".clawagents/instructions.md", "AGENTS.md", "CLAWAGENTS.md")

# Opaque IDs used in URL/path segments — reject traversal and odd characters.
_SAFE_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


def safe_id(value: str, *, kind: str = "id") -> str:
    """Validate an opaque id used under ``.clawagents/`` (chat, snapshot, request)."""
    if not isinstance(value, str) or not _SAFE_ID_RE.fullmatch(value):
        raise ValueError(f"invalid {kind}")
    if ".." in value or "/" in value or "\\" in value:
        raise ValueError(f"invalid {kind}")
    return value


def path_under(root: Path, *parts: str) -> Path | None:
    """Join ``parts`` under ``root`` and return None if the result escapes ``root``."""
    base = root.resolve()
    target = base.joinpath(*parts).resolve()
    try:
        target.relative_to(base)
    except ValueError:
        return None
    return target


def under_workspace(path: Path | str) -> bool:
    """True if ``path`` resolves to a location inside the workspace root."""
    try:
        resolved = Path(path).resolve()
        resolved.relative_to(WORKSPACE.resolve())
        return True
    except (OSError, ValueError):
        return False


def workspace_rel(path: str | Path) -> str | None:
    """Return a POSIX-relative path under WORKSPACE, or None if it escapes."""
    try:
        p = Path(path)
        resolved = p.resolve() if p.is_absolute() else (WORKSPACE / p).resolve()
        rel = resolved.relative_to(WORKSPACE.resolve())
        return rel.as_posix()
    except (OSError, ValueError):
        return None


def ensure_dirs() -> None:
    for d in (SESSIONS_MEMORY_DIR, CHATS_DIR, SNAPSHOTS_DIR):
        d.mkdir(parents=True, exist_ok=True)


def read_project_instructions() -> str | None:
    for rel in INSTRUCTION_FILES:
        candidate = WORKSPACE / rel
        try:
            resolved = candidate.resolve()
            if not under_workspace(resolved):
                continue
            if not resolved.is_file():
                continue
            text = resolved.read_text(encoding="utf-8").strip()
            if text:
                return text
        except OSError:
            continue
    return None


def atomic_write_json(path: Path, data: Any) -> None:
    """Write JSON atomically without following a pre-planted tmp symlink."""
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(data, indent=2, default=str)
    fd, tmp_name = tempfile.mkstemp(
        prefix=f".{path.name}.",
        suffix=".tmp",
        dir=str(path.parent),
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp_name, path)
    except Exception:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise


def read_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8") or "null")
    except (OSError, json.JSONDecodeError):
        return default


def now_ts() -> float:
    return time.time()


def chat_meta_path(chat_id: str) -> Path:
    cid = safe_id(chat_id, kind="chat_id")
    path = path_under(CHATS_DIR, f"{cid}.json")
    if path is None:
        raise ValueError("invalid chat_id")
    return path


def chat_ui_log_path(chat_id: str) -> Path:
    cid = safe_id(chat_id, kind="chat_id")
    path = path_under(CHATS_DIR, f"{cid}.ui.jsonl")
    if path is None:
        raise ValueError("invalid chat_id")
    return path
