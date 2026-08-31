"""Per-conversation model routing and migration coverage."""

from __future__ import annotations

import json
from pathlib import Path

import chats


def _isolate_chat_files(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(chats, "chat_meta_path", lambda cid: tmp_path / f"{cid}.json")
    monkeypatch.setattr(chats, "chat_ui_log_path", lambda cid: tmp_path / f"{cid}.ui.jsonl")
    monkeypatch.setattr(chats, "ensure_dirs", lambda: None)


def test_new_chat_snapshots_default_model_route(tmp_path: Path, monkeypatch):
    _isolate_chat_files(tmp_path, monkeypatch)
    monkeypatch.setattr(
        chats,
        "load_settings",
        lambda: {
            "provider": "openai",
            "model": "gpt-5.6-terra",
            "reasoning_effort": "medium",
        },
    )

    meta = chats.create_chat(chat_id="chat_route_new")

    assert meta["model_route"] == {
        "provider": "openai",
        "model": "gpt-5.6-terra",
        "reasoning_effort": "medium",
    }


def test_old_chat_is_migrated_without_changing_timestamp(tmp_path: Path, monkeypatch):
    _isolate_chat_files(tmp_path, monkeypatch)
    path = tmp_path / "chat_legacy.json"
    path.write_text(
        json.dumps(
            {
                "id": "chat_legacy",
                "title": "Legacy",
                "updated_at": 123.0,
                "session_cost_usd": 0.0,
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(
        chats,
        "load_settings",
        lambda: {"provider": "anthropic", "model": "claude-sonnet-4-5"},
    )

    meta = chats.get_chat("chat_legacy")

    assert meta is not None
    assert meta["updated_at"] == 123.0
    assert meta["model_route"] == {
        "provider": "anthropic",
        "model": "claude-sonnet-4-5",
        "reasoning_effort": "",
    }
    assert json.loads(path.read_text(encoding="utf-8"))["model_route"] == meta["model_route"]


def test_route_overlay_isolated_between_threads():
    defaults = {
        "provider": "openai",
        "model": "gpt-5.6-terra",
        "reasoning_effort": "medium",
        "base_url": "",
    }
    openai = chats.settings_with_model_route(
        defaults,
        {"provider": "openai", "model": "gpt-5.6-terra", "reasoning_effort": "high"},
    )
    anthropic = chats.settings_with_model_route(
        defaults,
        {"provider": "anthropic", "model": "claude-sonnet-4-5"},
    )

    assert openai["provider"] == "openai"
    assert openai["reasoning_effort"] == "high"
    assert anthropic["provider"] == "anthropic"
    assert anthropic["model"] == "claude-sonnet-4-5"
    assert anthropic["reasoning_effort"] == ""
    assert defaults["provider"] == "openai"


def test_route_overlay_preserves_global_proxy_configuration():
    defaults = {
        "provider": "openai",
        "model": "gpt-5.6-terra",
        "base_url": "https://proxy.example.test/v1",
        "trust_custom_base_url": True,
        "ssl_verify": False,
    }

    effective = chats.settings_with_model_route(
        defaults,
        {"provider": "anthropic", "model": "claude-sonnet-4-5"},
    )

    assert effective["provider"] == "anthropic"
    assert effective["base_url"] == "https://proxy.example.test/v1"
    assert effective["trust_custom_base_url"] is True
    assert effective["ssl_verify"] is False


def test_openai_thread_uses_trusted_global_proxy_endpoint():
    settings = chats.settings_with_model_route(
        {
            "provider": "openai",
            "model": "gpt-5.6-terra",
            "base_url": "https://proxy.example.test/v1",
            "trust_custom_base_url": True,
            "ssl_verify": False,
        },
        {
            "provider": "openai",
            "model": "gpt-5.6-luna",
            "reasoning_effort": "medium",
        },
    )

    kwargs = chats._resolve_model_kwargs(None, settings)

    assert kwargs["base_url"] == "https://proxy.example.test/v1"
    assert kwargs["model"] == "gpt-5.6-luna"
    assert kwargs["ssl_verify"] is False


def test_legacy_route_drops_endpoint_override(tmp_path: Path, monkeypatch):
    _isolate_chat_files(tmp_path, monkeypatch)
    path = tmp_path / "chat_legacy_proxy.json"
    path.write_text(
        json.dumps(
            {
                "id": "chat_legacy_proxy",
                "title": "Legacy proxy",
                "updated_at": 123.0,
                "session_cost_usd": 0.0,
                "model_route": {
                    "provider": "openai",
                    "model": "gpt-5.6-terra",
                    "base_url": "",
                    "ssl_verify": True,
                },
            }
        ),
        encoding="utf-8",
    )

    meta = chats.get_chat("chat_legacy_proxy")

    assert meta is not None
    assert meta["model_route"] == {
        "provider": "openai",
        "model": "gpt-5.6-terra",
        "reasoning_effort": "",
    }
    assert json.loads(path.read_text(encoding="utf-8"))["model_route"] == meta["model_route"]


def test_invalid_route_is_not_persisted(tmp_path: Path, monkeypatch):
    _isolate_chat_files(tmp_path, monkeypatch)
    monkeypatch.setattr(
        chats,
        "load_settings",
        lambda: {"provider": "openai", "model": "gpt-5.6-terra"},
    )
    chats.create_chat(chat_id="chat_invalid")

    meta = chats.patch_chat(
        "chat_invalid",
        model_route={"provider": "../../evil", "model": "stolen"},
    )

    assert meta["model_route"]["provider"] == "openai"
    assert meta["model_route"]["model"] == "gpt-5.6-terra"


def test_model_route_change_writes_one_durable_transcript_notice(tmp_path: Path, monkeypatch):
    _isolate_chat_files(tmp_path, monkeypatch)
    monkeypatch.setattr(
        chats,
        "load_settings",
        lambda: {"provider": "openai", "model": "gpt-5.6-terra"},
    )
    chats.create_chat(
        chat_id="chat_change_notice",
        model_route={
            "provider": "openai",
            "model": "gpt-5.6-terra",
            "reasoning_effort": "medium",
        },
    )

    # A transport-only change is invisible in the capsule and should stay quiet.
    chats.patch_chat(
        "chat_change_notice",
        model_route={
            "provider": "openai",
            "model": "gpt-5.6-terra",
            "reasoning_effort": "medium",
            "wire_api": "responses",
        },
    )
    chats.patch_chat(
        "chat_change_notice",
        model_route={
            "provider": "openai",
            "model": "gpt-5.6-luna",
            "reasoning_effort": "high",
        },
    )

    notices = [
        event
        for event in chats.read_ui_events("chat_change_notice")
        if event["kind"] == "model_change"
    ]
    assert len(notices) == 1
    assert notices[0]["text"] == (
        "Model changed from OpenAI · gpt-5.6-terra · Medium "
        "to OpenAI · gpt-5.6-luna · High."
    )


def test_chat_api_round_trips_model_route(tmp_path: Path, monkeypatch):
    import app
    from fastapi.testclient import TestClient

    _isolate_chat_files(tmp_path, monkeypatch)
    monkeypatch.setattr(app, "GATEWAY_API_KEY", "route-token")
    monkeypatch.setattr(
        chats,
        "load_settings",
        lambda: {"provider": "openai", "model": "gpt-5.6-terra"},
    )
    client = TestClient(app.create_app())
    headers = {"Authorization": "Bearer route-token"}

    created = client.post(
        "/chats",
        headers=headers,
        json={
            "mode": "auto",
            "model_route": {
                "provider": "anthropic",
                "model": "claude-sonnet-4-5",
            },
        },
    )
    assert created.status_code == 200, created.text
    chat_id = created.json()["id"]
    assert created.json()["model_route"]["provider"] == "anthropic"

    patched = client.patch(
        f"/chats/{chat_id}",
        headers=headers,
        json={
            "model_route": {
                "provider": "openai",
                "model": "gpt-5.6-luna",
                "reasoning_effort": "low",
            }
        },
    )
    assert patched.status_code == 200, patched.text
    assert patched.json()["model_route"]["model"] == "gpt-5.6-luna"

    restored = client.get(f"/chats/{chat_id}", headers=headers)
    assert restored.status_code == 200, restored.text
    assert restored.json()["model_route"] == patched.json()["model_route"]
