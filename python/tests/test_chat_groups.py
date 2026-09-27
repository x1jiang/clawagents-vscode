from __future__ import annotations

import json
from pathlib import Path

import pytest

import chats


def configure_store(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(chats, "CHAT_GROUPS_FILE", tmp_path / "groups.json")
    monkeypatch.setattr(chats, "CHATS_DIR", tmp_path)
    monkeypatch.setattr(chats, "chat_meta_path", lambda chat_id: tmp_path / f"{chat_id}.json")
    monkeypatch.setattr(chats, "chat_ui_log_path", lambda chat_id: tmp_path / f"{chat_id}.ui.jsonl")
    monkeypatch.setattr(chats, "load_settings", lambda: {})
    monkeypatch.setattr(chats, "ensure_dirs", lambda: None)


def write_chat(tmp_path: Path, chat_id: str, **values: object) -> None:
    (tmp_path / f"{chat_id}.json").write_text(
        json.dumps({"id": chat_id, "title": chat_id, "updated_at": 1, **values}),
        encoding="utf-8",
    )


def test_chat_group_crud_and_manual_order(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    configure_store(tmp_path, monkeypatch)

    first = chats.create_chat_group("  CCMV  ")
    second = chats.create_chat_group("Research")
    assert chats.list_chat_groups() == [first, second]

    with pytest.raises(ValueError, match="already exists"):
        chats.create_chat_group("ccmv")

    renamed = chats.rename_chat_group(second["id"], "Evidence")
    assert renamed["name"] == "Evidence"
    assert chats.reorder_chat_groups([second["id"], first["id"]]) == [renamed, first]


def test_move_archive_restore_and_delete_group(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    configure_store(tmp_path, monkeypatch)
    group = chats.create_chat_group("CCMV")
    write_chat(tmp_path, "chat_one", archived=False, pinned=False)

    moved = chats.patch_chat("chat_one", group_id=group["id"])
    assert moved["group_id"] == group["id"]
    assert chats.patch_chat("chat_one", archived=True)["group_id"] == group["id"]
    assert chats.patch_chat("chat_one", archived=False)["group_id"] == group["id"]

    result = chats.delete_chat_group(group["id"])
    assert result == {"archived_chats": 1}
    stored = json.loads((tmp_path / "chat_one.json").read_text(encoding="utf-8"))
    assert stored["archived"] is True
    assert "group_id" not in stored
    assert chats.list_chat_groups() == []


def test_clearing_group_membership_uses_explicit_none(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    configure_store(tmp_path, monkeypatch)
    group = chats.create_chat_group("CCMV")
    write_chat(tmp_path, "chat_one", group_id=group["id"])

    updated = chats.patch_chat("chat_one", group_id=None)

    assert "group_id" not in updated
