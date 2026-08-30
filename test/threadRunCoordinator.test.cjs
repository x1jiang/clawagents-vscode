const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

const source = fs.readFileSync(
  path.join(__dirname, "..", "src", "threadRunCoordinator.ts"),
  "utf8",
);
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const moduleBox = { exports: {} };
vm.runInNewContext(compiled, {
  module: moduleBox,
  exports: moduleBox.exports,
  AbortController,
  Map,
  Set,
});
const { ThreadRunCoordinator } = moduleBox.exports;

test("different conversations can own active runs concurrently", () => {
  const runs = new ThreadRunCoordinator();
  const first = runs.start("chat-a");
  const second = runs.start("chat-b");

  assert.ok(first);
  assert.ok(second);
  assert.equal(runs.hasActiveRuns, true);
  assert.deepEqual([...runs.activeChatIds()].sort(), ["chat-a", "chat-b"]);
});

test("one conversation remains serial and drains its own queue", () => {
  const runs = new ThreadRunCoordinator();
  const active = runs.start("chat-a");
  assert.ok(active);
  assert.equal(runs.start("chat-a"), undefined);

  assert.equal(runs.enqueue("chat-a", "second"), 1);
  assert.equal(runs.enqueue("chat-b", "other"), 1);
  assert.equal(runs.dequeue("chat-a"), "second");
  assert.equal(runs.dequeue("chat-a"), undefined);
  assert.equal(runs.dequeue("chat-b"), "other");
});

test("late completion cannot release a replacement owner", () => {
  const runs = new ThreadRunCoordinator();
  const oldRun = runs.start("chat-a");
  assert.ok(oldRun);
  assert.equal(runs.abort("chat-a"), true);
  const replacement = runs.start("chat-a");
  assert.ok(replacement);

  assert.equal(runs.finish(oldRun), false);
  assert.equal(runs.isActive("chat-a"), true);
  assert.equal(runs.finish(replacement), true);
});

test("cancellation gates restart and preserves other conversations", () => {
  const runs = new ThreadRunCoordinator();
  const first = runs.start("chat-a");
  const second = runs.start("chat-b");
  assert.ok(first && second);

  runs.beginCancel("chat-a");
  assert.equal(runs.abort("chat-a"), true);
  assert.equal(runs.start("chat-a"), undefined);
  assert.equal(runs.isActive("chat-b"), true);

  runs.endCancel("chat-a");
  assert.ok(runs.start("chat-a"));
});
