const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { buildSync } = require("esbuild");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claw-chat-recovery-"));
fs.mkdirSync(path.join(dir, "node_modules/vscode"), { recursive: true });
fs.writeFileSync(path.join(dir, "node_modules/vscode/index.js"), "module.exports = {workspace:{},window:{},commands:{},env:{}};");
function load(name) {
  const out = path.join(dir, `${name}.cjs`);
  buildSync({ entryPoints: [path.join(__dirname, `../src/${name}.ts`)], outfile: out,
    bundle: true, platform: "node", format: "cjs", external: ["vscode"], logLevel: "silent" });
  return require(out);
}
const { GatewayClient, SidecarHttpError, isChatNotFoundError } = load("gatewayClient");
const { ClawAgentsWebviewProvider } = load("webviewProvider");
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test("HTTP errors carry status and exact chat ownership without parsing message strings", async () => {
  const server = http.createServer((_request, response) => {
    response.writeHead(404, { "Content-Type": "application/json" });
    response.end('{"error":"not found"}');
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const gateway = new GatewayClient(() => ({ port: server.address().port, token: "test" }));
    await assert.rejects(gateway.patchChat("chat_saved", { model_route: { provider: "openai", model: "gpt-6.1-sol" } }), error => {
      assert.equal(error.statusCode, 404);
      assert.equal(error.pathName, "/chats/chat_saved");
      assert(isChatNotFoundError(error, "chat_saved"));
      assert(!isChatNotFoundError(error, "chat_other"));
      assert(!isChatNotFoundError(new Error(error.message), "chat_saved"));
      return true;
    });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

function fixture(error) {
  const posted = [], calls = [];
  const provider = Object.create(ClawAgentsWebviewProvider.prototype);
  Object.assign(provider, {
    chatId: "chat_saved", drafts: { chat_saved: "unsent draft" }, modelRoutes: new Map(),
    runs: { isActive: () => false }, chatRouteSaveChain: Promise.resolve(),
    sidecar: { ensureStarted: async () => {}, output: { appendLine: () => {} } },
    gateway: {
      getChat: async () => { calls.push("getChat"); if (error) throw error; return { id: "chat_saved" }; },
      patchChat: async () => { throw error; }, getPinnedContext: async () => ({ text: "" }),
    },
    post: message => posted.push(message),
    persistLocal: async state => calls.push(["persist", state]),
    refreshChats: async () => {}, refreshJobs: async () => {},
    postImagesPending: () => {}, postFilesPending: () => {},
    postChatRestore: async id => calls.push(["restore", id]),
    pushReady: async () => calls.push(["ready", provider.chatId]),
  });
  return { provider, posted, calls };
}
const missing = () => new SidecarHttpError("GET", "/chats/chat_saved?tail=400", 404, '{"error":"not found"}');

test("startup clears a truly missing pointer before ready and preserves its unsent draft", async () => {
  const { provider, posted, calls } = fixture(missing());
  await provider.bootstrapAfterReady();
  assert.equal(provider.chatId, undefined);
  assert.deepEqual(calls.find(Array.isArray)?.[0], "persist");
  assert(calls.indexOf("getChat") < calls.findIndex(call => Array.isArray(call) && call[0] === "ready"));
  assert(posted.some(message => message.type === "restore" && message.chatId === null && message.draft === "unsent draft"));
  assert.equal(provider.persistState().draft, "unsent draft");
});

test("transport and server failures retain the selected conversation and draft", async () => {
  for (const error of [new Error("ECONNREFUSED"), new SidecarHttpError("GET", "/chats/chat_saved", 500, "failure")]) {
    const { provider, posted } = fixture(error);
    await provider.bootstrapAfterReady();
    assert.equal(provider.chatId, "chat_saved");
    assert(!posted.some(message => message.type === "restore" && message.chatId === null));
  }
});

test("an old 404 arriving after navigation cannot clear the new selection", async () => {
  const { provider } = fixture(missing());
  provider.gateway.getChat = async () => { provider.chatId = "chat_new"; throw missing(); };
  await provider.bootstrapAfterReady();
  assert.equal(provider.chatId, "chat_new");
});

test("a missing model-route target recovers the selection without recreating a deleted chat", async () => {
  const { provider, posted } = fixture(missing());
  provider.gateway.patchChat = async () => { throw new SidecarHttpError("PATCH", "/chats/chat_saved", 404, "not found"); };
  provider.gateway.createChat = async () => assert.fail("deleted chat must not be recreated");
  await provider.handleMessage({ type: "set_chat_model_route", chatId: "chat_saved", modelRoute: { provider: "openai", model: "gpt-6.1-sol" } });
  assert.equal(provider.chatId, undefined);
  assert(!posted.some(message => message.type === "error" && /PATCH.*HTTP 404/.test(message.message)));
});


test("a recovered unassigned draft transfers into the next conversation", async () => {
  const { provider, posted } = fixture(missing());
  await provider.restoreCurrentChat();
  provider.gateway.createChat = async () => ({ id: "chat_new" });
  await provider.createOrReuseEmptyChat();
  assert.equal(provider.chatId, "chat_new");
  assert.equal(provider.persistState().draft, "unsent draft");
  assert.equal(provider.drafts[""], undefined);
  assert(posted.some(message => message.type === "restore" && message.chatId === "chat_new" && message.draft === "unsent draft"));
});
