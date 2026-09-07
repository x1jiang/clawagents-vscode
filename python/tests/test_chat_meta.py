from __future__ import annotations

import chats


def test_get_chat_meta_reports_empty_log_without_reading_events(tmp_path, monkeypatch):
    meta_path = tmp_path / "chat_test.json"
    log_path = tmp_path / "chat_test.ui.jsonl"
    monkeypatch.setattr(chats, "chat_meta_path", lambda _chat_id: meta_path)
    monkeypatch.setattr(chats, "chat_ui_log_path", lambda _chat_id: log_path)
    monkeypatch.setattr(chats, "load_settings", lambda: {})
    def fail_full_restore(_chat_id):
        raise AssertionError("full chat restore used")

    monkeypatch.setattr(chats, "get_chat", fail_full_restore)
    chats.atomic_write_json(meta_path, {"id": "chat_test", "message_count": 0})

    assert chats.get_chat_meta("chat_test")["has_ui_events"] is False


def test_get_chat_meta_reports_nonempty_log(tmp_path, monkeypatch):
    meta_path = tmp_path / "chat_test.json"
    log_path = tmp_path / "chat_test.ui.jsonl"
    monkeypatch.setattr(chats, "chat_meta_path", lambda _chat_id: meta_path)
    monkeypatch.setattr(chats, "chat_ui_log_path", lambda _chat_id: log_path)
    monkeypatch.setattr(chats, "load_settings", lambda: {})
    chats.atomic_write_json(meta_path, {"id": "chat_test", "message_count": 0})
    log_path.write_text('{"kind":"status"}\n', encoding="utf-8")

    assert chats.get_chat_meta("chat_test")["has_ui_events"] is True


def test_get_chat_meta_migrates_legacy_model_route(tmp_path, monkeypatch):
    meta_path = tmp_path / "chat_test.json"
    log_path = tmp_path / "chat_test.ui.jsonl"
    monkeypatch.setattr(chats, "chat_meta_path", lambda _chat_id: meta_path)
    monkeypatch.setattr(chats, "chat_ui_log_path", lambda _chat_id: log_path)
    monkeypatch.setattr(
        chats,
        "load_settings",
        lambda: {
            "provider": "anthropic",
            "model": "claude-sonnet-4-5",
            "reasoning_effort": "high",
        },
    )
    chats.atomic_write_json(meta_path, {"id": "chat_test", "message_count": 0})

    meta = chats.get_chat_meta("chat_test")

    assert meta is not None
    assert meta["model_route"] == {
        "provider": "anthropic",
        "model": "claude-sonnet-4-5",
        "reasoning_effort": "high",
    }
    assert chats.read_json(meta_path, {})["model_route"] == meta["model_route"]
