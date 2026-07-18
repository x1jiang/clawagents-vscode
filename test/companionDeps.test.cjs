const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { buildSync } = require("esbuild");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawagents-companion-deps-"));
const outputFile = path.join(tempDir, "companionDeps.cjs");
const vscodeStubDir = path.join(tempDir, "node_modules", "vscode");
fs.mkdirSync(vscodeStubDir, { recursive: true });
fs.writeFileSync(
  path.join(vscodeStubDir, "index.js"),
  `module.exports = {
  ProgressLocation: { Notification: 1 },
  window: {
    withProgress: (_opts, task) => task({ report() {} }),
    showInformationMessage() {},
  },
  workspace: {
    getConfiguration: () => ({ get: (_k, d) => d }),
  },
};`,
);

buildSync({
  entryPoints: [path.join(__dirname, "..", "src", "companionDeps.ts")],
  outfile: outputFile,
  bundle: true,
  platform: "node",
  format: "cjs",
  logLevel: "silent",
  external: ["vscode"],
});

const deps = require(outputFile);

test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

test("companion floors match lockstep constants", () => {
  assert.deepEqual(deps.MIN_CONTEXT_MODE_VERSION, [1, 0, 169]);
  assert.deepEqual(deps.MIN_RTK_VERSION, [0, 43, 0]);
});

test("probeCompanions returns context-mode and rtk", () => {
  const probes = deps.probeCompanions();
  assert.equal(probes.length, 2);
  assert.equal(probes[0].name, "context-mode");
  assert.equal(probes[1].name, "rtk");
  for (const p of probes) {
    assert.equal(typeof p.ok, "boolean");
    assert.equal(typeof p.detail, "string");
  }
});
