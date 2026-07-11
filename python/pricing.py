"""Approximate API list prices (USD per 1M tokens).

Used for sidebar cost estimates. Not a billing system — rates drift; verify on
the provider's pricing page. Cache discounts and long-context multipliers are
ignored (estimate is an upper bound for uncached short-context traffic).
"""

from __future__ import annotations

# model_id -> (input_usd_per_mtok, output_usd_per_mtok)
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
    # Anthropic (approx)
    "claude-sonnet-4-5": (3.0, 15.0),
    "claude-opus-4-6": (15.0, 75.0),
    "claude-haiku-4-5-20251001": (1.0, 5.0),
    # Gemini (approx; standard paid tier, short-context rates)
    "gemini-3.5-flash": (1.5, 9.0),
    "gemini-3.1-pro-preview": (2.0, 12.0),
    "gemini-3.1-flash-lite": (0.25, 1.5),
    "gemini-3-flash-preview": (0.5, 3.0),
    "gemini-2.5-pro": (1.25, 10.0),
    "gemini-2.5-flash": (0.3, 2.5),
}


def price_for(model_id: str) -> tuple[float, float] | None:
    if not model_id:
        return None
    key = model_id.strip().lower()
    if key in PRICES:
        return PRICES[key]
    # Snapshot ids like gpt-5.5-2026-04-23 — longest prefix wins so
    # gpt-5.5-pro-… does not match gpt-5.5 first.
    best: tuple[float, float] | None = None
    best_len = -1
    for prefix, rates in PRICES.items():
        if key.startswith(prefix + "-") or key.startswith(prefix + "_"):
            if len(prefix) > best_len:
                best = rates
                best_len = len(prefix)
    return best


def estimate_usd(
    model_id: str,
    *,
    prompt_tokens: int = 0,
    completion_tokens: int = 0,
) -> float | None:
    rates = price_for(model_id)
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
