"""Approximate API list prices (USD per 1M tokens).

Used for sidebar cost estimates. Not a billing system — rates drift; verify on
the provider's pricing page. Cache discounts and long-context multipliers are
ignored (estimate is an upper bound for uncached short-context traffic).

Bedrock / Mantle defaults = commercial us-east-1 **Global** Standard
(Claude parity with Anthropic API). Do not use the GovCloud Anthropic row
($6/$30 Opus) — that is not OneHUB/Mantle. Regional is typically +10%.
See aws_management/BEDROCK_COST_COMPARISON.md and
https://aws.amazon.com/bedrock/pricing/
"""

from __future__ import annotations

# Direct API list prices (Anthropic / OpenAI / Gemini) — model_id → (in, out)
PRICES: dict[str, tuple[float, float]] = {
    # OpenAI GPT-5.6 family (Sol / Terra / Luna)
    "gpt-5.6": (5.0, 30.0),  # alias → Sol
    "gpt-5.6-sol": (5.0, 30.0),
    "gpt-5.6-terra": (2.5, 15.0),
    "gpt-5.6-luna": (1.0, 6.0),
    # OpenAI GPT-5.5
    "gpt-5.5": (5.0, 30.0),
    "gpt-5.5-pro": (30.0, 180.0),
    # OpenAI GPT-5.4
    "gpt-5.4": (2.5, 15.0),
    "gpt-5.4-mini": (0.75, 4.5),
    "gpt-5.4-nano": (0.2, 1.25),
    "gpt-5.4-pro": (30.0, 180.0),
    # Legacy / still listed
    "gpt-4o": (2.5, 10.0),
    "gpt-4o-mini": (0.15, 0.6),
    # Anthropic direct API (approx; Opus 4.5+ = $5/$25)
    "claude-opus-4": (5.0, 25.0),
    "claude-opus-4-5": (5.0, 25.0),
    "claude-opus-4-6": (5.0, 25.0),
    "claude-opus-4-7": (5.0, 25.0),
    "claude-opus-4-8": (5.0, 25.0),
    "claude-sonnet-4": (3.0, 15.0),
    "claude-sonnet-4-5": (3.0, 15.0),
    "claude-sonnet-4-6": (3.0, 15.0),
    "claude-sonnet-5": (2.0, 10.0),  # Bedrock promo note; same ballpark
    "claude-haiku-4-5": (1.0, 5.0),
    "claude-haiku-4-5-20251001": (1.0, 5.0),
    # Gemini (approx; standard paid tier, short-context rates)
    "gemini-3.5-flash": (1.5, 9.0),
    "gemini-3.1-pro-preview": (2.0, 12.0),
    "gemini-3.1-flash-lite": (0.25, 1.5),
    "gemini-3-flash-preview": (0.5, 3.0),
    "gemini-2.5-pro": (1.25, 10.0),
    "gemini-2.5-flash": (0.3, 2.5),
}

# Amazon Bedrock / Mantle — commercial us-east-1 Global Standard (OneHUB).
# GovCloud Opus is $6/$30 — intentionally NOT used here.
# Regional Claude would be ~+10% ($5.50/$27.50 Opus); we estimate Global.
BEDROCK_PRICES: dict[str, tuple[float, float]] = {
    # Anthropic on Bedrock Global (= Claude API)
    "claude-opus-4": (5.0, 25.0),
    "claude-opus-4-5": (5.0, 25.0),
    "claude-opus-4-6": (5.0, 25.0),
    "claude-opus-4-7": (5.0, 25.0),
    "claude-opus-4-8": (5.0, 25.0),
    "claude-sonnet-4": (3.0, 15.0),
    "claude-sonnet-4-5": (3.0, 15.0),
    "claude-sonnet-4-6": (3.0, 15.0),
    "claude-sonnet-5": (2.0, 10.0),  # promo through 2026-08-31 → then $3/$15
    "claude-haiku-4-5": (1.0, 5.0),
    # OpenAI on Bedrock (~+10% vs OpenAI API)
    "gpt-5.6": (5.5, 33.0),
    "gpt-5.6-sol": (5.5, 33.0),
    "gpt-5.6-terra": (2.75, 16.5),
    "gpt-5.6-luna": (1.1, 6.6),
    "gpt-5.5": (5.5, 33.0),
    "gpt-5.4": (2.75, 16.5),
}

_GEO_PREFIXES = (
    "global.",
    "us.",
    "eu.",
    "apac.",
    "ap.",
    "af.",
    "me.",
    "ca.",
    "sa.",
)
_PROVIDER_DOT_PREFIXES = (
    "anthropic.",
    "openai.",
    "amazon.",
    "meta.",
    "mistral.",
    "cohere.",
    "ai21.",
)


def _looks_bedrock(model_id: str) -> bool:
    """True for Mantle / Bedrock FM ids (``anthropic.claude-…``, ``us.openai.…``)."""
    m = (model_id or "").strip().lower()
    if not m:
        return False
    if m.startswith("bedrock/") or m.startswith("bedrock."):
        return True
    if m.startswith(_GEO_PREFIXES):
        return True
    if m.startswith(_PROVIDER_DOT_PREFIXES):
        return True
    return False


def normalize_model_id(model_id: str) -> str:
    """Strip Bedrock geo / provider prefixes and ``:revision`` suffixes."""
    key = (model_id or "").strip().lower()
    if not key:
        return key
    if key.startswith("bedrock/"):
        key = key[len("bedrock/") :]
    for prefix in _GEO_PREFIXES:
        if key.startswith(prefix):
            key = key[len(prefix) :]
            break
    for prefix in _PROVIDER_DOT_PREFIXES:
        if key.startswith(prefix):
            key = key[len(prefix) :]
            break
    if ":" in key:
        key = key.split(":", 1)[0]
    return key


def _lookup_table(table: dict[str, tuple[float, float]], key: str) -> tuple[float, float] | None:
    if key in table:
        return table[key]
    best: tuple[float, float] | None = None
    best_len = -1
    for prefix, rates in table.items():
        if key.startswith(prefix + "-") or key.startswith(prefix + "_"):
            if len(prefix) > best_len:
                best = rates
                best_len = len(prefix)
    return best


def price_for(
    model_id: str, *, provider: str | None = None
) -> tuple[float, float] | None:
    if not model_id:
        return None
    raw = model_id.strip()
    key = normalize_model_id(raw)
    if not key or key == "default":
        return None
    prov = (provider or "").strip().lower()
    force_bedrock = prov in ("bedrock", "mantle", "amazon", "aws")
    use_bedrock = force_bedrock or _looks_bedrock(raw)
    table = BEDROCK_PRICES if use_bedrock else PRICES
    hit = _lookup_table(table, key)
    if hit is not None:
        return hit
    # Mantle bare ids after strip still miss — try the other table as fallback.
    other = PRICES if table is BEDROCK_PRICES else BEDROCK_PRICES
    return _lookup_table(other, key)


def estimate_usd(
    model_id: str,
    *,
    prompt_tokens: int = 0,
    completion_tokens: int = 0,
    provider: str | None = None,
) -> float | None:
    rates = price_for(model_id, provider=provider)
    if rates is None:
        return None
    inp, out = rates
    return (prompt_tokens / 1_000_000.0) * inp + (completion_tokens / 1_000_000.0) * out


def attach_prices(models: list[dict]) -> list[dict]:
    out: list[dict] = []
    for m in models:
        mid = str(m.get("id") or "")
        rates = price_for(mid)
        row = dict(m)
        if rates:
            row["input_per_mtok"] = rates[0]
            row["output_per_mtok"] = rates[1]
        out.append(row)
    return out
