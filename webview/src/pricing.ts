/** USD per 1M tokens — mirrors python/pricing.py for offline header estimates.
 *
 * Bedrock / Mantle on-demand from https://aws.amazon.com/bedrock/pricing/
 * (2026-07-18). Direct OpenAI / Anthropic API rates differ slightly.
 */

type Rates = { input: number; output: number };

const PRICES: Record<string, Rates> = {
  "gpt-5.6": { input: 5, output: 30 },
  "gpt-5.6-sol": { input: 5, output: 30 },
  "gpt-5.6-terra": { input: 2.5, output: 15 },
  "gpt-5.6-luna": { input: 1, output: 6 },
  "gpt-5.5": { input: 5, output: 30 },
  "gpt-5.5-pro": { input: 30, output: 180 },
  "gpt-5.4": { input: 2.5, output: 15 },
  "gpt-5.4-mini": { input: 0.75, output: 4.5 },
  "gpt-5.4-nano": { input: 0.2, output: 1.25 },
  "gpt-5.4-pro": { input: 30, output: 180 },
  "gpt-4o": { input: 2.5, output: 10 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "claude-opus-4": { input: 5, output: 25 },
  "claude-opus-4-5": { input: 5, output: 25 },
  "claude-opus-4-6": { input: 5, output: 25 },
  "claude-opus-4-7": { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-sonnet-4": { input: 3, output: 15 },
  "claude-sonnet-4-5": { input: 3, output: 15 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-haiku-4-5": { input: 1, output: 5 },
  "claude-haiku-4-5-20251001": { input: 1, output: 5 },
  "gemini-3.5-flash": { input: 1.5, output: 9 },
  "gemini-3.1-pro-preview": { input: 2, output: 12 },
  "gemini-3.1-flash-lite": { input: 0.25, output: 1.5 },
  "gemini-3-flash-preview": { input: 0.5, output: 3 },
  "gemini-2.5-pro": { input: 1.25, output: 10 },
  "gemini-2.5-flash": { input: 0.3, output: 2.5 },
};

/** Bedrock / Mantle on-demand (US East). */
const BEDROCK_PRICES: Record<string, Rates> = {
  "claude-opus-4": { input: 6, output: 30 },
  "claude-opus-4-5": { input: 6, output: 30 },
  "claude-opus-4-6": { input: 6, output: 30 },
  "claude-opus-4-7": { input: 6, output: 30 },
  "claude-opus-4-8": { input: 6, output: 30 },
  "claude-sonnet-4": { input: 3, output: 15 },
  "claude-sonnet-4-5": { input: 3, output: 15 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-haiku-4-5": { input: 1, output: 5 },
  "gpt-5.6": { input: 5.5, output: 33 },
  "gpt-5.6-sol": { input: 5.5, output: 33 },
  "gpt-5.6-terra": { input: 2.75, output: 16.5 },
  "gpt-5.6-luna": { input: 1.1, output: 6.6 },
  "gpt-5.5": { input: 5.5, output: 33 },
  "gpt-5.4": { input: 2.75, output: 16.5 },
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

export type ModelPrice = { input_per_mtok?: number; output_per_mtok?: number };

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
    return { input: fromModel.input_per_mtok, output: fromModel.output_per_mtok };
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
): number | null {
  const rates = lookup(modelId, fromModel, provider);
  if (!rates) {
    return null;
  }
  return (promptTokens / 1_000_000) * rates.input + (completionTokens / 1_000_000) * rates.output;
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
