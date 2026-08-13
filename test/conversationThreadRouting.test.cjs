const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const provider = fs.readFileSync(path.join(root, "src", "webviewProvider.ts"), "utf8");
const app = fs.readFileSync(path.join(root, "webview", "src", "App.tsx"), "utf8");

function section(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(from, -1, `missing ${start}`);
  assert.notEqual(to, -1, `missing ${end}`);
  return source.slice(from, to);
}

test("queued turns retain their originating conversation", () => {
  assert.match(provider, /private queue: QueuedTurn\[\]/);
  const drain = section(provider, "private drainQueueIfIdle", "private getHtml");
  assert.match(drain, /next\.chatId/);
  assert.doesNotMatch(drain, /this\.chatId\)/);
});

test("an active stream uses its stable chat owner", () => {
  const runTask = section(provider, "private async runTask", "private drainQueueIfIdle");
  assert.match(runTask, /streamChat\(\s*task,\s*runChatId,/);
  assert.match(runTask, /chatId: runChatId/);
  assert.match(runTask, /if \(this\.chatId === runChatId\)/);
  assert.doesNotMatch(runTask, /streamChat\(\s*task,\s*this\.chatId,/);
});

test("late selection responses and old events cannot replace the current chat", () => {
  const selectChat = section(provider, 'case "select_chat":', 'case "load_older_chat":');
  assert.match(selectChat, /if \(this\.chatId !== msg\.chatId\)/);
  assert.match(app, /chatIdRef\.current = c\.id;\s*setChatId\(c\.id\);\s*post\(\{ type: "select_chat"/);
});

test("every run-scoped event, including the canonical final response, is stale-guarded", () => {
  const guarded = section(
    app,
    'const runScopedEventTypes = new Set<HostToWebview["type"]>([',
    "]);",
  );
  for (const type of [
    "status",
    "user_echo",
    "assistant_delta",
    "assistant_message",
    "tool_started",
    "tool_completed",
    "permission_required",
    "ask_user_required",
    "plan_approval_required",
    "plan_approved",
    "file_changed",
    "usage",
    "compact_progress",
    "checkpoint",
    "done",
    "error",
    "cancelled",
  ]) {
    assert.match(guarded, new RegExp(`"${type}"`), `${type} must be guarded`);
  }
  assert.match(
    app,
    /runScopedEventTypes\.has\(msg\.type\) && isStaleEvent\(msg\)/,
  );
});
