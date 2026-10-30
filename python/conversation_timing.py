"""Per-conversation wall-clock accounting, independent of transcript pagination.

Only finished runs are persisted. Active runs belong to this sidecar process;
a restart must never turn downtime into agent execution time.
"""

from __future__ import annotations

import threading
import time
from typing import Any

from paths import atomic_write_json, chat_meta_path, read_json


def timing_path(chat_id: str):
    return chat_meta_path(chat_id).with_suffix(".timing.json")


class ConversationTimingStore:
    def __init__(self):
        self._lock = threading.RLock()
        self._active: dict[str, tuple[str, float, float]] = {}

    def start(self, chat_id: str, run_id: str) -> None:
        with self._lock:
            self._active.setdefault(run_id, (chat_id, time.time(), time.monotonic()))

    def finish(self, run_id: str) -> None:
        with self._lock:
            run = self._active.pop(run_id, None)
            if run is None:
                return
            chat_id, started_at, started_clock = run
            saved = read_json(timing_path(chat_id), {})
            elapsed = max(0, (time.monotonic() - started_clock) * 1000)
            saved.update(
                cumulative_ms=saved.get("cumulative_ms", 0) + elapsed,
                last_run_ms=elapsed,
                run_count=saved.get("run_count", 0) + 1,
                tracked_since=saved.get("tracked_since", started_at),
                last_activity_at=time.time(),
            )
            # A conversation deleted while its stream shuts down stays deleted.
            if chat_meta_path(chat_id).exists():
                atomic_write_json(timing_path(chat_id), saved)

    def snapshot(self, meta: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            chat_id = meta["id"]
            saved = read_json(timing_path(chat_id), {})
            active = [run for run in self._active.values() if run[0] == chat_id]
            now = time.time()
            clock = time.monotonic()
            active_ms = [max(0, (clock - run[2]) * 1000) for run in active]
            return {
                "created_at": meta.get("created_at"),
                "last_activity_at": now if active else saved.get("last_activity_at", meta.get("updated_at")),
                "tracked_since": saved.get("tracked_since", min((r[1] for r in active), default=None)),
                "cumulative_ms": saved.get("cumulative_ms", 0) + sum(active_ms),
                "last_run_ms": active_ms[-1] if active_ms else saved.get("last_run_ms"),
                "run_count": saved.get("run_count", 0) + len(active),
                "active_runs": len(active),
                "sampled_at": now,
            }
