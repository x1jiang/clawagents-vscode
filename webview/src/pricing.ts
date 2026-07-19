/** USD per 1M tokens — mirrors python/pricing.py for offline header estimates.
 *
 * Bedrock / Mantle = commercial us-east-1 Global Standard (Claude parity with
 * Anthropic). GovCloud Opus $6/$30 is NOT used — that is a different table.
 * OpenAI-on-Bedrock is ~+10% vs OpenAI API.
 *
 * Cache tiers: cached input read (~10% of input) and cache write (1.25× input).
 * When the host reports cached_input_tokens / cache_creation_tokens, estimates
 * apply those discounts; otherwise all input is billed at the full rate.
 */

type Rates = {
  input: number;
  output: number;
  cachedInput: number;
  cacheWrite: number;
};

function withCache(input: number, output: number, cached?: number, write?: number): Rates {
  return {
    input,
    output,
    cachedInput: cached ?? input * 0.1,
    cacheWrite: write ?? input * 1.25,
  };
}

const PRICES: Record<string, Rates> = {
  "gpt-5.6": withCache(5, 30, 0.5, 6.25),
  "gpt-5.6-sol": withCache(5, 30, 0.5, 6.25),
  "gpt-5.6-terra": withCache(2.5, 15, 0.25, 3.125),
  "gpt-5.6-luna": withCache(1, 6, 0.1, 1.25),
  "gpt-5.5": withCache(5, 30, 0.5, 6.25),
  "gpt-5.5-pro": withCache(30, 180, 3, 37.5),
  "gpt-5.4": withCache(2.5, 15, 0.25, 3.125),
  "gpt-5.4-mini": withCache(0.75, 4.5, 0.075, 0.9375),
  "gpt-5.4-nano": withCache(0.2, 1.25, 0.02, 0.25),
  "gpt-5.4-pro": withCache(30, 180, 3, 37.5),
  "gpt-4o": withCache(2.5, 10, 1.25, 3.125),
  "gpt-4o-mini": withCache(0.15, 0.6, 0.075, 0.1875),
  "claude-opus-4": withCache(5, 25, 0.5, 6.25),
  "claude-opus-4-5": withCache(5, 25, 0.5, 6.25),
  "claude-opus-4-6": withCache(5, 25, 0.5, 6.25),
  "claude-opus-4-7": withCache(5, 25, 0.5, 6.25),
  "claude-opus-4-8": withCache(5, 25, 0.5, 6.25),
  "claude-sonnet-4": withCache(3, 15, 0.3, 3.75),
  "claude-sonnet-4-5": withCache(3, 15, 0.3, 3.75),
  "claude-sonnet-4-6": withCache(3, 15, 0.3, 3.75),
  "claude-sonnet-5": withCache(2, 10, 0.2, 2.5),
  "claude-haiku-4-5": withCache(1, 5, 0.1, 1.25),
  "claude-haiku-4-5-20251001": withCache(1, 5, 0.1, 1.25),
  "gemini-3.5-flash": withCache(1.5, 9),
  "gemini-3.1-pro-preview": withCache(2, 12),
  "gemini-3.1-flash-lite": withCache(0.25, 1.5),
  "gemini-3-flash-preview": withCache(0.5, 3),
  "gemini-2.5-pro": withCache(1.25, 10),
  "gemini-2.5-flash": withCache(0.3, 2.5),
};

/** Bedrock / Mantle commercial Global Standard (OneHUB us-east-1). */
const BEDROCK_PRICES: Record<string, Rates> = {
  "claude-opus-4": withCache(5, 25, 0.5, 6.25),
  "claude-opus-4-5": withCache(5, 25, 0.5, 6.25),
  "claude-opus-4-6": withCache(5, 25, 0.5, 6.25),
  "claude-opus-4-7": withCache(5, 25, 0.5, 6.25),
  "claude-opus-4-8": withCache(5, 25, 0.5, 6.25),
  "claude-sonnet-4": withCache(3, 15, 0.3, 3.75),
  "claude-sonnet-4-5": withCache(3, 15, 0.3, 3.75),
  "claude-sonnet-4-6": withCache(3, 15, 0.3, 3.75),
  "claude-sonnet-5": withCache(2, 10, 0.2, 2.5),
  "claude-haiku-4-5": withCache(1, 5, 0.1, 1.25),
  "gpt-5.6": withCache(5.5, 33, 0.55, 6.875),
  "gpt-5.6-sol": withCache(5.5, 33, 0.55, 6.875),
  "gpt-5.6-terra": withCache(2.75, 16.5, 0.275, 3.4375),
  "gpt-5.6-luna": withCache(1.1, 6.6, 0.11, 1.375),
  "gpt-5.5": withCache(5.5, 33, 0.55, 6.875),
  "gpt-5.4": withCache(2.75, 16.5, 0.275, 3.4375),
};

const GEO_PREFIXES = ["global.", "us.", "eu.", "apac.", "ap.", "af.", "me.", "ca.", "sa."] as const;
const PROVIDER_DOT_PREFIXES = [
  "anthropic.",
  "openai.",
  "amazon.",
  "meta.",
  "mistral.",
  "cohere.",
  "ai21.",
] as const;

export type ModelPrice = {
  input_per_mtok?: number;
  output_per_mtok?: number;
  cached_input_per_mtok?: number;
  cache_write_per_mtok?: number;
};

function looksBedrock(modelId: string): boolean {
  const m = modelId.trim().toLowerCase();
  if (!m) return false;
  if (m.startsWith("bedrock/") || m.startsWith("bedrock.")) return true;
  if (GEO_PREFIXES.some((p) => m.startsWith(p))) return true;
  if (PROVIDER_DOT_PREFIXES.some((p) => m.startsWith(p))) return true;
  return false;
}

export function normalizeModelId(modelId: string): string {
  let key = modelId.trim().toLowerCase();
  if (!key) return key;
  if (key.startsWith("bedrock/")) key = key.slice("bedrock/".length);
  for (const p of GEO_PREFIXES) {
    if (key.startsWith(p)) {
      key = key.slice(p.length);
      break;
    }
  }
  for (const p of PROVIDER_DOT_PREFIXES) {
    if (key.startsWith(p)) {
      key = key.slice(p.length);
      break;
    }
  }
  if (key.includes(":")) key = key.split(":", 1)[0]!;
  return key;
}

function lookupTable(table: Record<string, Rates>, key: string): Rates | null {
  if (table[key]) return table[key];
  let best: Rates | null = null;
  let bestLen = -1;
  for (const [prefix, rates] of Object.entries(table)) {
    if (key.startsWith(`${prefix}-`) || key.startsWith(`${prefix}_`)) {
      if (prefix.length > bestLen) {
        best = rates;
        bestLen = prefix.length;
      }
    }
  }
  return best;
}

function lookup(
  modelId: string,
  fromModel?: ModelPrice,
  provider?: string,
): Rates | null {
  if (
    fromModel &&
    typeof fromModel.input_per_mtok === "number" &&
    typeof fromModel.output_per_mtok === "number"
  ) {
    const inp = fromModel.input_per_mtok;
    return {
      input: inp,
      output: fromModel.output_per_mtok,
      cachedInput:
        typeof fromModel.cached_input_per_mtok === "number"
          ? fromModel.cached_input_per_mtok
          : inp * 0.1,
      cacheWrite:
        typeof fromModel.cache_write_per_mtok === "number"
          ? fromModel.cache_write_per_mtok
          : inp * 1.25,
    };
  }
  const raw = modelId.trim();
  const key = normalizeModelId(raw);
  if (!key || key === "default") return null;
  const prov = (provider || "").trim().toLowerCase();
  const forceBedrock = ["bedrock", "mantle", "amazon", "aws"].includes(prov);
  const primary = forceBedrock || looksBedrock(raw) ? BEDROCK_PRICES : PRICES;
  const hit = lookupTable(primary, key);
  if (hit) return hit;
  const other = primary === BEDROCK_PRICES ? PRICES : BEDROCK_PRICES;
  return lookupTable(other, key);
}

export function estimateCostUsd(
  modelId: string,
  promptTokens: number,
  completionTokens: number,
  fromModel?: ModelPrice,
  provider?: string,
  cachedInputTokens: number = 0,
  cacheCreationTokens: number = 0,
): number | null {
  const rates = lookup(modelId, fromModel, provider);
  if (!rates) {
    return null;
  }
  const prompt = Math.max(0, promptTokens || 0);
  const completion = Math.max(0, completionTokens || 0);
  const cached = Math.min(Math.max(0, cachedInputTokens || 0), prompt);
  const uncached = prompt - cached;
  const creation = Math.max(0, cacheCreationTokens || 0);
  const writePremium = Math.max(0, rates.cacheWrite - rates.input);
  return (
    (uncached / 1_000_000) * rates.input +
    (cached / 1_000_000) * rates.cachedInput +
    (creation / 1_000_000) * writePremium +
    (completion / 1_000_000) * rates.output
  );
}

/** Format like $0.12 / $1.20 / <$0.01 */
export function formatUsd(amount: number): string {
  if (amount < 0.01 && amount > 0) {
    return "<$0.01";
  }
  if (amount < 1) {
    return `$${amount.toFixed(2)}`;
  }
  if (amount < 100) {
    return `$${amount.toFixed(2)}`;
  }
  return `$${amount.toFixed(0)}`;
}
