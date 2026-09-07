"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { buildSync } = require("esbuild");

const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawagents-chat-items-"));
const outputFile = path.join(outputDir, "chatItems.cjs");
buildSync({
  entryPoints: [path.join(__dirname, "..", "src", "chatItems.ts")],
  outfile: outputFile,
  bundle: true,
  platform: "node",
  format: "cjs",
  logLevel: "silent",
});
const { eventsToItems } = require(outputFile);

test.after(() => fs.rmSync(outputDir, { recursive: true, force: true }));

test("persisted tool events rebuild a completed tool card with perceived timing", () => {
  const items = eventsToItems([
    { kind: "user", text: "Read it", ts: 100 },
    {
      kind: "tool_started",
      id: "call-1",
      name: "read_file",
      args: { path: "stories/story.txt" },
      perceived_started_at: 100,
      ts: 102,
    },
    {
      kind: "tool_completed",
      id: "call-1",
      name: "read_file",
      success: true,
      output: "Story",
      ts: 104.5,
    },
    { kind: "assistant", text: "Done", ts: 105 },
    {
      kind: "done",
      status: "completed",
      iterations: 2,
      usage: { run_cost_usd: 0.004 },
      ts: 106,
    },
  ], 12);

  assert.deepEqual(items[1], {
    kind: "tool",
    id: "call-1",
    name: "read_file",
    args: { path: "stories/story.txt" },
    filePath: "stories/story.txt",
    status: "done",
    startedAt: 100_000,
    success: true,
    output: "Story",
    completedAt: 104_500,
    durationMs: 4_500,
  });
  assert.equal(items[0].eventIndex, 12);
  assert.deepEqual(items.at(-1), {
    kind: "status",
    text: "Done · 2 iters · run ~<$0.01",
  });
});

test("a paged completion remains visible when its start is outside the restored page", () => {
  assert.deepEqual(eventsToItems([
    {
      kind: "tool_completed",
      id: "call-old",
      name: "exec_command",
      success: false,
      output: "failed",
      ts: 200,
    },
  ]), [{
    kind: "tool",
    id: "call-old",
    name: "exec_command",
    status: "done",
    success: false,
    output: "failed",
    filePath: undefined,
    completedAt: 200_000,
}]);
});

test("persisted file changes restore their diff and restore metadata", () => {
  assert.deepEqual(eventsToItems([
    {
      kind: "files_changed",
      files: [{
        path: "src/app.ts",
        snapshot_id: "snapshot-1",
        snapshot_rel: "src/app.ts",
      }],
    },
  ]), [{
    kind: "file",
    path: "src/app.ts",
    snapshotId: "snapshot-1",
    snapshotRel: "src/app.ts",
  }]);
});
