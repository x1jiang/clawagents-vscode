const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const app = fs.readFileSync(path.join(root, "webview", "src", "App.tsx"), "utf8");
const provider = fs.readFileSync(path.join(root, "src", "webviewProvider.ts"), "utf8");
const styles = fs.readFileSync(path.join(root, "webview", "src", "styles.css"), "utf8");

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
  assert.match(app, /type HistorySectionKey = "pinned" \| "recent" \| "archived" \| `group:\$\{string\}`/);
  assert.match(app, /historySectionsExpanded/);
  assert.match(app, /aria-expanded=\{expanded\}/);
  assert.match(app, /hidden=\{!expanded\}/);
  assert.match(app, /searching \|\| \(historySectionsExpanded\[key\] \?\? true\)/);
  assert.match(app, /renderHistorySection\("pinned", "Pinned", pinnedChats\)/);
  assert.match(app, /renderHistorySection\("recent", "Recent", regularChats,/);
  assert.match(app, /renderHistorySection\("archived", "Archived", archivedChats\)/);
  assert.match(styles, /\.chat-list\[hidden\]\s*\{\s*display:\s*none;/s);
});

test("History supports custom groups, moving chats, and drag ordering", () => {
  assert.match(app, /create_chat_group/);
  assert.match(app, /move_chats_to_group/);
  assert.match(app, /reorder_chat_groups/);
  assert.match(app, /application\/x-claw-chat/);
  assert.match(app, /application\/x-claw-group/);
  assert.match(app, /Delete and archive chats/);
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
