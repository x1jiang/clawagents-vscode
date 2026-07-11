"""Local usage stats (opt-in telemetry)."""

from __future__ import annotations

from typing import Any

from paths import STATS_FILE, atomic_write_json, now_ts, read_json
from settings_store import load_settings


def _load() -> dict[str, Any]:
    data = read_json(STATS_FILE, {})
    if not isinstance(data, dict):
        data = {}
    data.setdefault("turns", 0)
    data.setdefault("tokens", 0)
    data.setdefault("errors", 0)
    data.setdefault("events", [])
    return data


def record_turn(*, tokens: int = 0, error: bool = False) -> None:
    if not load_settings().get("telemetry"):
        return
    data = _load()
    data["turns"] = int(data.get("turns") or 0) + 1
    data["tokens"] = int(data.get("tokens") or 0) + int(tokens or 0)
    if error:
        data["errors"] = int(data.get("errors") or 0) + 1
    events = list(data.get("events") or [])
    events.append({"ts": now_ts(), "tokens": tokens, "error": error})
    data["events"] = events[-200:]
    atomic_write_json(STATS_FILE, data)


def get_stats() -> dict[str, Any]:
    data = _load()
    data["telemetry_enabled"] = bool(load_settings().get("telemetry"))
    return data
