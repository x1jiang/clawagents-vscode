"""Bounded persistence for restorable tool-call UI cards."""

from __future__ import annotations

import json
from pathlib import Path

import chats


def test_tool_ui_events_are_persisted_with_bounded_payloads(
    tmp_path: Path,
    monkeypatch,
):
    log = tmp_path / "chat.ui.jsonl"
    timestamps = iter((10.0, 12.5))
    monkeypatch.setattr(chats, "chat_ui_log_path", lambda _cid: log)
    monkeypatch.setattr(chats, "ensure_dirs", lambda: None)
    monkeypatch.setattr(chats, "now_ts", lambda: next(timestamps))

    started_at = chats.append_tool_ui_event(
        "chat-a",
        "tool_started",
        {
            "call_id": "call-1",
            "name": "read_file",
            "args": {"path": "story.txt", "content": "x" * 5_000},
        },
        perceived_started_at=8.0,
    )
    completed_at = chats.append_tool_ui_event(
        "chat-a",
        "tool_completed",
        {
            "call_id": "call-1",
            "name": "read_file",
            "success": True,
            "output": "y" * 9_000,
        },
    )

    events = [json.loads(line) for line in log.read_text(encoding="utf-8").splitlines()]
    assert started_at == 10.0
    assert completed_at == 12.5
    assert events[0]["kind"] == "tool_started"
    assert events[0]["perceived_started_at"] == 8.0
    assert events[0]["args"]["truncated"] is True
    assert len(events[0]["args"]["preview"]) <= chats.TOOL_UI_ARGS_MAX_CHARS + 1
    assert events[1]["kind"] == "tool_completed"
    assert len(events[1]["output"]) == chats.TOOL_UI_OUTPUT_MAX_CHARS
