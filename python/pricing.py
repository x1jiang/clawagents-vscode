"""Approximate API list prices (USD per 1M tokens).

Used for sidebar cost estimates. Not a billing system — rates drift; verify on
the provider's pricing page.

Prompt caching (when the engine reports ``cached_input_tokens`` /
``cache_creation_tokens``):
- Cache *reads* are typically ~10% of the uncached input rate (90% off).
- Cache *writes* (Anthropic / GPT-5.6) are typically 1.25× the uncached input
  rate. Without cache fields the estimate is an upper bound (all input at
  full price).

Bedrock / Mantle defaults = commercial us-east-1 **Global** Standard
(Claude parity with Anthropic API). Do not use the GovCloud Anthropic row
($6/$30 Opus) — that is not OneHUB/Mantle. Regional is typically +10%.
See aws_management/BEDROCK_COST_COMPARISON.md and
https://aws.amazon.com/bedrock/pricing/
"""

from __future__ import annotations

# model_id → (input, output, cached_input_read, cache_write)
# cached/write of 0 → derive as 0.1× / 1.25× input at lookup time.
PriceTuple = tuple[float, float, float, float]

# Direct API list prices (Anthropic / OpenAI / Gemini)
PRICES: dict[str, PriceTuple] = {
    # OpenAI GPT-5.6 family (Sol / Terra / Luna) — cached read = 10%, write = 1.25×
    "gpt-5.6": (5.0, 30.0, 0.5, 6.25),
    "gpt-5.6-sol": (5.0, 30.0, 0.5, 6.25),
    "gpt-5.6-terra": (2.5, 15.0, 0.25, 3.125),
    "gpt-5.6-luna": (1.0, 6.0, 0.10, 1.25),
    # OpenAI GPT-5.5
    "gpt-5.5": (5.0, 30.0, 0.5, 6.25),
    "gpt-5.5-pro": (30.0, 180.0, 3.0, 37.5),
    # OpenAI GPT-5.4
    "gpt-5.4": (2.5, 15.0, 0.25, 3.125),
    "gpt-5.4-mini": (0.75, 4.5, 0.075, 0.9375),
    "gpt-5.4-nano": (0.2, 1.25, 0.02, 0.25),
    "gpt-5.4-pro": (30.0, 180.0, 3.0, 37.5),
    # Legacy / still listed
    "gpt-4o": (2.5, 10.0, 1.25, 3.125),
    "gpt-4o-mini": (0.15, 0.6, 0.075, 0.1875),
    # Anthropic direct API (cache read ~10%, write ~1.25×)
    "claude-opus-4": (5.0, 25.0, 0.5, 6.25),
    "claude-opus-4-5": (5.0, 25.0, 0.5, 6.25),
    "claude-opus-4-6": (5.0, 25.0, 0.5, 6.25),
    "claude-opus-4-7": (5.0, 25.0, 0.5, 6.25),
    "claude-opus-4-8": (5.0, 25.0, 0.5, 6.25),
    "claude-sonnet-4": (3.0, 15.0, 0.3, 3.75),
    "claude-sonnet-4-5": (3.0, 15.0, 0.3, 3.75),
    "claude-sonnet-4-6": (3.0, 15.0, 0.3, 3.75),
    "claude-sonnet-5": (2.0, 10.0, 0.2, 2.5),
    "claude-haiku-4-5": (1.0, 5.0, 0.1, 1.25),
    "claude-haiku-4-5-20251001": (1.0, 5.0, 0.1, 1.25),
    # Gemini (approx; standard paid tier — cache rates when reported)
    "gemini-3.5-flash": (1.5, 9.0, 0.15, 1.875),
    "gemini-3.1-pro-preview": (2.0, 12.0, 0.2, 2.5),
    "gemini-3.1-flash-lite": (0.25, 1.5, 0.025, 0.3125),
    "gemini-3-flash-preview": (0.5, 3.0, 0.05, 0.625),
    "gemini-2.5-pro": (1.25, 10.0, 0.125, 1.5625),
    "gemini-2.5-flash": (0.3, 2.5, 0.03, 0.375),
}

# Amazon Bedrock / Mantle — commercial us-east-1 Global Standard (OneHUB).
# OpenAI-on-Bedrock ~+10% vs OpenAI API (including cache tiers).
BEDROCK_PRICES: dict[str, PriceTuple] = {
    "claude-opus-4": (5.0, 25.0, 0.5, 6.25),
    "claude-opus-4-5": (5.0, 25.0, 0.5, 6.25),
    "claude-opus-4-6": (5.0, 25.0, 0.5, 6.25),
    "claude-opus-4-7": (5.0, 25.0, 0.5, 6.25),
    "claude-opus-4-8": (5.0, 25.0, 0.5, 6.25),
    "claude-sonnet-4": (3.0, 15.0, 0.3, 3.75),
    "claude-sonnet-4-5": (3.0, 15.0, 0.3, 3.75),
    "claude-sonnet-4-6": (3.0, 15.0, 0.3, 3.75),
    "claude-sonnet-5": (2.0, 10.0, 0.2, 2.5),
    "claude-haiku-4-5": (1.0, 5.0, 0.1, 1.25),
    "gpt-5.6": (5.5, 33.0, 0.55, 6.875),
    "gpt-5.6-sol": (5.5, 33.0, 0.55, 6.875),
    "gpt-5.6-terra": (2.75, 16.5, 0.275, 3.4375),
    "gpt-5.6-luna": (1.1, 6.6, 0.11, 1.375),
    "gpt-5.5": (5.5, 33.0, 0.55, 6.875),
    "gpt-5.4": (2.75, 16.5, 0.275, 3.4375),
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


def _normalize_rates(raw: tuple[float, ...] | None) -> PriceTuple | None:
    if raw is None:
        return None
    if len(raw) >= 4:
        inp, out, cached, write = float(raw[0]), float(raw[1]), float(raw[2]), float(raw[3])
    elif len(raw) == 2:
        inp, out = float(raw[0]), float(raw[1])
        cached, write = inp * 0.1, inp * 1.25
    else:
        return None
    if cached <= 0:
        cached = inp * 0.1
    if write <= 0:
        write = inp * 1.25
    return (inp, out, cached, write)


def _lookup_table(table: dict[str, PriceTuple], key: str) -> PriceTuple | None:
    if key in table:
        return _normalize_rates(table[key])
    best: PriceTuple | None = None
    best_len = -1
    for prefix, rates in table.items():
        if key.startswith(prefix + "-") or key.startswith(prefix + "_"):
            if len(prefix) > best_len:
                best = _normalize_rates(rates)
                best_len = len(prefix)
    return best


def price_for(
    model_id: str, *, provider: str | None = None
) -> tuple[float, float] | None:
    """Return ``(input_per_mtok, output_per_mtok)`` for catalog display."""
    full = price_for_full(model_id, provider=provider)
    if full is None:
        return None
    return (full[0], full[1])


def price_for_full(
    model_id: str, *, provider: str | None = None
) -> PriceTuple | None:
    """Return ``(input, output, cached_read, cache_write)`` USD per 1M tokens."""
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
    other = PRICES if table is BEDROCK_PRICES else BEDROCK_PRICES
    return _lookup_table(other, key)


def estimate_usd(
    model_id: str,
    *,
    prompt_tokens: int = 0,
    completion_tokens: int = 0,
    cached_input_tokens: int = 0,
    cache_creation_tokens: int = 0,
    provider: str | None = None,
) -> float | None:
    """Estimate USD for one run, applying prompt-cache discounts when reported.

    ``prompt_tokens`` is the provider's total input (including cached reads).
    Cached reads are billed at the cached rate; the remainder at full input.
    Cache *writes* (``cache_creation_tokens``) are billed at the write rate and
    are not subtracted from ``prompt_tokens`` (providers usually count them
    inside input already — we only add the write premium above base input when
    ``cache_creation_tokens`` is set and we treat creation as a separate line).

    Practical formula used here (matches OpenAI/Anthropic host dashboards):
    - ``cached = min(cached_input_tokens, prompt_tokens)``
    - ``uncached = prompt_tokens - cached``
    - cost = uncached×input + cached×cached_read + creation×(write−input)
      + completion×output

    The ``creation×(write−input)`` term charges only the write *premium* so we
    do not double-count tokens already in ``prompt_tokens``.
    """
    rates = price_for_full(model_id, provider=provider)
    if rates is None:
        return None
    inp, out, cached_rate, write_rate = rates
    prompt = max(0, int(prompt_tokens or 0))
    completion = max(0, int(completion_tokens or 0))
    cached = min(max(0, int(cached_input_tokens or 0)), prompt)
    uncached = prompt - cached
    creation = max(0, int(cache_creation_tokens or 0))
    write_premium = max(0.0, write_rate - inp)
    return (
        (uncached / 1_000_000.0) * inp
        + (cached / 1_000_000.0) * cached_rate
        + (creation / 1_000_000.0) * write_premium
        + (completion / 1_000_000.0) * out
    )


def attach_prices(models: list[dict]) -> list[dict]:
    out: list[dict] = []
    for m in models:
        mid = str(m.get("id") or "")
        rates = price_for_full(mid)
        row = dict(m)
        if rates:
            row["input_per_mtok"] = rates[0]
            row["output_per_mtok"] = rates[1]
            row["cached_input_per_mtok"] = rates[2]
            row["cache_write_per_mtok"] = rates[3]
        out.append(row)
    return out
