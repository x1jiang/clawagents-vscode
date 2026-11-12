"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { buildSync } = require("esbuild");

const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawagents-harness-proto-"));
const protocolFile = path.join(outputDir, "protocol.cjs");
const gatewayFile = path.join(outputDir, "gatewayClient.cjs");

buildSync({
  entryPoints: [path.join(__dirname, "..", "src", "protocol.ts")],
  outfile: protocolFile,
  bundle: true,
  platform: "node",
  format: "cjs",
  logLevel: "silent",
});

buildSync({
  entryPoints: [path.join(__dirname, "..", "src", "gatewayClient.ts")],
  outfile: gatewayFile,
  bundle: true,
  platform: "node",
  format: "cjs",
  logLevel: "silent",
  external: ["vscode"],
});

const { parseWebviewToHost } = require(protocolFile);

const originalLoad = Module._load;
Module._load = function loadWithVscodeStub(request, parent, isMain) {
  if (request === "vscode") {
    return { workspace: { getConfiguration: () => ({ get: () => false }) } };
  }
  return originalLoad.call(this, request, parent, isMain);
};
let mapAgentEvent;
try {
  ({ mapAgentEvent } = require(gatewayFile));
} finally {
  Module._load = originalLoad;
}

test.after(() => fs.rmSync(outputDir, { recursive: true, force: true }));

test("parseWebviewToHost accepts no-payload harness optimizer actions", () => {
  for (const type of [
    "load_harness_optimize",
    "cancel_harness_optimize",
    "apply_harness_optimize",
  ]) {
    assert.deepEqual(parseWebviewToHost({ type }), { type });
  }
});

test("parseWebviewToHost validates start_harness_optimize bounds", () => {
  const valid = {
    type: "start_harness_optimize",
    task: "Run pytest and improve skills",
    k: 2,
    mode: "parallel",
    adaptiveProbe: true,
    maxUsd: 2.5,
  };
  assert.deepEqual(parseWebviewToHost(valid), valid);

  const withoutMax = {
    type: "start_harness_optimize",
    task: "Optimize workspace instructions",
    k: 1,
    mode: "sequential",
    adaptiveProbe: false,
  };
  assert.deepEqual(parseWebviewToHost(withoutMax), withoutMax);

  for (const badPatch of [
    { task: "" },
    { task: "   " },
    { k: 0 },
    { k: 4 },
    { k: 1.5 },
    { mode: "diagonal" },
    { adaptiveProbe: "yes" },
    { maxUsd: 0 },
    { maxUsd: -5 },
    { maxUsd: 1001 },
    { maxUsd: Number.NaN },
  ]) {
    assert.equal(parseWebviewToHost({ ...valid, ...badPatch }), undefined);
  }
});

test("mapAgentEvent maps DeepInfer-inspired inference telemetry fields on usage", () => {
  const mapped = mapAgentEvent("usage", {
    prompt_tokens: 2000,
    completion_tokens: 150,
    total_tokens: 2150,
    cached_input_tokens: 1500,
    time_to_first_token_ms: 185.4,
    avg_ttft_ms: 210.2,
    decode_tokens_per_sec: 92.5,
    steady_decode_tps: 96.8,
    max_step_ms: 1840.0,
    cache_hit_ratio: 0.75,
  });
  assert.equal(mapped.type, "usage");
  assert.equal(mapped.ttftMs, 185.4);
  assert.equal(mapped.avgTtftMs, 210.2);
  assert.equal(mapped.decodeTps, 92.5);
  assert.equal(mapped.steadyDecodeTps, 96.8);
  assert.equal(mapped.maxStepMs, 1840.0);
  assert.equal(mapped.cacheHitRatio, 0.75);
});
