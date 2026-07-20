"""UI log pagination for long-session chat restore."""

from __future__ import annotations

import json
from pathlib import Path

import chats


def test_read_ui_events_page_tail_and_before(tmp_path: Path, monkeypatch):
    chat_id = "chat_page_test"
    log = tmp_path / "ui.jsonl"
    log.write_text(
        "".join(json.dumps({"kind": "user", "text": f"m{i}"}) + "\n" for i in range(10)),
        encoding="utf-8",
    )

    monkeypatch.setattr(chats, "chat_ui_log_path", lambda cid: log)
    monkeypatch.setattr(chats, "ensure_dirs", lambda: None)

    page = chats.read_ui_events_page(chat_id, tail=3)
    assert page["total"] == 10
    assert page["offset"] == 7
    assert page["has_more"] is True
    assert [e["text"] for e in page["events"]] == ["m7", "m8", "m9"]

    older = chats.read_ui_events_page(chat_id, tail=3, before=page["offset"])
    assert older["offset"] == 4
    assert [e["text"] for e in older["events"]] == ["m4", "m5", "m6"]
    assert older["has_more"] is True

    head = chats.read_ui_events_page(chat_id, tail=4, before=4)
    assert head["offset"] == 0
    assert head["has_more"] is False
    assert [e["text"] for e in head["events"]] == ["m0", "m1", "m2", "m3"]
