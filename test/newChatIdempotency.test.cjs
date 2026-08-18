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
  assert.match(newChat, /const pending = this\.createNewChat\(\)/);
  assert.match(newChat, /this\.newChatPromise = pending/);
});

test("New always creates a fresh conversation", () => {
  const create = section(
    provider,
    "private async createNewChat",
    "async newChat(): Promise<void>",
  );
  assert.match(create, /this\.gateway\.createChat\(this\.mode\)/);
  assert.doesNotMatch(create, /this\.gateway\.getChat/);
});

test("New does not overwrite a conversation selected while create was in flight", () => {
  const create = section(
    provider,
    "private async createNewChat",
    "async newChat(): Promise<void>",
  );
  const afterCreate = create.slice(create.indexOf("this.gateway.createChat"));
  assert.match(afterCreate, /if \(this\.chatId !== startedOn\)/);
  assert.match(afterCreate, /await this\.refreshChats\(\);\s*return;/);
});
