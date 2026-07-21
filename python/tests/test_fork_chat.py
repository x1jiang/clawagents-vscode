"""Unit tests for fork_chat functionality."""

from __future__ import annotations

import json
from pathlib import Path

import chats


def test_fork_chat_copies_metadata_events_and_memory(tmp_path: Path, monkeypatch):
    source_id = "chat_source123"
    meta_path = tmp_path / f"{source_id}.json"
    ui_log_path = tmp_path / f"{source_id}.jsonl"
    mem_dir = tmp_path / "memory"
    mem_dir.mkdir(parents=True, exist_ok=True)
    mem_path = mem_dir / f"{source_id}.jsonl"

    meta_path.write_text(
        json.dumps(
            {
                "id": source_id,
                "title": "Original Topic",
                "mode": "auto",
                "message_count": 2,
                "session_cost_usd": 0.05,
            }
        ),
        encoding="utf-8",
    )

    ui_log_path.write_text(
        json.dumps({"kind": "user", "text": "Hello"}) + "\n"
        + json.dumps({"kind": "assistant", "text": "Hi there"}) + "\n",
        encoding="utf-8",
    )

    mem_path.write_text(
        json.dumps({"role": "user", "content": "Hello"}) + "\n",
        encoding="utf-8",
    )

    def mock_meta_path(cid: str) -> Path:
        return tmp_path / f"{cid}.json"

    def mock_ui_log_path(cid: str) -> Path:
        return tmp_path / f"{cid}.jsonl"

    monkeypatch.setattr(chats, "chat_meta_path", mock_meta_path)
    monkeypatch.setattr(chats, "chat_ui_log_path", mock_ui_log_path)
    monkeypatch.setattr(chats, "SESSIONS_MEMORY_DIR", mem_dir)
    monkeypatch.setattr(chats, "ensure_dirs", lambda: None)

    # Execute fork_chat
    forked_meta = chats.fork_chat(source_id)
    new_id = forked_meta["id"]

    assert new_id != source_id
    assert new_id.startswith("chat_")
    assert forked_meta["title"] == "[Forked] Original Topic"
    assert forked_meta["session_cost_usd"] == 0.05

    # Check UI log copied
    forked_ui_log = mock_ui_log_path(new_id)
    assert forked_ui_log.exists()
    events = chats.read_ui_events(new_id)
    assert len(events) == 2
    assert events[0]["text"] == "Hello"

    # Check session memory copied
    forked_mem = mem_dir / f"{new_id}.jsonl"
    assert forked_mem.exists()
    assert "Hello" in forked_mem.read_text(encoding="utf-8")
