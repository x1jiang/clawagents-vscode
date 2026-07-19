/**
 * Event-sequence semantics: live usage → done must preserve last_input_tokens
 * and never treat cumulative prompt_tokens as the context meter.
 */
"use strict";

const assert = require("assert");

function mergeUsage(prev, msg) {
  return {
    promptTokens: msg.promptTokens,
    completionTokens: msg.completionTokens,
    totalTokens: msg.totalTokens,
    cachedInputTokens: msg.cachedInputTokens,
    lastInputTokens: msg.lastInputTokens ?? prev?.lastInputTokens,
    runCostUsd: msg.runCostUsd ?? prev?.runCostUsd,
    requestCount: msg.requestCount ?? prev?.requestCount,
  };
}

function applyDone(prev, usageObj) {
  const lastIn =
    typeof usageObj.last_input_tokens === "number" && usageObj.last_input_tokens > 0
      ? usageObj.last_input_tokens
      : prev?.lastInputTokens;
  return {
    promptTokens: usageObj.prompt_tokens,
    completionTokens: usageObj.completion_tokens,
    totalTokens: usageObj.total_tokens,
    cachedInputTokens: usageObj.cached_input_tokens,
    lastInputTokens: lastIn,
    runCostUsd: usageObj.run_cost_usd,
    requestCount: usageObj.request_count,
  };
}

// Simulate 2 rounds: 20K then 18K; cumulative 38K. Meter must stay on 18K.
let state = {};
state = mergeUsage(state, {
  promptTokens: 20_000,
  completionTokens: 100,
  totalTokens: 20_100,
  lastInputTokens: 20_000,
  runCostUsd: 0.02,
  requestCount: 1,
});
state = mergeUsage(state, {
  promptTokens: 38_000,
  completionTokens: 200,
  totalTokens: 38_200,
  lastInputTokens: 18_000,
  runCostUsd: 0.038,
  requestCount: 2,
});
assert.strictEqual(state.lastInputTokens, 18_000);
assert.strictEqual(state.promptTokens, 38_000);

// Done without last_input would be a bug — with field, meter stays 18K
state = applyDone(state, {
  prompt_tokens: 38_000,
  completion_tokens: 200,
  total_tokens: 38_200,
  last_input_tokens: 18_000,
  run_cost_usd: 0.038,
  request_count: 2,
});
assert.strictEqual(state.lastInputTokens, 18_000);

// Done missing last_input preserves prior live value (not cumulative)
state = applyDone(
  { lastInputTokens: 18_000, promptTokens: 38_000 },
  {
    prompt_tokens: 38_000,
    completion_tokens: 200,
    total_tokens: 38_200,
  },
);
assert.strictEqual(state.lastInputTokens, 18_000);
assert.notStrictEqual(state.lastInputTokens, state.promptTokens);

console.log("usageMeterSemantics.test.cjs: ok");
