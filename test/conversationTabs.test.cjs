const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const app = fs.readFileSync(path.join(root, "webview", "src", "App.tsx"), "utf8");
const styles = fs.readFileSync(path.join(root, "webview", "src", "styles.css"), "utf8");

test("conversation tabs open from history and select their owning chat", () => {
  assert.match(app, /setOpenConversationTabs\(\(previous\) => upsertConversationTab\(previous, c\.id, chats\)\)/);
  assert.match(app, /post\(\{ type: "select_chat", chatId: tab\.id \}\)/);
  assert.match(app, /className="conversation-tab-main"/);
});

test("conversation tabs can close, close all tabs, and pin a thread", () => {
  assert.match(app, /const closeConversationTab = \(closingId: string\)/);
  assert.match(app, /const closeAllConversationTabs = \(\) => \{\s*setOpenConversationTabs\(\[\]\)/);
  assert.match(app, /post\(\{ type: "pin_chat", chatId: tab\.id, pinned \}\)/);
  assert.match(app, />\s*Close all\s*</);
  assert.match(app, /onContextMenu=/);
});

test("the navigation and conversation strips stay on one line", () => {
  assert.match(styles, /\.tabs\s*\{[^}]*flex-wrap:\s*nowrap;/s);
  assert.match(styles, /\.conversation-tabs\s*\{[^}]*overflow-x:\s*hidden;/s);
  assert.match(styles, /\.conversation-tab\s*\{[^}]*flex:\s*1 1 140px;/s);
  assert.match(styles, /@container \(max-width: 54px\)[\s\S]*\.conversation-tab-title\s*\{[^}]*display:\s*none;/);
  assert.match(app, /className="tabs-divider"[^>]*>\|<\/span>/);
});

test("tabs drop deleted or archived chats and clear chatId when the last tab closes", () => {
  assert.match(app, /if \(!summary \|\| summary\.archived\) return \[\]/);
  assert.match(app, /post\(\{ type: "deselect_chat" \}\)/);
  assert.match(
    app,
    /chatIdRef\.current = undefined;\s*setChatId\(undefined\);\s*setPanel\("history"\);\s*post\(\{ type: "deselect_chat" \}\)/,
  );
});
