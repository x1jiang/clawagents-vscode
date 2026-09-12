import sys
from pathlib import Path
import pytest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import providers
import pricing

@pytest.mark.parametrize("provider,ids",[("anthropic",["claude-fable-5-1","claude-opus-5","claude-sonnet-5"]),("xai",["grok-4.6"])])
def test_current_direct_catalog(provider,ids):
 models={m["id"] for p in providers._CATALOG if p["id"]==provider for m in p["models"]}
 assert set(ids)<=models

@pytest.mark.parametrize("model,rates",[("claude-fable-5-1",(10,50,.25,12.5)),("claude-opus-5",(5,25,.5,6.25)),("grok-4.6",(2,6,.5,2)),("gemini-3.6-flash",(.75,3.75,.075,.9375))])
def test_current_rates(model,rates):
 assert pricing.price_for_full(model)==rates

@pytest.mark.parametrize("model",["gpt-5.4","gpt-5.5"])
def test_current_openai_pricing_cliffs(model):
 assert pricing.long_context_multipliers(model,272000) is None
 assert pricing.long_context_multipliers(model,272001)==(2,1.5)
 assert pricing.long_context_multipliers("gpt-5.4-mini",300000) is None

@pytest.mark.parametrize("model",["minimax.minimax-m2.5","mistral.devstral-2-123b","qwen.qwen3-coder-next","nvidia.nemotron-super-3-120b","mistral.mistral-large-3-675b-instruct"])
def test_mantle_models_route_to_chat(model,monkeypatch):
 import chats
 monkeypatch.setattr(chats,"_bedrock_api_key",lambda **kwargs:"test")
 assert model in {m["id"] for m in providers._MANTLE_MODELS}
 kwargs=chats._resolve_model_kwargs(model,{"provider":"bedrock","bedrock_mode":"mantle","aws_region":"us-east-1"})
 assert kwargs["wire_api"]=="chat_completions"
 assert "bedrock-mantle.us-east-1.api.aws" in kwargs["base_url"]

@pytest.mark.parametrize("model",["us.anthropic.claude-opus-5","anthropic.claude-sonnet-5","us.anthropic.claude-fable-5-1"])
def test_unverified_aws_prices_stay_unknown(model):
 assert pricing.price_for_full(model) is None

def test_mantle_grok_current_route_and_price(monkeypatch):
 import chats
 monkeypatch.setattr(chats,"_bedrock_api_key",lambda **kwargs:"test")
 kwargs=chats._resolve_model_kwargs("xai.grok-4.6",{"provider":"bedrock","bedrock_mode":"mantle","aws_region":"us-west-2"})
 assert kwargs["wire_api"]=="responses"
 assert pricing.price_for_full("xai.grok-4.6")== (2.2,6.6,.55,2.2)
 assert pricing.price_for_full("global.xai.grok-4.6")== (2,6,.5,2)
