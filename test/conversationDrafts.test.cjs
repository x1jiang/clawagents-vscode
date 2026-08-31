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

test("composer drafts persist per conversation and migrate the legacy draft", () => {
  assert.match(provider, /drafts\?: Record<string, string>/);
  assert.match(provider, /this\.drafts\[saved\.chatId\] = saved\.draft/);

  const persistState = section(provider, "private persistState()", "resolveWebviewView(");
  assert.match(persistState, /draft: this\.draftForChat\(\)/);
  assert.match(persistState, /drafts: \{ \.\.\.this\.drafts \}/);
});

test("restoring a conversation returns only that conversation's draft", () => {
  const restore = section(provider, "private async postChatRestore", "private async loadOlderChatEvents");
  assert.match(restore, /draft: draft \?\? this\.draftForChat\(chatId\)/);

  const persist = section(provider, 'case "persist":', "default:");
  assert.match(persist, /this\.rememberDraft\(msg\.chatId, msg\.draft\)/);
  assert.doesNotMatch(persist, /this\.chatId = msg\.chatId/);
});

test("thread navigation saves immediately without assigning the old draft to the new chat", () => {
  assert.match(
    app,
    /beginDraftHandoff\(\);\s*chatIdRef\.current = tab\.id/,
  );
  assert.match(
    app,
    /persistDraftNow\(\);\s*draftOwnerBeforeNavRef\.current = draftOwnerRef\.current;\s*draftOwnerRef\.current = undefined/,
  );
  assert.match(app, /chatId: draftOwnerRef\.current/);
  assert.match(
    app,
    /draftOwnerRef\.current = restoredChatId;[\s\S]*setDraft\(msg\.draft \|\| ""\)/,
  );
  assert.match(app, /const clearDraft = \(\) => \{\s*setDraft\(""\);\s*persistDraftNow\(""\)/);
});

test("failed navigation restores draft ownership so the composer keeps persisting", () => {
  assert.match(app, /const draftOwnerBeforeNavRef = useRef<string \| undefined>\(\)/);
  assert.match(
    app,
    /if \(draftOwnerRef\.current === undefined && draftOwnerBeforeNavRef\.current\) \{\s*draftOwnerRef\.current = draftOwnerBeforeNavRef\.current;\s*\}/,
  );
  assert.match(
    app,
    /draftOwnerRef\.current = restoredChatId;\s*draftOwnerBeforeNavRef\.current = undefined/,
  );
});

test("closing the last tab or all tabs flushes the composer before deselect", () => {
  assert.match(
    app,
    /persistDraftNow\(\);\s*draftOwnerRef\.current = undefined;\s*draftOwnerBeforeNavRef\.current = undefined;\s*chatIdRef\.current = undefined;\s*setChatId\(undefined\);\s*showPanel\("history"\);\s*post\(\{ type: "deselect_chat" \}\)/,
  );
  assert.match(
    app,
    /const closeAllConversationTabs = \(\) => \{\s*persistDraftNow\(\);/,
  );
});
