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

test("queued turns are isolated by originating conversation", () => {
  assert.match(provider, /ThreadRunCoordinator<QueuedTurn>/);
  const drain = section(provider, "private drainQueueIfIdle", "private getHtml");
  assert.match(drain, /this\.runs\.dequeue\(chatId\)/);
  assert.match(drain, /next\.chatId/);
  assert.doesNotMatch(drain, /this\.chatId\)/);
});

test("redirects and recovered queue sends retain their conversation owner", () => {
  const queueSend = section(provider, 'case "queue_send":', 'case "interject":');
  const interject = section(provider, 'case "interject":', 'case "cancel":');
  assert.match(queueSend, /const targetChatId = msg\.chatId \|\| this\.chatId/);
  assert.match(queueSend, /this\.runs\.enqueue\(targetChatId/);
  assert.match(queueSend, /this\.drainQueueIfIdle\(targetChatId\)/);
  assert.match(interject, /const targetChatId = msg\.chatId \|\| this\.chatId/);
  assert.match(interject, /this\.gateway\.interject\(msg\.text, targetChatId\)/);
  assert.match(app, /type: "interject", text: value, chatId: chatIdRef\.current/);
  assert.match(app, /type: "queue_send", text, chatId: chatIdRef\.current/);
});

test("conversation navigation updates busy state before asynchronous restore", () => {
  assert.match(
    app,
    /chatIdRef\.current = c\.id;\s*setChatId\(c\.id\);\s*setBusy\(Boolean\(c\.running\)\)/,
  );
  assert.match(
    app,
    /chatIdRef\.current = tab\.id;\s*setChatId\(tab\.id\);\s*setBusy\(Boolean\(tab\.running\)\)/,
  );
  const send = section(app, "const send = () =>", "const beginAttachmentRequest");
  assert.match(send, /chatId: chatIdRef\.current/);
  assert.doesNotMatch(send, /\n\s*chatId,\n/);
});

test("different conversations reserve independent run slots", () => {
  const runTask = section(provider, "private async runTask", "private drainQueueIfIdle");
  assert.match(runTask, /this\.runs\.start\(runChatId\)/);
  assert.match(runTask, /this\.runs\.finish\(run\)/);
  assert.doesNotMatch(runTask, /this\.abort/);
});

test("cancellation is scoped to the selected conversation", () => {
  const cancel = section(provider, "async cancelTask", "async restartSidecar");
  assert.match(cancel, /this\.runs\.abort\(targetChatId\)/);
  assert.match(cancel, /this\.gateway\.cancel\(targetChatId\)/);
  assert.match(cancel, /this\.runs\.clearQueue\(targetChatId\)/);
});

test("run state follows its conversation through navigation", () => {
  const runTask = section(provider, "private async runTask", "private drainQueueIfIdle");
  assert.match(
    runTask,
    /thread_run_state[\s\S]*chatId: runChatId,[\s\S]*running: true/,
  );
  assert.match(
    runTask,
    /thread_run_state[\s\S]*chatId: runChatId,[\s\S]*running: false/,
  );
  assert.match(provider, /busy: this\.runs\.isActive\(chatId\)/);
  assert.match(app, /case "thread_run_state":/);
  assert.match(app, /chat\.id === msg\.chatId \? \{ \.\.\.chat, running: msg\.running \}/);
  assert.match(app, /setBusy\(Boolean\(msg\.busy\)\)/);
  assert.match(app, /type: "cancel", chatId: chatIdRef\.current/);
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
  assert.match(
    app,
    /chatIdRef\.current = c\.id;\s*setChatId\(c\.id\);\s*setBusy\(Boolean\(c\.running\)\);\s*post\(\{ type: "select_chat"/,
  );
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

test("stale interactive prompts badge the owner instead of disappearing", () => {
  assert.match(app, /const INTERACTIVE_EVENT_TYPES = new Set<HostToWebview\["type"\]>/);
  assert.match(app, /INTERACTIVE_EVENT_TYPES\.has\(msg\.type\)/);
  assert.match(app, /next\.set\(id, reason\)/);
  const runTask = section(provider, "private async runTask", "private drainQueueIfIdle");
  assert.match(runTask, /this\.pendingInteractions\.set\(runChatId, buf\)/);
  assert.match(
    runTask,
    /if \(runChatId !== this\.chatId && runChatId !== this\.sideChatId\)/,
  );
  assert.doesNotMatch(
    runTask,
    /isInteractive && runChatId && runChatId !== this\.chatId/,
  );
});

test("late restore cannot replace the currently displayed chat", () => {
  assert.match(app, /pendingNewChatRef/);
  assert.match(
    app,
    /msg\.chatId !== chatIdRef\.current &&\s*!pendingNew &&\s*!intentionalForkRestore/,
  );
});

test("an intentional fork restore switches to the newly created chat", () => {
  const forkChat = section(provider, 'case "fork_chat":', 'case "select_chat":');
  assert.match(forkChat, /postChatRestore\(res\.chat_id, chat, "", forkTitle, "fork"\)/);
  assert.match(
    app,
    /const intentionalForkRestore =\s*msg\.restoreReason === "fork" && pendingForkRef\.current/,
  );
});
