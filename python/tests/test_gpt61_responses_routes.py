"""GPT-6.1 Sol coding chats must use Responses before the agent starts."""
import json

import pytest

import chats
import spawn_secrets


@pytest.mark.parametrize("provider", ["openai", "auto", "profile:openai"])
@pytest.mark.parametrize("wire", ["", "auto", "chat_completions", "responses"])
def test_gpt61_saved_model_routes_require_responses(provider, wire):
    route = chats.normalize_model_route({"provider": provider, "model": "gpt-6.1-sol", "wire_api": wire})
    assert route["wire_api"] == "responses"


@pytest.mark.parametrize("wire", ["", "auto", "chat_completions", "responses"])
def test_gpt61_settings_kwargs_require_responses(wire, monkeypatch):
    monkeypatch.setattr(spawn_secrets, "resolve_api_key", lambda *args: "test")
    kwargs = chats._resolve_model_kwargs(None, {
        "provider": "openai", "model": "gpt-6.1-sol", "wire_api": wire,
    })
    assert kwargs["wire_api"] == "responses"


def test_gpt61_legacy_openai_wire_api_cannot_force_chat(monkeypatch):
    monkeypatch.setattr(spawn_secrets, "resolve_api_key", lambda *args: "test")
    kwargs = chats._resolve_model_kwargs("gpt-6.1-sol", {
        "provider": "openai", "openai_wire_api": "chat_completions",
    })
    assert kwargs["wire_api"] == "responses"


def test_gpt61_existing_chat_pin_migrates_to_responses(tmp_path, monkeypatch):
    chat_id = "chat_gpt61"
    meta_path = tmp_path / f"{chat_id}.json"
    meta_path.write_text(json.dumps({"id": chat_id, "updated_at": "unchanged",
        "model_route": {"provider": "openai", "model": "gpt-6.1-sol", "wire_api": "chat_completions"}}))
    monkeypatch.setattr(chats, "chat_meta_path", lambda _: meta_path)
    meta = chats.get_chat(chat_id)
    assert meta["model_route"]["wire_api"] == "responses"
    assert json.loads(meta_path.read_text())["model_route"]["wire_api"] == "responses"
    assert meta["updated_at"] == "unchanged"


@pytest.mark.parametrize("provider,model", [
    ("openai", "gpt-6-sol"), ("ollama", "gpt-6.1-sol"),
    ("bedrock", "openai.gpt-6.1-sol"), ("auto", "openai.gpt-6.1-sol"),
])
def test_other_routes_preserve_explicit_chat(provider, model):
    route = chats.normalize_model_route({"provider": provider, "model": model,
        "wire_api": "chat_completions"})
    assert route["wire_api"] == "chat_completions"
