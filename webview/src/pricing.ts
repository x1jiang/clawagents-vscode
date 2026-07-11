/** USD per 1M tokens — mirrors python/pricing.py for offline header estimates. */

const PRICES: Record<string, { input: number; output: number }> = {
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
  "claude-sonnet-4-5": { input: 3, output: 15 },
  "claude-opus-4-6": { input: 15, output: 75 },
  "claude-haiku-4-5-20251001": { input: 1, output: 5 },
  "gemini-3.5-flash": { input: 1.5, output: 9 },
  "gemini-3.1-pro-preview": { input: 2, output: 12 },
  "gemini-3.1-flash-lite": { input: 0.25, output: 1.5 },
  "gemini-3-flash-preview": { input: 0.5, output: 3 },
  "gemini-2.5-pro": { input: 1.25, output: 10 },
  "gemini-2.5-flash": { input: 0.3, output: 2.5 },
};

export type ModelPrice = { input_per_mtok?: number; output_per_mtok?: number };

function lookup(modelId: string, fromModel?: ModelPrice): { input: number; output: number } | null {
  if (
    fromModel &&
    typeof fromModel.input_per_mtok === "number" &&
    typeof fromModel.output_per_mtok === "number"
  ) {
    return { input: fromModel.input_per_mtok, output: fromModel.output_per_mtok };
  }
  const key = modelId.trim().toLowerCase();
  if (!key || key === "default") {
    return null;
  }
  if (PRICES[key]) {
    return PRICES[key];
  }
  // Longest prefix wins (gpt-5.5-pro-… must not match gpt-5.5).
  let best: { input: number; output: number } | null = null;
  let bestLen = -1;
  for (const [prefix, rates] of Object.entries(PRICES)) {
    if (key.startsWith(`${prefix}-`) || key.startsWith(`${prefix}_`)) {
      if (prefix.length > bestLen) {
        best = rates;
        bestLen = prefix.length;
      }
    }
  }
  return best;
}

export function estimateCostUsd(
  modelId: string,
  promptTokens: number,
  completionTokens: number,
  fromModel?: ModelPrice,
): number | null {
  const rates = lookup(modelId, fromModel);
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
