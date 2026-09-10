const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const app = fs.readFileSync(path.join(root, "webview", "src", "App.tsx"), "utf8");
const provider = fs.readFileSync(path.join(root, "src", "webviewProvider.ts"), "utf8");

function section(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(from, -1, `missing ${start}`);
  assert.notEqual(to, -1, `missing ${end}`);
  return source.slice(from, to);
}

test("New chat and Fork stay available while the current conversation runs", () => {
  const menu = section(app, 'className="composer-menu conversation-menu"', "</div>}\n              </div>");
  assert.match(menu, /type: "new_chat"/);
  assert.match(menu, /disabled=\{!items\.length\}/);
  assert.doesNotMatch(menu, /disabled=\{busy\}/);
  assert.doesNotMatch(menu, /disabled=\{busy \|\| !items\.length\}/);

  const fork = section(provider, 'case "fork_chat":', 'case "open_side_chat":');
  assert.match(fork, /A fork is a snapshot of the persisted conversation/);
  assert.match(fork, /this\.gateway\.forkChat\(targetId\)/);
  assert.doesNotMatch(fork, /this\.runs\.isActive\(targetId\)/);
  assert.doesNotMatch(fork, /Stop the current run before forking/);
});
