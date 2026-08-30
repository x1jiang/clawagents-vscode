const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

const source = fs.readFileSync(
  path.join(__dirname, "..", "webview", "src", "threadUnread.ts"),
  "utf8",
);
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const moduleBox = { exports: {} };
vm.runInNewContext(compiled, {
  module: moduleBox,
  exports: moduleBox.exports,
  Map,
  Set,
});
const {
  THREAD_UNREAD_STATE_KEY,
  acknowledgeThreadUnread,
  markThreadUnread,
  readPersistedUnreadThreads,
  retainAvailableUnreadThreads,
  serializeUnreadThreads,
  threadActivity,
} = moduleBox.exports;

test("persisted unread ids decode defensively and round-trip", () => {
  assert.deepEqual([...readPersistedUnreadThreads(undefined)], []);
  assert.deepEqual(
    [...readPersistedUnreadThreads({ [THREAD_UNREAD_STATE_KEY]: [" a ", 7, "", "a", "b"] })],
    ["a", "b"],
  );
  assert.deepEqual([...serializeUnreadThreads(new Set(["a", "b"]))], ["a", "b"]);
});

test("mark and acknowledge preserve identity when no state changes", () => {
  const empty = new Set();
  const unread = markThreadUnread(empty, "chat-a");
  assert.notEqual(unread, empty);
  assert.equal(markThreadUnread(unread, "chat-a"), unread);
  assert.equal(acknowledgeThreadUnread(unread, "missing"), unread);
  assert.deepEqual([...acknowledgeThreadUnread(unread, "chat-a")], []);
});

test("deleted chats are removed and activity priority stays explicit", () => {
  const unread = new Set(["available", "deleted"]);
  assert.deepEqual(
    [...retainAvailableUnreadThreads(unread, new Set(["available"]))],
    ["available"],
  );
  assert.equal(threadActivity(true, true, true), "attention");
  assert.equal(threadActivity(false, true, true), "unread");
  assert.equal(threadActivity(false, false, true), "running");
  assert.equal(threadActivity(false, false, false), undefined);
});
