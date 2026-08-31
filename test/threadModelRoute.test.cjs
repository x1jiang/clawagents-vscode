const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const provider = fs.readFileSync(path.join(root, "src", "webviewProvider.ts"), "utf8");
const app = fs.readFileSync(path.join(root, "webview", "src", "App.tsx"), "utf8");
const capsule = fs.readFileSync(path.join(root, "webview", "src", "ModelRouteCapsule.tsx"), "utf8");
const styles = fs.readFileSync(path.join(root, "webview", "src", "styles.css"), "utf8");

test("thread model route is restored, patched, queued, and sent atomically", () => {
  assert.match(provider, /private readonly modelRoutes = new Map<string, ModelRoute>/);
  assert.match(provider, /private chatRouteSaveChain: Promise<void> = Promise\.resolve\(\)/);
  assert.match(provider, /modelRoute: modelRouteOverride \?\? this\.modelRoutes\.get\(requestedChatId\)/);
  assert.match(provider, /model_route: msg\.modelRoute/);
  assert.match(provider, /modelRoute,\s*\n\s*\);/);
  assert.match(app, /set_chat_model_route/);
  assert.match(app, /modelRoute: threadModelRouteRef\.current \?\? undefined/);
  assert.match(app, /Default model for new chats/);
  assert.match(app, /ModelRouteCapsule/);
  assert.match(capsule, /Reset to new-chat default/);
  assert.match(capsule, /onProviderChange/);
  assert.match(capsule, /onModelChange/);
  assert.match(capsule, /onEffortChange/);
  assert.match(provider, /type: "model_changed"/);
  assert.match(provider, /kind === "model_change"/);
  assert.match(app, /kind: "model_change"/);
  assert.match(app, /model: sideChat\.modelRoute\?\.model \|\| undefined/);
  assert.match(provider, /modelRoute: sideModelRoute/);
  assert.match(styles, /grid-template-rows: minmax\(0, 1fr\) auto/);
  assert.match(styles, /height: min\(30rem, calc\(100dvh - 132px\)\)/);
  assert.match(styles, /overscroll-behavior: contain/);
});
