"""Astra appears in offline/live catalogs and routes through Mantle Responses."""
import sys
from pathlib import Path
import pytest
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import providers
import pricing
import chats

@pytest.mark.parametrize("provider,model", [("openai", "gpt-6-astra"), ("bedrock", "openai.gpt-6-astra")])
def test_astra_offline_catalog(provider, model, monkeypatch):
    import settings_store
    settings = {"provider": provider, "bedrock_mode": "mantle", "aws_region": "us-west-2"}
    monkeypatch.setattr(settings_store, "load_settings", lambda: settings)
    monkeypatch.setattr(providers, "_settings_base_url", lambda: ("", True))
    monkeypatch.setattr(providers, "_provider_credentials_present", lambda *a, **kw: True)
    rows = providers.build_provider_catalog(probe_keys=False)
    assert any(m["id"] == model for p in rows if p["id"] == provider for m in p["models"])

def test_new_remote_models_are_not_lost_on_partial_curated_overlap():
    rows = providers._merge_curated_with_remote([{ "id": "gpt-5.6-terra", "label": "Terra"}], [{"id": "gpt-5.6-terra"}, {"id": "gpt-6-astra"}])
    assert [m["id"] for m in rows] == ["gpt-5.6-terra", "gpt-6-astra"]

@pytest.mark.parametrize("model", ["gpt-6-astra", "openai.gpt-6-astra"])
def test_astra_sidecar_route(model, monkeypatch):
    monkeypatch.setattr(chats, "_bedrock_api_key", lambda **kw: "test")
    kwargs = chats._resolve_model_kwargs(model, {"provider": "bedrock", "bedrock_mode": "mantle", "aws_region": "us-west-2"})
    assert kwargs["wire_api"] == "responses"
    assert "us-west-2" in kwargs["base_url"]

@pytest.mark.parametrize("model,rate", [("gpt-6-astra", (10,50,1,12.5)), ("openai.gpt-6-astra", (11,55,1.1,13.75)), ("global.openai.gpt-6-astra", (10,50,1,12.5))])
def test_astra_pricing(model, rate):
    assert pricing.price_for_full(model) == rate
    assert pricing.long_context_multipliers(model, 272_000) is None
    assert pricing.long_context_multipliers(model, 272_001) == (2,1.5)


def test_live_openai_catalog_keeps_new_model_with_curated_overlap(monkeypatch):
    import settings_store
    monkeypatch.setattr(settings_store, "load_settings", lambda: {"provider": "openai"})
    monkeypatch.setattr(providers, "_settings_base_url", lambda: ("", True))
    monkeypatch.setattr(providers, "_provider_credentials_present", lambda *a, **kw: True)
    monkeypatch.setattr(providers, "verify_api_key", lambda *a, **kw: {"ok": True})
    monkeypatch.setattr(providers, "_probe_compatible_endpoint", lambda *a, **kw: (True, "", [
        {"id": "gpt-5.6-terra", "label": "Terra"},
        {"id": "gpt-6-astra", "label": "Astra"},
        {"id": "gpt-future", "label": "Future"},
    ]))
    rows = providers.build_provider_catalog(probe_keys=True)
    ids = {m["id"] for p in rows if p["id"] == "openai" for m in p["models"]}
    assert ids == {"gpt-5.6-terra", "gpt-6-astra", "gpt-future"}
