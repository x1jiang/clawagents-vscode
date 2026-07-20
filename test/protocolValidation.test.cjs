const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { buildSync } = require("esbuild");

const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawagents-protocol-"));
const outputFile = path.join(outputDir, "protocol.cjs");
buildSync({
  entryPoints: [path.join(__dirname, "..", "src", "protocol.ts")],
  outfile: outputFile,
  bundle: true,
  platform: "node",
  format: "cjs",
  logLevel: "silent",
});
const { parseWebviewToHost } = require(outputFile);

test.after(() => fs.rmSync(outputDir, { recursive: true, force: true }));

test("accepts a legitimate send request", () => {
  const message = { type: "send", text: "hello", mode: "auto", includeContext: false };
  assert.deepEqual(parseWebviewToHost(message), message);
});

test("settings saves require a positive integer revision", () => {
  const message = { type: "save_settings", revision: 7, settings: { provider: "openai" } };
  assert.deepEqual(parseWebviewToHost(message), message);
  assert.equal(parseWebviewToHost({ type: "save_settings", settings: {} }), undefined);
  assert.equal(
    parseWebviewToHost({ type: "save_settings", revision: 0, settings: {} }),
    undefined,
  );
});

test("rejects unknown, malformed, and traversal-bearing authority requests", () => {
  assert.equal(parseWebviewToHost({ type: "unknown" }), undefined);
  assert.equal(parseWebviewToHost({ type: "permission", requestId: "x", decision: "yes" }), undefined);
  assert.equal(parseWebviewToHost({ type: "select_chat", chatId: "../../outside" }), undefined);
  assert.equal(parseWebviewToHost({ type: "restore_checkpoint", sha: "abc", mode: "invalid" }), undefined);
});
