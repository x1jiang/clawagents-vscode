const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { buildSync } = require("esbuild");

const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawagents-protocol-"));
const outputFile = path.join(outputDir, "protocol.cjs");
buildSync({
  entryPoints: [path.join(__dirname, "..", "src", "protocol.ts")],
  outfile: outputFile,
  bundle: true,
  platform: "node",
  format: "cjs",
  logLevel: "silent",
});
const { parseWebviewToHost } = require(outputFile);

test.after(() => fs.rmSync(outputDir, { recursive: true, force: true }));

test("accepts a legitimate send request", () => {
  const message = { type: "send", text: "hello", mode: "auto", includeContext: false };
  assert.deepEqual(parseWebviewToHost(message), message);
});

test("accepts bounded thread model routes and rejects malformed providers", () => {
  const modelRoute = {
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    reasoning_effort: "high",
  };
  const patch = {
    type: "set_chat_model_route",
    chatId: "chat-123",
    modelRoute,
  };
  assert.deepEqual(parseWebviewToHost(patch), patch);
  assert.equal(
    parseWebviewToHost({ ...patch, modelRoute: { provider: "../../evil", model: "x" } }),
    undefined,
  );
  const send = {
    type: "send",
    text: "hello",
    mode: "auto",
    includeContext: false,
    chatId: "chat-123",
    modelRoute,
  };
  assert.deepEqual(parseWebviewToHost(send), send);
});

test("accepts deselect_chat with no payload", () => {
  assert.deepEqual(parseWebviewToHost({ type: "deselect_chat" }), { type: "deselect_chat" });
});

test("query navigation accepts only a non-negative event position", () => {
  assert.deepEqual(parseWebviewToHost({ type: "load_query_index" }), {
    type: "load_query_index",
  });
  assert.deepEqual(parseWebviewToHost({ type: "jump_to_query", eventIndex: 12 }), {
    type: "jump_to_query",
    eventIndex: 12,
  });
  assert.equal(parseWebviewToHost({ type: "jump_to_query", eventIndex: -1 }), undefined);
  assert.equal(parseWebviewToHost({ type: "jump_to_query", eventIndex: 1.5 }), undefined);
});

test("accepts bounded side-chat fork and close requests", () => {
  for (const message of [
    { type: "open_side_chat", chatId: "chat-1" },
    { type: "open_side_chat" },
    { type: "close_side_chat", chatId: "chat-1" },
  ]) {
    assert.deepEqual(parseWebviewToHost(message), message);
  }
  assert.equal(parseWebviewToHost({ type: "close_side_chat", chatId: "../../outside" }), undefined);
});

test("cancel may target one opaque conversation id", () => {
  assert.deepEqual(parseWebviewToHost({ type: "cancel", chatId: "chat-123" }), {
    type: "cancel",
    chatId: "chat-123",
  });
  assert.equal(parseWebviewToHost({ type: "cancel", chatId: "../escape" }), undefined);
});

test("redirect and queued recovery messages may target one conversation", () => {
  for (const type of ["interject", "queue_send"]) {
    const message = { type, text: "follow up", chatId: "chat-123" };
    assert.deepEqual(parseWebviewToHost(message), message);
    assert.equal(
      parseWebviewToHost({ type, text: "follow up", chatId: "../escape" }),
      undefined,
    );
  }
});

test("settings saves require a positive integer revision", () => {
  const message = { type: "save_settings", revision: 7, settings: { provider: "openai" } };
  assert.deepEqual(parseWebviewToHost(message), message);
  assert.equal(parseWebviewToHost({ type: "save_settings", settings: {} }), undefined);
  assert.equal(
    parseWebviewToHost({ type: "save_settings", revision: 0, settings: {} }),
    undefined,
  );
});

test("rejects unknown, malformed, and traversal-bearing authority requests", () => {
  assert.equal(parseWebviewToHost({ type: "unknown" }), undefined);
  assert.equal(parseWebviewToHost({ type: "permission", requestId: "x", decision: "yes" }), undefined);
  assert.equal(parseWebviewToHost({ type: "select_chat", chatId: "../../outside" }), undefined);
  assert.equal(parseWebviewToHost({ type: "restore_checkpoint", sha: "abc", mode: "invalid" }), undefined);
});

test("accepts bounded, unique chat batches and rejects unsafe IDs", () => {
  for (const message of [
    { type: "delete_chats", chatIds: ["chat-1", "chat-2"] },
    { type: "pin_chats", chatIds: ["chat-1", "chat-2"], pinned: true },
    { type: "archive_chats", chatIds: ["chat-1", "chat-2"], archived: false },
  ]) {
    assert.deepEqual(parseWebviewToHost(message), message);
  }

  assert.equal(parseWebviewToHost({ type: "delete_chats", chatIds: [] }), undefined);
  assert.equal(
    parseWebviewToHost({ type: "delete_chats", chatIds: ["chat-1", "chat-1"] }),
    undefined,
  );
  assert.equal(
    parseWebviewToHost({ type: "pin_chats", chatIds: ["../../outside"], pinned: true }),
    undefined,
  );
  assert.equal(
    parseWebviewToHost({ type: "archive_chats", chatIds: ["chat-1"] }),
    undefined,
  );
  assert.equal(
    parseWebviewToHost({ type: "delete_chats", chatIds: Array.from({ length: 201 }, (_, i) => `chat-${i}`) }),
    undefined,
  );
});
