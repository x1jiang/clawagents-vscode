"""GPT-6 OpenAI catalogs and provider-specific price estimates."""
import pytest
import providers
import pricing

@pytest.mark.parametrize("model,rates", [
    ("gpt-6.1-sol", (2, 10, .1, 2.5)),
    ("gpt-6-sol", (2, 10, .2, 2.5)),
    ("gpt-6-luna", (.1, .5, .01, .125)),
])
def test_gpt6_catalog_and_prices(model, rates):
    openai = next(p for p in providers._CATALOG if p["id"] == "openai")
    assert openai["models"][0]["id"] == "gpt-5.6-terra"
    assert any(m["id"] == model for m in openai["models"])
    assert pricing.price_for_full(model) == rates
    assert pricing.price_for_full(model + "-2026-09-22") == rates
    assert pricing.price_for_full(model, provider="bedrock") is None
    assert pricing.price_for_full("openai." + model) is None

    assert pricing.long_context_multipliers(model, 272_000) is None
    assert pricing.long_context_multipliers(model, 272_001) == (2, 1.5)


def test_gpt61_sol_cached_input_pricing():
    assert pricing.estimate_usd("gpt-6.1-sol", prompt_tokens=100_000, completion_tokens=10_000,
        cached_input_tokens=50_000) == pytest.approx(.205)
