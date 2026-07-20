const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { buildSync } = require("esbuild");

const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawagents-settings-sync-"));
const outputFile = path.join(outputDir, "settingsSync.cjs");
buildSync({
  entryPoints: [path.join(__dirname, "..", "webview", "src", "settingsSync.ts")],
  outfile: outputFile,
  bundle: true,
  platform: "node",
  format: "cjs",
  logLevel: "silent",
});
const sync = require(outputFile);

test.after(() => fs.rmSync(outputDir, { recursive: true, force: true }));

test("older settings replies cannot replace a newer save", () => {
  assert.deepEqual(
    sync.decideSettingsReply({
      replyRevision: 4,
      latestRevision: 5,
      pendingRevision: 4,
      localMatchesPending: false,
    }),
    { kind: "ignore_stale" },
  );
});

test("latest reply applies when local settings still match the sent snapshot", () => {
  assert.deepEqual(
    sync.decideSettingsReply({
      replyRevision: 5,
      latestRevision: 5,
      pendingRevision: 5,
      localMatchesPending: true,
    }),
    { kind: "apply" },
  );
});

test("latest reply preserves edits made after the request was sent", () => {
  assert.deepEqual(
    sync.decideSettingsReply({
      replyRevision: 5,
      latestRevision: 5,
      pendingRevision: 5,
      localMatchesPending: false,
    }),
    { kind: "keep_local" },
  );
});
