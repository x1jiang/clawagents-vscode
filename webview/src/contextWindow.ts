/** Per-model context-window sizes for the context meter. */

const WINDOWS: Array<[string, number]> = [
  ["gpt-5.6", 1_050_000],
  ["gpt-5.5", 400_000],
  ["gpt-5.4", 400_000],
  ["gpt-5.2", 400_000],
  ["gpt-5", 400_000],
  ["gpt-4o-mini", 128_000],
  ["gpt-4o", 128_000],
  ["gpt-4.1", 1_000_000],
  ["o4-mini", 200_000],
  ["o3-mini", 200_000],
  ["o3", 200_000],
  ["claude-opus-4", 200_000],
  ["claude-sonnet-4", 200_000],
  ["claude-haiku-4", 200_000],
  ["gemini-3.6", 1_000_000],
  ["gemini-3.5", 1_000_000],
  ["gemini-3", 1_000_000],
  ["gemini-2.5", 1_000_000],
  ["gemini-2.0", 1_000_000],
];

export function contextWindowFor(model: string | undefined | null): number | null {
  if (!model) return null;
  let best: number | null = null;
  let bestLen = 0;
  for (const [prefix, size] of WINDOWS) {
    if (model.startsWith(prefix) && prefix.length > bestLen) {
      best = size;
      bestLen = prefix.length;
    }
  }
  return best;
}

export function contextUsage(
  model: string | undefined | null,
  inputTokensThisTurn: number,
): { ratio: number; window: number } | null {
  if (inputTokensThisTurn <= 0) return null;
  const window = contextWindowFor(model);
  if (window === null) return null;
  return { ratio: Math.min(1, inputTokensThisTurn / window), window };
}
