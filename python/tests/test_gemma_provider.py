import pytest
import chats
import providers
import settings_store
import spawn_secrets
from gemma_provider import GEMMA_PROFILE,GEMMA_MODEL


def test_gemma_catalog_offline(monkeypatch):
    monkeypatch.setattr(providers,'_CATALOG',[])
    monkeypatch.setattr(providers,'load_provider_profiles',lambda:{})
    row=next(p for p in providers.build_provider_catalog(probe_keys=False) if p['id']==GEMMA_PROFILE)
    assert row['models'][0]['id']==GEMMA_MODEL
    assert row['base_url']=='http://127.0.0.1:18080/v1'


def test_gemma_route_isolates_credentials(monkeypatch):
    monkeypatch.setattr(spawn_secrets,'_SPAWN_SECRETS',{'OPENAI_API_KEY':'do-not-forward'})
    args=chats._resolve_model_kwargs(None,{'provider':GEMMA_PROFILE,'model':GEMMA_MODEL})
    assert args['profile']=='gemma-agentic'
    assert args['api_key']=='not-needed'
    assert args['wire_api']=='chat_completions'
    assert settings_store._default_model_for_provider(GEMMA_PROFILE)==GEMMA_MODEL
    assert not settings_store._model_fits_provider('gpt-5.6-luna',GEMMA_PROFILE)


def test_gemma_untrusted_remote_is_rejected(monkeypatch):
    monkeypatch.setenv('GEMMA_AGENTIC_BASE_URL','http://untrusted.example/v1')
    with pytest.raises(ValueError,match='Approve'):
        chats._resolve_model_kwargs(None,{'provider':GEMMA_PROFILE,'model':GEMMA_MODEL})


def test_switch_away_from_gemma_clears_endpoint():
    settings = chats.settings_with_model_route({
        "provider": GEMMA_PROFILE, "base_url": "http://localhost:18080/v1",
        "trust_custom_base_url": True,
    }, {"provider": "openai", "model": "gpt-5.6-luna"})
    assert settings["base_url"] == ""
    assert not settings["trust_custom_base_url"]
    assert "base_url" not in chats._resolve_model_kwargs(None, settings)


def test_switch_to_gemma_discards_unrelated_url_trust(monkeypatch):
    monkeypatch.setenv("GEMMA_AGENTIC_BASE_URL", "http://untrusted.example/v1")
    settings = chats.settings_with_model_route({
        "provider": "meta", "base_url": "http://previous.example/v1",
        "trust_custom_base_url": True,
    }, {"provider": GEMMA_PROFILE, "model": GEMMA_MODEL})
    assert settings["base_url"] == "http://untrusted.example/v1"
    assert not settings["trust_custom_base_url"]
    with pytest.raises(ValueError, match="Approve"):
        chats._resolve_model_kwargs(None, settings)
