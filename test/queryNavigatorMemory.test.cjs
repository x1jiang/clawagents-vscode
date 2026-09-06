"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { buildSync } = require("esbuild");

const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawagents-query-memory-"));
const outputFile = path.join(outputDir, "queryNavigatorMemory.cjs");
buildSync({
  entryPoints: [path.join(__dirname, "..", "webview", "src", "queryNavigatorMemory.ts")],
  outfile: outputFile,
  bundle: true,
  platform: "node",
  format: "cjs",
  logLevel: "silent",
});
const { QueryNavigatorMemory } = require(outputFile);
const app = fs.readFileSync(path.join(__dirname, "..", "webview", "src", "App.tsx"), "utf8");

test.after(() => fs.rmSync(outputDir, { recursive: true, force: true }));

test("each thread restores its own navigator entries and active message", () => {
  const memory = new QueryNavigatorMemory();
  const first = [
    { eventIndex: 1, text: "First" },
    { eventIndex: 5, text: "Second" },
  ];
  const second = [{ eventIndex: 2, text: "Other thread" }];

  memory.rememberEntries("chat-a", first);
  memory.rememberActive("chat-a", 5);
  memory.rememberEntries("chat-b", second);

  assert.deepEqual(memory.read("chat-a"), { entries: first, activeEventIndex: 5 });
  assert.deepEqual(memory.read("chat-b"), { entries: second, activeEventIndex: undefined });
});

test("a host refresh keeps only an active message that still exists", () => {
  const memory = new QueryNavigatorMemory();
  memory.rememberEntries("chat-a", [{ eventIndex: 1, text: "First" }]);
  memory.rememberActive("chat-a", 1);

  assert.equal(
    memory.rememberEntries("chat-a", [{ eventIndex: 1, text: "Updated" }]).activeEventIndex,
    1,
  );
  assert.equal(
    memory.rememberEntries("chat-a", [{ eventIndex: 3, text: "Replacement" }]).activeEventIndex,
    undefined,
  );
});

test("thread restore uses cached navigation before the host refresh arrives", () => {
  assert.match(app, /restoreCachedQueryNavigator\(restoredChatId\)/);
  assert.match(
    app,
    /queryNavigatorMemoryRef\.current\.rememberEntries\(\s*msg\.chatId,\s*msg\.entries/s,
  );
  assert.match(app, /restoreCachedQueryNavigator\(tab\.id\)/);
});
