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
  assert.match(sideChatCase, /parentChatId: targetId/);
  assert.match(app, /post\(\{ type: "open_side_chat", chatId \}\)/);
  assert.match(app, /disabled=\{!chatId \|\| Boolean\(sideChat\)\}/);
});

test("side chats are stored per parent and route hidden-thread events locally", () => {
  assert.match(app, /useState<Record<string, SideChat>>\(\{\}\)/);
  assert.match(app, /sideChatsRef\.current\[candidate\]\?\.chatId === owner/);
  assert.match(app, /replaceSideChat\(parentChatId/);
  assert.match(app, /const applySideChatEvent = \(msg: HostToWebview\)/);
  assert.match(app, /case "permission_required": return append/);
  assert.match(app, /case "ask_user_required": return append/);
  assert.match(app, /case "plan_approval_required": return append/);
  assert.match(provider, /runChatId !== this\.chatId && !this\.sideChatIds\.has\(runChatId\)/);
  assert.match(app, /type: "close_side_chat", chatId: sideChat\.chatId/);
  assert.match(provider, /case "close_side_chat":/);
  assert.match(provider, /this\.cancelTask\(msg\.chatId\)/);
  assert.match(provider, /await this\.gateway\.deleteChat\(msg\.chatId\)/);
  assert.match(app, /!hiddenSideChatIds\.has\(c\.id\)/);
  assert.match(app, /case "thread_run_state": return \{ \.\.\.current, busy: msg\.running \}/);
});

test("host releases the side-chat slot before async close cleanup", () => {
  const closeCase = provider.slice(
    provider.indexOf('case "close_side_chat":'),
    provider.indexOf('case "select_chat":'),
  );
  const clearIdx = closeCase.indexOf("this.sideChatIds.delete(msg.chatId)");
  const parentClearIdx = closeCase.indexOf("this.sideChats.delete(parentChatId)");
  const cancelIdx = closeCase.indexOf("this.cancelTask");
  const deleteIdx = closeCase.indexOf("this.gateway.deleteChat");
  assert.ok(clearIdx >= 0, "close_side_chat must clear the side-chat id");
  assert.ok(parentClearIdx >= 0, "close_side_chat must clear its parent mapping");
  assert.ok(clearIdx < cancelIdx, "side-chat id must be cleared before cancelTask");
  assert.ok(parentClearIdx < deleteIdx, "parent mapping must be cleared before deleteChat");
  assert.doesNotMatch(closeCase, /finally \{/);
});

test("host coalesces repeated opens per parent without blocking other threads", () => {
  assert.match(provider, /private readonly sideChats = new Map<string, string>\(\)/);
  assert.match(provider, /private readonly sideChatOpenings = new Set<string>\(\)/);
  assert.match(provider, /this\.sideChatOpenings\.has\(targetId\) \|\| this\.sideChats\.has\(targetId\)/);
  assert.match(provider, /this\.sideChatOpenings\.add\(targetId\)/);
  assert.match(provider, /finally \{\s*this\.sideChatOpenings\.delete\(targetId\);/);
  assert.doesNotMatch(provider, /this\.abort|activeRunChatId/);
});

test("minimized side chat is a draggable compact launcher that expands on demand", () => {
  assert.match(app, /peekY\?: number/);
  assert.match(app, /onPointerDown=\{beginPeekDrag\}/);
  assert.match(app, /onPointerMove=\{movePeekDrag\}/);
  assert.match(app, /onPeekYChange\(Math\.max\(8, Math\.min\(maxTop, drag\.startTop \+ delta\)\)\)/);
  assert.match(app, /if \(suppressPeekClickRef\.current\) \{[\s\S]*return;/);
  assert.match(app, /onPeekYChange=\{\(peekY\) => replaceSideChat/);
});

test("side chat frame supports drag resize and maximize or restore", () => {
  assert.match(app, /const beginResize =/);
  assert.match(app, /drag\.startWidth - \(event\.clientX - drag\.startPointerX\)/);
  assert.match(app, /drag\.startHeight - \(event\.clientY - drag\.startPointerY\)/);
  assert.match(app, /onToggleMaximized/);
  assert.match(styles, /\.side-chat\.maximized\s*\{/);
  assert.match(styles, /\.side-chat-resize-handle\s*\{/);
});

test("side chat launcher attaches to the right edge and conversations open at the latest message", () => {
  assert.match(styles, /button\.side-chat-peek\s*\{[^}]*right:\s*0;[^}]*border-right:\s*0;[^}]*border-radius:\s*8px 0 0 8px;[^}]*background:\s*var\(--input-bg\);/s);
  assert.doesNotMatch(app, /side-chat-peek-label/);
  assert.match(app, /sideChatBottomRef\.current\?\.scrollIntoView\(\{ block: "end" \}\)/);
  assert.match(app, /stickToBottomRef\.current = true;\s*window\.requestAnimationFrame\(\(\) => bottomRef\.current\?\.scrollIntoView\(\{ block: "end" \}\)\)/s);
});
