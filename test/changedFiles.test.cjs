const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { buildSync } = require("esbuild");

const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawagents-changed-files-"));
const outputFile = path.join(outputDir, "changedFiles.cjs");
buildSync({
  entryPoints: [path.join(__dirname, "..", "webview", "src", "changedFiles.ts")],
  outfile: outputFile,
  bundle: true,
  platform: "node",
  format: "cjs",
  logLevel: "silent",
});
const {
  collectPendingTurnChangedFiles,
  collectTurnChangedFiles,
  isTurnTerminal,
} = require(outputFile);

test.after(() => fs.rmSync(outputDir, { recursive: true, force: true }));

test("summarizes one turn, de-duplicates paths, and keeps the newest snapshot", () => {
  const items = [
    { kind: "user", text: "first" },
    { kind: "file", path: "old.ts" },
    { kind: "status", text: "Done · done" },
    { kind: "user", text: "second" },
    { kind: "file", path: "src/app.ts", snapshotId: "first" },
    { kind: "tool" },
    { kind: "file", path: "src/test.ts" },
    { kind: "file", path: "src/app.ts", snapshotId: "latest" },
    { kind: "status", text: "Done · done" },
  ];
  assert.deepEqual(collectTurnChangedFiles(items, 8), [
    { path: "src/app.ts", snapshotId: "latest", snapshotRel: undefined },
    { path: "src/test.ts", snapshotId: undefined, snapshotRel: undefined },
  ]);
});

test("summarizes a side-chat turn that ends with plain Done", () => {
  const items = [
    { kind: "user", text: "side" },
    { kind: "file", path: "src/app.ts", snapshotId: "one" },
    { kind: "status", text: "Done" },
  ];
  assert.equal(isTurnTerminal(items[2].kind, items[2].text), true);
  assert.deepEqual(collectTurnChangedFiles(items, 2), [
    { path: "src/app.ts", snapshotId: "one", snapshotRel: undefined },
  ]);
});

test("recognizes final status and error transcript entries", () => {
  assert.equal(isTurnTerminal("status", "Done"), true);
  assert.equal(isTurnTerminal("status", "Done · done"), true);
  assert.equal(isTurnTerminal("status", "Done · 3 iters"), true);
  assert.equal(isTurnTerminal("status", "Cancelled"), true);
  assert.equal(isTurnTerminal("error"), true);
  assert.equal(isTurnTerminal("status", "Running tool"), false);
});

test("collects one de-duplicated live summary until the turn finishes", () => {
  const running = [
    { kind: "user", text: "edit it" },
    { kind: "file", path: "src/app.ts", snapshotId: "first" },
    { kind: "tool" },
    { kind: "file", path: "src/app.ts", snapshotId: "latest" },
    { kind: "file", path: "src/test.ts" },
  ];
  assert.deepEqual(collectPendingTurnChangedFiles(running), [
    { path: "src/app.ts", snapshotId: "latest", snapshotRel: undefined },
    { path: "src/test.ts", snapshotId: undefined, snapshotRel: undefined },
  ]);
  assert.deepEqual(
    collectPendingTurnChangedFiles([...running, { kind: "status", text: "Done" }]),
    [],
  );
});

test("a persisted turn summary appended after Done is included in the card", () => {
  const items = [
    { kind: "user", text: "edit it" },
    { kind: "status", text: "Done" },
    {
      kind: "file",
      path: "src/app.ts",
      snapshotId: "snapshot-1",
      snapshotRel: "src/app.ts",
    },
    { kind: "user", text: "next turn" },
  ];
  assert.deepEqual(collectTurnChangedFiles(items, 1), [{
    path: "src/app.ts",
    snapshotId: "snapshot-1",
    snapshotRel: "src/app.ts",
  }]);
});
