const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { buildSync } = require("esbuild");

const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawagents-workspace-selection-"));
const outputFile = path.join(outputDir, "workspaceSelection.cjs");
buildSync({
  entryPoints: [path.join(__dirname, "..", "src", "workspaceSelection.ts")],
  outfile: outputFile,
  bundle: true,
  platform: "node",
  format: "cjs",
  logLevel: "silent",
});
const selection = require(outputFile);

test.after(() => fs.rmSync(outputDir, { recursive: true, force: true }));

const roots = ["/work/api", "/work/web"];

test("preferred multi-root selection wins when still present", () => {
  assert.equal(selection.chooseWorkspaceRoot(roots, "/work/web", "/work/api"), "/work/web");
});

test("active editor root is used when no preference exists", () => {
  assert.equal(selection.chooseWorkspaceRoot(roots, undefined, "/work/web"), "/work/web");
});

test("removed or outside roots fail back to the first workspace", () => {
  assert.equal(selection.chooseWorkspaceRoot(roots, "/gone", "/outside"), "/work/api");
  assert.equal(selection.chooseWorkspaceRoot([], "/work/api", "/work/api"), undefined);
});
