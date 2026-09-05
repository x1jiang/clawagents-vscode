/** Per-model context-window sizes for the context meter. */

import { normalizeModelId } from "./pricing";

/**
 * Longest-prefix table keyed on the *normalized* model id (see
 * `normalizeModelId`: lowercased, Bedrock geo/vendor prefixes and the `:0`
 * revision removed). Keep in sync with `MODEL_PROFILES` in
 * clawagents/graph/model_profiles.py — both sides must agree on the window
 * or the meter and the compaction budget drift apart.
 *
 * Sources: OpenAI / Google model cards; Anthropic context-windows page
 * (Opus 4.6+, Opus 5, Sonnet 4.6+, Fable 5 → 1M; Sonnet 4.5, Haiku 4.5,
 * Opus 4.5 and older → 200K); xAI pricing page; AWS Bedrock model cards for
 * the Mantle third-party ids.
 */
const WINDOWS: Array<[string, number]> = [
  // OpenAI
  ["gpt-5.6", 1_050_000],
  ["gpt-5.5", 400_000],
  ["gpt-5.4", 400_000],
  ["gpt-5.3", 400_000],
  ["gpt-5.2", 400_000],
  ["gpt-5.1", 400_000],
  ["gpt-5", 400_000],
  ["gpt-4o-mini", 128_000],
  ["gpt-4o", 128_000],
  ["gpt-4.1", 1_000_000],
  ["gpt-oss", 128_000],
  ["o4-mini", 200_000],
  ["o3-mini", 200_000],
  ["o3", 200_000],
  ["o1", 200_000],
  // Anthropic — 1M generation
  ["claude-fable-5", 1_000_000],
  ["claude-mythos-5", 1_000_000],
  ["claude-opus-5", 1_000_000],
  ["claude-opus-4-8", 1_000_000],
  ["claude-opus-4-7", 1_000_000],
  ["claude-opus-4-6", 1_000_000],
  ["claude-sonnet-5", 1_000_000],
  ["claude-sonnet-4-6", 1_000_000],
  // Anthropic — 200K
  ["claude-opus-4", 200_000],
  ["claude-sonnet-4", 200_000],
  ["claude-haiku-4", 200_000],
  ["claude-3", 200_000],
  // Google
  ["gemini-3.8", 1_000_000],
  ["gemini-3.7", 1_000_000],
  ["gemini-3.6", 1_000_000],
  ["gemini-3.5", 1_000_000],
  ["gemini-3", 1_000_000],
  ["gemini-2.5", 1_000_000],
  ["gemini-2.0", 1_000_000],
  // xAI
  ["grok-4.5", 500_000],
  ["grok-4.3", 1_000_000],
  ["grok-4.20", 1_000_000],
  ["grok-build", 256_000],
  ["grok-4", 256_000],
  ["grok", 131_072],
  // Bedrock Mantle third-party
  ["deepseek.v3.2", 164_000],
  ["deepseek.v3.1", 128_000],
  ["deepseek", 128_000],
  ["kimi-k2", 256_000],
  ["glm-5", 200_000],
  ["glm-4.7", 200_000],
  ["glm-4.6", 200_000],
  // Amazon Nova
  ["nova-pro", 300_000],
  ["nova-lite", 300_000],
  ["nova-micro", 128_000],
];

export function contextWindowFor(model: string | undefined | null): number | null {
  if (!model) return null;
  const key = normalizeModelId(model);
  if (!key) return null;
  let best: number | null = null;
  let bestLen = 0;
  for (const [prefix, size] of WINDOWS) {
    if (key.startsWith(prefix) && prefix.length > bestLen) {
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
