const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const app = fs.readFileSync(path.join(root, "webview", "src", "App.tsx"), "utf8");
const provider = fs.readFileSync(path.join(root, "src", "webviewProvider.ts"), "utf8");

test("History supports range and toggle selection with bulk actions", () => {
  assert.match(app, /event\.shiftKey/);
  assert.match(app, /event\.metaKey \|\| event\.ctrlKey/);
  assert.match(app, /orderedHistoryChats\.slice\(start, end \+ 1\)/);
  assert.match(app, /type: "delete_chats"/);
  assert.match(app, /type: "pin_chats"/);
  assert.match(app, /type: "archive_chats"/);
  assert.match(app, /Delete permanently\?/);
  assert.match(app, /selectedChats\.length > 0 \? \(/);
  assert.match(app, /historySelectionMode \|\| event\.metaKey \|\| event\.ctrlKey/);
  assert.match(app, /historySelectionMode \? "Done" : "Select"/);
  assert.match(app, /!historySelectionMode \? \(\s*<div className="chat-row-actions">/);
  assert.match(app, />\s*Fork\s*<\/button>/);
});

test("History sections collapse, persist, and expand while searching", () => {
  assert.match(app, /type HistorySectionKey = "pinned" \| "recent" \| "archived"/);
  assert.match(app, /historySectionsExpanded/);
  assert.match(app, /aria-expanded=\{expanded\}/);
  assert.match(app, /hidden=\{!expanded\}/);
  assert.match(app, /searching \|\| historySectionsExpanded\[key\]/);
  assert.match(app, /renderHistorySection\("pinned", "Pinned", pinnedChats\)/);
  assert.match(app, /renderHistorySection\("recent", "Recent", regularChats\)/);
  assert.match(app, /renderHistorySection\("archived", "Archived", archivedChats\)/);
});

test("host batches mutations behind one refresh helper", () => {
  assert.match(provider, /private async applyChatBatch/);
  assert.match(provider, /Promise\.allSettled/);
  assert.match(provider, /case "delete_chats"/);
  assert.match(provider, /case "pin_chats"/);
  assert.match(provider, /case "archive_chats"/);
  assert.match(provider, /chatId: null/);
  assert.match(app, /msg\.chatId !== undefined/);
});
