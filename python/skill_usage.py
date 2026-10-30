"""Workspace-local skill load counts; independent of general telemetry."""
from __future__ import annotations

import hashlib
import logging
import re
import threading
from typing import Any

from paths import CLAW_DIR, atomic_write_json, now_ts, read_json
from settings_store import load_settings

USAGE_FILE = CLAW_DIR / "vscode_skill_usage.json"
_lock = threading.RLock()
logger = logging.getLogger(__name__)
_PAGE = re.compile(r"^\[Skill (.+?) sha256=[0-9a-f]{64}: characters (\d+)-(\d+) of (\d+)\]")
_AUTO = re.compile(r"^\[Harness auto-continued skill '(.+?)' to EOF \(\d+ page\(s\)\)\.\]")


def _load() -> dict[str, Any]:
    data = read_json(USAGE_FILE, {})
    return data if isinstance(data, dict) else {}


def get_skill_usage() -> dict[str, Any]:
    with _lock:
        data = _load()
        rows = [
            {"name": name, "loads": row["loads"],
             "chats": len(row.get("chat_keys", [])), "last_used": row["last_used"]}
            for name, row in data.get("skills", {}).items()
        ]
        rows.sort(key=lambda row: (-row["loads"], -row["last_used"], row["name"]))
        return {"enabled": bool(load_settings().get("skill_usage")), "skills": rows}


def clear_skill_usage() -> dict[str, Any]:
    with _lock:
        atomic_write_json(USAGE_FILE, {"skills": {}})
        return get_skill_usage()


def _record(name: str, chat_id: str) -> None:
    with _lock:
        if not load_settings().get("skill_usage"):
            return
        data = _load()
        skills = data.setdefault("skills", {})
        row = skills.setdefault(name, {"loads": 0, "chat_keys": []})
        row["loads"] += 1
        row["last_used"] = now_ts()
        # Only a stable hash is needed to count distinct chats across restarts.
        chat_key = hashlib.sha256(chat_id.encode()).hexdigest()
        row["chat_keys"] = sorted(set(row["chat_keys"]) | {chat_key})
        atomic_write_json(USAGE_FILE, data)


class SkillUsageTracker:
    """One per live run. Consume completion once, never transcript replay.

    The harness page header identifies canonical names and EOF even when the
    UI output's tail is truncated. Auto-drain reports EOF at the start of the
    next tool's output; that load succeeded even if the subsequent tool failed.
    """
    def __init__(self, chat_id: str):
        self.chat_id = chat_id
        self.pending: dict[str, dict[str, Any]] = {}
        self.completed: set[str] = set()

    def on_event(self, kind: str, payload: dict[str, Any]) -> None:
        try:
            self._on_event(kind, payload)
        except Exception:
            # Local statistics must never interrupt an agent run.
            logger.warning("Could not record skill usage", exc_info=True)

    def _on_event(self, kind: str, payload: dict[str, Any]) -> None:
        call_id = str(payload.get("call_id") or "")
        if not call_id:
            return
        if kind == "tool_started":
            if call_id not in self.completed:
                self.pending[call_id] = dict(payload)
            return
        if kind != "tool_completed" or call_id in self.completed:
            return
        started = self.pending.pop(call_id, None)
        if started is None:
            return
        self.completed.add(call_id)
        output = payload.get("output")
        if not isinstance(output, str):
            return
        # Failed follow-up tools wrap their output in the harness error text.
        auto_output = output
        if payload.get("success") is False and output.startswith("Error:"):
            _, separator, body = output.partition("\nOutput:\n")
            if separator:
                auto_output = body
        auto = _AUTO.match(auto_output)
        if auto:
            _record(auto[1], self.chat_id)
            return
        if started.get("name") != "use_skill" or payload.get("success") is not True:
            return
        args = started.get("args") or {}
        if args.get("abort"):
            return
        page = _PAGE.match(output)
        if page:
            if int(page[3]) == int(page[4]):
                _record(page[1], self.chat_id)
        elif output.startswith("# Skill: "):
            # Compatibility with versions before paged skill loading.
            name = output.splitlines()[0][len("# Skill: "):].strip()
            if name:
                _record(name, self.chat_id)
