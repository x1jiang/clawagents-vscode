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
const { QueryNavigatorMemory, queryEntriesFromVisibleItems } = require(outputFile);
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

test("a restored transcript page rebuilds a missing thread index", () => {
  const memory = new QueryNavigatorMemory();
  const visibleEntries = queryEntriesFromVisibleItems([
    { kind: "assistant", text: "Answer" },
    { kind: "user", text: "  First question  ", timestamp: "now", eventIndex: 4 },
    { kind: "user", text: "Second question", eventIndex: 9 },
  ]);

  assert.deepEqual(visibleEntries, [
    { eventIndex: 4, text: "First question", timestamp: "now" },
    { eventIndex: 9, text: "Second question", timestamp: undefined },
  ]);
  assert.deepEqual(memory.rememberVisibleEntries("chat-a", visibleEntries).entries, visibleEntries);
});

test("a partial restored page augments rather than erases a cached full index", () => {
  const memory = new QueryNavigatorMemory();
  memory.rememberEntries("chat-a", [
    { eventIndex: 1, text: "Older" },
    { eventIndex: 5, text: "Old preview" },
  ]);

  assert.deepEqual(
    memory.rememberVisibleEntries("chat-a", [{ eventIndex: 5, text: "Updated preview" }]).entries,
    [
      { eventIndex: 1, text: "Older" },
      { eventIndex: 5, text: "Updated preview" },
    ],
  );
});

test("a transient empty host response cannot erase a restored transcript index", () => {
  const memory = new QueryNavigatorMemory();
  memory.rememberVisibleEntries("chat-a", [{ eventIndex: 4, text: "Persist me" }]);
  memory.rememberActive("chat-a", 4);

  assert.deepEqual(memory.rememberEntries("chat-a", []), {
    entries: [{ eventIndex: 4, text: "Persist me" }],
    activeEventIndex: 4,
  });
});

test("thread restore uses cached navigation before the host refresh arrives", () => {
  assert.match(app, /restoreCachedQueryNavigator\(restoredChatId, restoredItems\)/);
  assert.match(
    app,
    /queryNavigatorMemoryRef\.current\.rememberEntries\(\s*msg\.chatId,\s*msg\.entries/s,
  );
  assert.match(app, /restoreCachedQueryNavigator\(tab\.id\)/);
  assert.match(app, /case "done":[\s\S]*?post\(\{ type: "load_query_index" \}\)/);
});
