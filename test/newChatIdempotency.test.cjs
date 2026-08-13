const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const provider = fs.readFileSync(path.join(root, "src", "webviewProvider.ts"), "utf8");

function section(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(from, -1, `missing ${start}`);
  assert.notEqual(to, -1, `missing ${end}`);
  return source.slice(from, to);
}

test("repeated New clicks share one in-flight operation", () => {
  assert.match(provider, /private newChatPromise\?: Promise<void>/);
  const newChat = section(provider, "async newChat(): Promise<void>", "async cancelTask");
  assert.match(newChat, /if \(this\.newChatPromise\)/);
  assert.match(newChat, /const pending = this\.createOrReuseEmptyChat\(\)/);
  assert.match(newChat, /this\.newChatPromise = pending/);
});

test("New reuses only the currently selected, genuinely empty chat", () => {
  const create = section(
    provider,
    "private async createOrReuseEmptyChat",
    "async newChat(): Promise<void>",
  );
  assert.match(create, /this\.gateway\.getChat\(currentChatId, \{ tail: 1 \}\)/);
  assert.match(create, /this\.chatId === currentChatId/);
  assert.match(create, /Number\(current\.message_count\) === 0/);
  assert.match(create, /Number\(current\.events_total\) === 0/);
  assert.match(create, /return;[\s\S]*this\.gateway\.createChat\(this\.mode\)/);
});
