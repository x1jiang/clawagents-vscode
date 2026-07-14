const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { buildSync } = require("esbuild");

const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawagents-start-generation-"));
const outputFile = path.join(outputDir, "startGeneration.cjs");
buildSync({
  entryPoints: [path.join(__dirname, "..", "src", "startGeneration.ts")],
  outfile: outputFile,
  bundle: true,
  platform: "node",
  format: "cjs",
  logLevel: "silent",
});
const { StartGeneration } = require(outputFile);

test.after(() => fs.rmSync(outputDir, { recursive: true, force: true }));

test("stop invalidates prior startup ownership", () => {
  const gate = new StartGeneration();
  const stale = gate.begin();
  gate.invalidate();
  assert.throws(() => gate.assertCurrent(stale), /superseded/);
  const current = gate.begin();
  assert.doesNotThrow(() => gate.assertCurrent(current));
});
