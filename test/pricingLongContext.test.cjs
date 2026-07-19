/**
 * Mirror webview/src/pricing.ts long-context + cache math without a TS runner.
 * Keep in sync with python/pricing.py estimate_usd.
 */
"use strict";

const assert = require("assert");

const LONG_CONTEXT_THRESHOLD = 272_000;

function normalizeModelId(modelId) {
  let key = String(modelId || "")
    .trim()
    .toLowerCase();
  if (key.startsWith("bedrock/")) key = key.slice("bedrock/".length);
  for (const p of [
    "global.",
    "us.",
    "eu.",
    "apac.",
    "ap.",
    "af.",
    "me.",
    "ca.",
    "sa.",
  ]) {
    if (key.startsWith(p)) {
      key = key.slice(p.length);
      break;
    }
  }
  for (const p of [
    "anthropic.",
    "openai.",
    "amazon.",
    "meta.",
    "mistral.",
    "cohere.",
    "ai21.",
  ]) {
    if (key.startsWith(p)) {
      key = key.slice(p.length);
      break;
    }
  }
  if (key.includes(":")) key = key.split(":", 1)[0];
  return key;
}

function isGpt56Family(modelId) {
  const key = normalizeModelId(modelId);
  return key.startsWith("gpt-5.6") || key.includes("gpt-5.6");
}

function estimateCostUsd(
  modelId,
  promptTokens,
  completionTokens,
  rates,
  cachedInputTokens = 0,
  cacheCreationTokens = 0,
) {
  const prompt = Math.max(0, promptTokens || 0);
  const completion = Math.max(0, completionTokens || 0);
  const cached = Math.min(Math.max(0, cachedInputTokens || 0), prompt);
  const uncached = prompt - cached;
  const creation = Math.max(0, cacheCreationTokens || 0);
  let inp = rates.input;
  let out = rates.output;
  let cachedRate = rates.cachedInput;
  let writeRate = rates.cacheWrite;
  if (prompt > LONG_CONTEXT_THRESHOLD && isGpt56Family(modelId)) {
    inp *= 2;
    cachedRate *= 2;
    writeRate *= 2;
    out *= 1.5;
  }
  const writePremium = Math.max(0, writeRate - inp);
  return (
    (uncached / 1_000_000) * inp +
    (cached / 1_000_000) * cachedRate +
    (creation / 1_000_000) * writePremium +
    (completion / 1_000_000) * out
  );
}

const LUNA = { input: 1, output: 6, cachedInput: 0.1, cacheWrite: 1.25 };

assert.ok(Math.abs(estimateCostUsd("gpt-5.6-luna", 272_000, 0, LUNA) - 0.272) < 1e-9);
assert.ok(Math.abs(estimateCostUsd("gpt-5.6-luna", 300_000, 0, LUNA) - 0.6) < 1e-9);
assert.ok(
  Math.abs(estimateCostUsd("gpt-5.6-luna", 300_000, 100_000, LUNA) - 1.5) < 1e-9,
);
assert.ok(
  Math.abs(
    estimateCostUsd("gpt-5.6-luna", 300_000, 0, LUNA, 300_000) - 0.06,
  ) < 1e-9,
);
// Under cliff: no multiplier
assert.ok(Math.abs(estimateCostUsd("gpt-5.6-luna", 200_000, 0, LUNA) - 0.2) < 1e-9);

console.log("pricingLongContext.test.cjs: ok");
