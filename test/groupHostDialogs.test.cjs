const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { buildSync } = require("esbuild");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claw-group-dialogs-"));
fs.mkdirSync(path.join(dir, "node_modules/vscode"), { recursive: true });
fs.writeFileSync(path.join(dir, "node_modules/vscode/index.js"), "module.exports = { window: {} };");
buildSync({
  entryPoints: [path.join(__dirname, "../src/webviewProvider.ts")],
  outfile: path.join(dir, "provider.cjs"),
  bundle: true, platform: "node", format: "cjs", external: ["vscode"], logLevel: "silent",
});
const vscode = require(path.join(dir, "node_modules/vscode"));
const { ClawAgentsWebviewProvider } = require(path.join(dir, "provider.cjs"));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

function fixture(answer) {
  const calls = [];
  const provider = Object.create(ClawAgentsWebviewProvider.prototype);
  provider.gateway = {
    listChatGroups: async () => [{ id: "group-1", name: "Research" }],
    createChatGroup: async (name) => calls.push(["create", name]),
    renameChatGroup: async (id, name) => calls.push(["rename", id, name]),
    deleteChatGroup: async (id) => calls.push(["delete", id]),
  };
  provider.refreshChatGroups = async () => calls.push(["refreshGroups"]);
  provider.refreshChats = async () => calls.push(["refreshChats"]);
  provider.post = (message) => calls.push(["post", message]);
  vscode.window.showInputBox = async (options) => {
    calls.push(["input", options]);
    return answer;
  };
  vscode.window.showWarningMessage = async (...args) => {
    calls.push(["warning", ...args]);
    return answer;
  };
  return { provider, calls };
}

test("create and rename ask the host and trim accepted names", async () => {
  for (const type of ["create_chat_group", "rename_chat_group"]) {
    const { provider, calls } = fixture("  New name  ");
    await provider.handleMessage({ type, groupId: "group-1" });
    assert.equal(calls[0][0], "input");
    assert.equal(calls[0][1].value, type === "rename_chat_group" ? "Research" : "");
    assert.deepEqual(calls.slice(1), [
      type === "create_chat_group" ? ["create", "New name"] : ["rename", "group-1", "New name"],
      ["refreshGroups"],
    ]);
  }
});

test("cancelled, invalid, and unchanged names do not mutate groups", async () => {
  for (const type of ["create_chat_group", "rename_chat_group"]) {
    for (const answer of [undefined, "   ", "x".repeat(81)]) {
      const { provider, calls } = fixture(answer);
      await provider.handleMessage({ type, groupId: "group-1" });
      assert.deepEqual(calls.map(([kind]) => kind), ["input"]);
    }
  }
  const { provider, calls } = fixture(" Research ");
  await provider.handleMessage({ type: "rename_chat_group", groupId: "group-1" });
  assert.deepEqual(calls.map(([kind]) => kind), ["input"]);
});

test("group input validates blank and overlong names before acceptance", async () => {
  const { provider, calls } = fixture(undefined);
  await provider.handleMessage({ type: "create_chat_group" });
  const validate = calls[0][1].validateInput;
  assert.ok(validate("   "));
  assert.ok(validate("x".repeat(81)));
  assert.equal(validate("x".repeat(80)), undefined);
  assert.equal(validate(" Research "), undefined);
});

test("deletion requires explicit native modal confirmation before mutation", async () => {
  for (const answer of [undefined, "Cancel", "Delete and archive chats"]) {
    const { provider, calls } = fixture(answer);
    await provider.handleMessage({ type: "delete_chat_group", groupId: "group-1" });
    assert.equal(calls[0][0], "warning");
    assert.match(calls[0][1], /Research/);
    assert.match(calls[0][1], /archive all/i);
    assert.equal(calls[0][2].modal, true);
    assert.equal(calls[0][3], "Delete and archive chats");
    assert.deepEqual(calls.slice(1), answer === "Delete and archive chats"
      ? [["delete", "group-1"], ["refreshGroups"], ["refreshChats"]]
      : []);
  }
});

test("group controls never depend on blocked webview browser dialogs", () => {
  const app = fs.readFileSync(path.join(__dirname, "../webview/src/App.tsx"), "utf8");
  const handlers = app.slice(app.indexOf("const createHistoryGroup"), app.indexOf("const moveChatsToGroup"));
  assert.doesNotMatch(handlers, /window\.(prompt|confirm)/);
});
