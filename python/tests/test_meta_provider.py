"""Meta routes retain endpoint trust and never inherit another provider's keys."""
import pytest
import chats
import providers
import settings_store
import spawn_secrets
from meta_provider import META_DEFAULT_BASE_URL, META_DEFAULT_MODEL


def test_meta_catalog_is_available_without_keys_and_never_probes(monkeypatch):
    monkeypatch.setattr(providers, "_CATALOG", [])
    monkeypatch.setattr(providers, "load_provider_profiles", lambda: {})
    monkeypatch.setattr(providers, "_probe_compatible_endpoint", lambda *a, **kw: pytest.fail("private endpoint probe"))
    monkeypatch.setenv("glimmer_30B_backend", "http://127.0.0.1:7790/v1")
    monkeypatch.setenv("glimmer_30B_model", "Custom-Glimmer")
    row = providers.build_provider_catalog(probe_keys=True)[0]
    assert row["id"] == "meta"
    assert row["available"]
    assert row["base_url"] == "http://127.0.0.1:7790/v1"
    assert row["models"][0]["id"] == "Custom-Glimmer"


def test_meta_route_forces_chat_wire_and_isolates_credentials(monkeypatch):
    monkeypatch.setattr(spawn_secrets, "_SPAWN_SECRETS", {"OPENAI_API_KEY": "secret-openai", "BEDROCK_API_KEY": "secret-aws"})
    kwargs = chats._resolve_model_kwargs(None, {
        "provider": "meta", "model": META_DEFAULT_MODEL,
        "base_url": META_DEFAULT_BASE_URL, "trust_custom_base_url": True,
        "wire_api": "responses", "reasoning_effort": "high", "bedrock_mode": "mantle",
    })
    assert kwargs["profile"] == "meta"
    assert kwargs["api_key"] == "not-needed"
    assert kwargs["wire_api"] == "chat_completions"
    assert "reasoning_effort" not in kwargs
    assert kwargs["base_url"] == META_DEFAULT_BASE_URL
    assert spawn_secrets.resolve_api_key("meta", META_DEFAULT_MODEL) is None


def test_meta_explicit_key_and_dynamic_model(monkeypatch):
    monkeypatch.setattr(spawn_secrets, "_SPAWN_SECRETS", {"META_API_KEY": "secret-meta"})
    monkeypatch.setenv("glimmer_30B_backend", "http://localhost:7790/v1")
    monkeypatch.setenv("glimmer_30B_model", "Custom-Glimmer")
    kwargs = chats._resolve_model_kwargs(None, {"provider": "meta"})
    assert kwargs["api_key"] == "secret-meta"
    assert kwargs["model"] == "Custom-Glimmer"
    assert kwargs["base_url"] == "http://localhost:7790/v1"
    assert settings_store._default_model_for_provider("meta") == "Custom-Glimmer"


def test_untrusted_meta_url_rejected(monkeypatch):
    monkeypatch.delenv("glimmer_30B_backend", raising=False)
    with pytest.raises(ValueError, match="not trusted"):
        chats._resolve_model_kwargs(None, {"provider": "meta"})


def test_thread_switch_cannot_reuse_unrelated_endpoint_trust(monkeypatch):
    monkeypatch.delenv("glimmer_30B_backend", raising=False)
    settings = chats.settings_with_model_route({
        "provider": "openai", "base_url": "https://other.test/v1",
        "trust_custom_base_url": True,
    }, {"provider": "meta", "model": META_DEFAULT_MODEL})
    assert settings["base_url"] == META_DEFAULT_BASE_URL
    assert not settings["trust_custom_base_url"]
    with pytest.raises(ValueError, match="not trusted"):
        chats._resolve_model_kwargs(None, settings)


def test_thread_switch_from_meta_does_not_send_openai_key_to_meta():
    settings = chats.settings_with_model_route({
        "provider": "meta", "base_url": META_DEFAULT_BASE_URL,
        "trust_custom_base_url": True,
    }, {"provider": "openai", "model": "gpt-5.6-luna"})
    assert settings["base_url"] == ""
    assert not settings["trust_custom_base_url"]
    assert "base_url" not in chats._resolve_model_kwargs(None, settings)


def test_auto_meta_route_uses_meta_profile(monkeypatch):
    monkeypatch.delenv("glimmer_30B_backend", raising=False)
    settings = chats.settings_with_model_route({
        "provider": "meta", "base_url": META_DEFAULT_BASE_URL,
        "trust_custom_base_url": True,
    }, {"provider": "auto", "model": META_DEFAULT_MODEL})
    assert settings["provider"] == "meta"
    assert chats._resolve_model_kwargs(None, settings)["profile"] == "meta"
    assert chats.normalize_model_route({"provider": "meta", "model": META_DEFAULT_MODEL})


def test_openai_verify_does_not_probe_meta_with_openai_key(monkeypatch):
    monkeypatch.setattr(providers, "_settings_base_url", lambda: (META_DEFAULT_BASE_URL, True))
    monkeypatch.setattr(settings_store, "load_settings", lambda: {"provider": "meta"})
    monkeypatch.setattr(providers, "_probe_compatible_endpoint", lambda *a, **kw: pytest.fail("key leaked to Meta"))
    import urllib.request
    requests = []
    class Response:
        def __enter__(self): return self
        def __exit__(self, *a): pass
    monkeypatch.setattr(urllib.request, "urlopen", lambda req, **kw: requests.append(req.full_url) or Response())
    assert providers._probe_key("openai", "secret-openai")[0]
    assert requests == ["https://api.openai.com/v1/models"]


def test_meta_default_endpoint_reaches_preflight_trust_check(monkeypatch):
    monkeypatch.delenv("glimmer_30B_backend", raising=False)
    settings = chats.settings_with_model_route({"provider": "meta"}, {
        "provider": "meta", "model": META_DEFAULT_MODEL,
    })
    assert settings["base_url"] == META_DEFAULT_BASE_URL
    assert not settings["trust_custom_base_url"]


def test_uppercase_meta_environment_aliases(monkeypatch):
    from meta_provider import meta_base_url, meta_model
    monkeypatch.delenv("glimmer_30B_backend", raising=False)
    monkeypatch.delenv("glimmer_30B_model", raising=False)
    monkeypatch.setenv("GLIMMER_30B_BACKEND", "http://localhost:8800/v1")
    monkeypatch.setenv("GLIMMER_30B_MODEL", "Custom-Glimmer")
    assert meta_base_url() == "http://localhost:8800/v1"
    assert meta_model() == "Custom-Glimmer"
