from __future__ import annotations

import chats
from clawagents.prompts import append_pinned_context
from clawagents.providers.llm import LLMMessage
from clawagents.memory.rules import write_pinned_context


def test_conversation_contexts_are_isolated(tmp_path, monkeypatch):
    monkeypatch.setattr(chats, "CHATS_DIR", tmp_path)
    monkeypatch.setattr(
        chats,
        "read_pinned_context_scope",
        lambda: {"all_conversations": False, "initialized": True},
    )

    first = chats.create_chat(chat_id="chat_first")
    second = chats.create_chat(chat_id="chat_second")
    assert first["pinned_context"] == ""
    assert second["pinned_context"] == ""

    chats.write_conversation_pinned_context(first["id"], "use the first environment")

    assert chats.effective_pinned_context(first["id"]) == "use the first environment"
    assert chats.effective_pinned_context(second["id"]) == ""


def test_global_context_only_wins_after_opt_in(monkeypatch):
    monkeypatch.setattr(
        chats,
        "read_conversation_pinned_context",
        lambda chat_id: f"local:{chat_id}",
    )
    monkeypatch.setattr(
        chats,
        "read_pinned_context_scope",
        lambda: {"all_conversations": False, "initialized": True},
    )
    assert chats.effective_pinned_context("chat_one") == "local:chat_one"

    monkeypatch.setattr(
        chats,
        "read_pinned_context_scope",
        lambda: {"all_conversations": True, "initialized": True},
    )
    monkeypatch.setattr(
        "clawagents.memory.rules.read_pinned_context",
        lambda _workspace: "shared workspace context",
    )
    assert chats.effective_pinned_context("chat_one") == "shared workspace context"
    assert chats.effective_pinned_context("chat_two") == "shared workspace context"


def test_conversation_context_is_bounded(tmp_path, monkeypatch):
    monkeypatch.setattr(chats, "CHATS_DIR", tmp_path)
    chats.create_chat(chat_id="chat_bounded")

    stored = chats.write_conversation_pinned_context(
        "chat_bounded",
        "x" * (chats.PINNED_CONTEXT_MAX_CHARS + 20),
    )

    assert len(stored) == chats.PINNED_CONTEXT_MAX_CHARS
    assert chats.read_conversation_pinned_context("chat_bounded") == stored


def test_scoped_hook_replaces_legacy_global_and_rereads_each_round(monkeypatch):
    class FakeAgent:
        before_llm = staticmethod(
            lambda messages: append_pinned_context(messages, "legacy global")
        )

    selected = {"text": "conversation one"}
    monkeypatch.setattr(
        chats,
        "effective_pinned_context",
        lambda _chat_id: selected["text"],
    )
    agent = FakeAgent()
    chats.apply_scoped_pinned_context(agent, "chat_one")

    first = agent.before_llm([LLMMessage(role="system", content="base")])
    assert "conversation one" in first[0].content
    assert "legacy global" not in first[0].content

    selected["text"] = "conversation one updated"
    second = agent.before_llm(first)
    assert "conversation one updated" in second[0].content
    assert "legacy global" not in second[0].content

    selected["text"] = ""
    third = agent.before_llm(second)
    assert "conversation one updated" not in third[0].content


def test_scope_file_defaults_local_and_requires_explicit_global_opt_in(
    tmp_path,
    monkeypatch,
):
    monkeypatch.setattr(chats, "WORKSPACE", tmp_path)

    assert chats.read_pinned_context_scope() == {
        "all_conversations": False,
        "initialized": False,
    }
    chats.write_pinned_context_scope(all_conversations=True)
    assert chats.read_pinned_context_scope() == {
        "all_conversations": True,
        "initialized": True,
    }


def test_pinned_api_migrates_legacy_then_switches_scopes(tmp_path, monkeypatch):
    import app
    import sys
    from fastapi.testclient import TestClient

    # Some compatibility tests remove ``chats`` from ``sys.modules``. Restore
    # the collected module so the endpoint's lazy imports stay isolated.
    monkeypatch.setitem(sys.modules, "chats", chats)
    active_chats = chats
    monkeypatch.setattr(active_chats, "WORKSPACE", tmp_path)
    monkeypatch.setattr(app, "WORKSPACE", tmp_path)
    monkeypatch.setattr(
        active_chats,
        "chat_meta_path",
        lambda cid: tmp_path / f"{cid}.json",
    )
    monkeypatch.setattr(
        active_chats,
        "chat_ui_log_path",
        lambda cid: tmp_path / f"{cid}.ui.jsonl",
    )
    monkeypatch.setattr(active_chats, "ensure_dirs", lambda: None)
    monkeypatch.setattr(app, "GATEWAY_API_KEY", "scope-token")
    monkeypatch.setattr(active_chats, "load_settings", lambda: {})
    monkeypatch.setattr(app, "get_chat", active_chats.get_chat)

    active_chats.create_chat(chat_id="chat_first")
    active_chats.create_chat(chat_id="chat_second")
    write_pinned_context("legacy context", tmp_path)

    client = TestClient(app.create_app())
    headers = {"Authorization": "Bearer scope-token"}

    first = client.get("/pinned?chat_id=chat_first", headers=headers)
    assert first.status_code == 200
    assert first.json()["text"] == "legacy context"
    assert first.json()["all_conversations"] is False

    second = client.get("/pinned?chat_id=chat_second", headers=headers)
    assert second.json()["text"] == ""

    saved_local = client.put(
        "/pinned",
        headers=headers,
        json={
            "chat_id": "chat_second",
            "text": "second only",
            "all_conversations": False,
        },
    )
    assert saved_local.status_code == 200
    assert saved_local.json()["text"] == "second only"

    saved_global = client.put(
        "/pinned",
        headers=headers,
        json={
            "chat_id": "chat_first",
            "text": "shared now",
            "all_conversations": True,
        },
    )
    assert saved_global.status_code == 200
    assert (
        client.get("/pinned?chat_id=chat_first", headers=headers).json()["text"]
        == "shared now"
    )
    assert (
        client.get("/pinned?chat_id=chat_second", headers=headers).json()["text"]
        == "shared now"
    )

    disable_global = client.put(
        "/pinned",
        headers=headers,
        json={
            "chat_id": "chat_first",
            "text": "first again",
            "all_conversations": False,
        },
    )
    assert disable_global.status_code == 200
    assert (
        client.get("/pinned?chat_id=chat_first", headers=headers).json()["text"]
        == "first again"
    )
    assert (
        client.get("/pinned?chat_id=chat_second", headers=headers).json()["text"]
        == "second only"
    )
