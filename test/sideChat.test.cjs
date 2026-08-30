const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const protocol = fs.readFileSync(path.join(root, "src", "protocol.ts"), "utf8");
const provider = fs.readFileSync(path.join(root, "src", "webviewProvider.ts"), "utf8");
const app = fs.readFileSync(path.join(root, "webview", "src", "App.tsx"), "utf8");
const styles = fs.readFileSync(path.join(root, "webview", "src", "styles.css"), "utf8");

test("side chat forks without replacing the selected conversation", () => {
  assert.match(protocol, /type: "open_side_chat"/);
  assert.match(protocol, /type: "side_chat_open"/);
  assert.match(provider, /case "open_side_chat":/);
  assert.match(provider, /this\.gateway\.forkChat\(targetId\)/);
  const sideChatCase = provider.slice(provider.indexOf('case "open_side_chat":'), provider.indexOf('case "close_side_chat":'));
  assert.doesNotMatch(sideChatCase, /this\.chatId = res\.chat_id/);
  assert.doesNotMatch(sideChatCase, /runs\.isActive\(targetId\)/);
  assert.match(app, /post\(\{ type: "open_side_chat", chatId \}\)/);
  assert.match(app, /disabled=\{!chatId \|\| Boolean\(sideChat\)\}/);
});

test("side chat routes its events locally and deletes its fork when closed", () => {
  assert.match(app, /const applySideChatEvent = \(msg: HostToWebview\)/);
  assert.match(app, /sideChatRef\.current\?\.chatId !== owner/);
  assert.match(app, /case "permission_required": return append/);
  assert.match(app, /case "ask_user_required": return append/);
  assert.match(app, /case "plan_approval_required": return append/);
  assert.match(provider, /runChatId !== this\.chatId && runChatId !== this\.sideChatId/);
  assert.match(app, /type: "close_side_chat", chatId: sideChat\.chatId/);
  assert.match(provider, /case "close_side_chat":/);
  assert.match(provider, /this\.cancelTask\(msg\.chatId\)/);
  assert.match(provider, /await this\.gateway\.deleteChat\(msg\.chatId\)/);
  assert.match(app, /c\.id !== sideChat\?\.chatId/);
  assert.match(app, /case "thread_run_state": return \{ \.\.\.current, busy: msg\.running \}/);
});

test("host coalesces repeated side-chat opens", () => {
  assert.match(provider, /private sideChatOpening = false/);
  assert.match(provider, /if \(this\.sideChatOpening \|\| this\.sideChatId\)/);
  assert.match(provider, /this\.sideChatOpening = true/);
  assert.match(provider, /finally \{\s*this\.sideChatOpening = false;/);
  assert.doesNotMatch(provider, /this\.abort|activeRunChatId/);
});

test("minimized side chat is a draggable compact launcher that expands on demand", () => {
  assert.match(app, /peekY\?: number/);
  assert.match(app, /onPointerDown=\{beginPeekDrag\}/);
  assert.match(app, /onPointerMove=\{movePeekDrag\}/);
  assert.match(app, /onPeekYChange\(Math\.max\(8, Math\.min\(maxTop, drag\.startTop \+ delta\)\)\)/);
  assert.match(app, /if \(suppressPeekClickRef\.current\) \{[\s\S]*return;/);
  assert.match(app, /onPeekYChange=\{\(peekY\) => setSideChat/);
});

test("side chat launcher attaches to the right edge and conversations open at the latest message", () => {
  assert.match(styles, /button\.side-chat-peek\s*\{[^}]*right:\s*0;[^}]*border-right:\s*0;[^}]*border-radius:\s*8px 0 0 8px;[^}]*background:\s*var\(--input-bg\);/s);
  assert.doesNotMatch(app, /side-chat-peek-label/);
  assert.match(app, /sideChatBottomRef\.current\?\.scrollIntoView\(\{ block: "end" \}\)/);
  assert.match(app, /stickToBottomRef\.current = true;\s*window\.requestAnimationFrame\(\(\) => bottomRef\.current\?\.scrollIntoView\(\{ block: "end" \}\)\)/s);
});
