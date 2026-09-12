"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { buildSync } = require("esbuild");

const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawagents-gateway-events-"));
const outputFile = path.join(outputDir, "gatewayClient.cjs");
buildSync({
  entryPoints: [path.join(__dirname, "..", "src", "gatewayClient.ts")],
  outfile: outputFile,
  bundle: true,
  platform: "node",
  format: "cjs",
  logLevel: "silent",
  external: ["vscode"],
});
const originalLoad = Module._load;
Module._load = function loadWithVscodeStub(request, parent, isMain) {
  if (request === "vscode") {
    return { workspace: { getConfiguration: () => ({ get: () => false }) } };
  }
  return originalLoad.call(this, request, parent, isMain);
};
let mapAgentEvent;
try {
  ({ mapAgentEvent } = require(outputFile));
} finally {
  Module._load = originalLoad;
}

test.after(() => fs.rmSync(outputDir, { recursive: true, force: true }));

test("internal tool artifact storage notices stay out of the chat timeline", () => {
  assert.equal(
    mapAgentEvent("context", {
      message: "tool output crushed/stored id=call_GyeeYFQGNeuojVFGBfsDXP4y",
    }),
    null,
  );
});

test("other context status messages remain visible", () => {
  assert.deepEqual(
    mapAgentEvent("context", { message: "soft-trim: trimmed 2 old tool results" }),
    { type: "status", message: "soft-trim: trimmed 2 old tool results" },
  );
  assert.deepEqual(
    mapAgentEvent("context", { message: "tool output crushed/stored for diagnostics" }),
    { type: "status", message: "tool output crushed/stored for diagnostics" },
  );
});

test("tool completion cards are not affected by artifact notice filtering", () => {
  assert.deepEqual(
    mapAgentEvent("tool_result", {
      call_id: "call_GyeeYFQGNeuojVFGBfsDXP4y",
      tool_name: "ctx_batch_execute",
      success: true,
      output: "6 operations completed",
    }),
    {
      type: "tool_completed",
      id: "call_GyeeYFQGNeuojVFGBfsDXP4y",
      name: "ctx_batch_execute",
      success: true,
      output: "6 operations completed",
      filePath: undefined,
    },
  );
});

test("usage keeps efficiency snapshots and both cache directions", () => {
  const mapped = mapAgentEvent("usage", {
    prompt_tokens: 1000, cached_input_tokens: 700, cache_creation_tokens: 100,
    efficiency: {round_trips_avoided: 2, compactions: {micro: 1}},
  });
  assert.equal(mapped.promptTokens, 1000);
  assert.equal(mapped.cachedInputTokens, 700);
  assert.equal(mapped.cacheCreationTokens, 100);
  assert.equal(mapped.efficiency.round_trips_avoided, 2);
  assert.deepEqual(mapped.efficiency.compactions, {micro: 1});
  assert.equal(mapAgentEvent("usage", {prompt_tokens: 100}).efficiency, undefined);
});
