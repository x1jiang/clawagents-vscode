"""Shared paths and helpers for the VS Code bridge."""

from __future__ import annotations

import json
import os
import re
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


def ensure_dirs() -> None:
    for d in (SESSIONS_MEMORY_DIR, CHATS_DIR, SNAPSHOTS_DIR):
        d.mkdir(parents=True, exist_ok=True)


def read_project_instructions() -> str | None:
    for rel in INSTRUCTION_FILES:
        candidate = WORKSPACE / rel
        if candidate.is_file():
            try:
                text = candidate.read_text(encoding="utf-8").strip()
                if text:
                    return text
            except OSError:
                continue
    return None


def atomic_write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, indent=2, default=str), encoding="utf-8")
    tmp.replace(path)


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
