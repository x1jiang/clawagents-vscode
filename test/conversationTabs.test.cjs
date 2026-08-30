const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const app = fs.readFileSync(path.join(root, "webview", "src", "App.tsx"), "utf8");
const styles = fs.readFileSync(path.join(root, "webview", "src", "styles.css"), "utf8");

test("open threads enter the list from history and select their owning chat", () => {
  assert.match(app, /setOpenConversationTabs\(\(previous\) => upsertConversationTab\(previous, c\.id, chats\)\)/);
  assert.match(app, /post\(\{ type: "select_chat", chatId: tab\.id \}\)/);
  assert.match(app, /className="threads-row-main"/);
});

test("the thread popover can close, close all, pin, and unpin threads", () => {
  assert.match(app, /const closeConversationTab = \(closingId: string\)/);
  assert.match(app, /const closeAllConversationTabs = \(\) => \{\s*persistDraftNow\(\);/);
  assert.match(app, /post\(\{ type: "pin_chat", chatId: tab\.id, pinned \}\)/);
  assert.match(app, />\s*Close all\s*</);
  assert.match(app, /className=\{`threads-row-action\$\{tab\.pinned \? " pinned" : ""\}`\}/);
  assert.match(app, /title=\{tab\.pinned \? `Unpin \$\{tab\.title\}` : `Pin \$\{tab\.title\}`\}/);
});

test("the thread button stays in the navigation row and opens a hoverable popover", () => {
  assert.match(styles, /\.tabs\s*\{[^}]*flex-wrap:\s*nowrap;/s);
  assert.match(styles, /\.threads-popover-root\s*\{[^}]*position:\s*relative;/s);
  assert.match(styles, /\.threads-popover\s*\{[^}]*position:\s*absolute;/s);
  assert.match(app, /onMouseEnter=\{\(\) => setThreadsPopoverOpen\(true\)\}/);
  assert.match(app, /aria-expanded=\{threadsPopoverOpen\}/);
  assert.match(app, /className="tabs-divider"[^>]*>\|<\/span>/);
});

test("fork-switch notice dismisses itself after a short delay", () => {
  assert.match(
    app,
    /if \(!forkNotice\) return;\s*const timer = window\.setTimeout\(\(\) => setForkNotice\(null\), 4_000\);\s*return \(\) => window\.clearTimeout\(timer\);/s,
  );
});

test("tabs drop deleted or archived chats and clear chatId when the last tab closes", () => {
  assert.match(app, /if \(!summary \|\| summary\.archived\) return \[\]/);
  assert.match(app, /post\(\{ type: "deselect_chat" \}\)/);
  assert.match(
    app,
    /chatIdRef\.current = undefined;\s*setChatId\(undefined\);\s*showPanel\("history"\);\s*post\(\{ type: "deselect_chat" \}\)/,
  );
});
