const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { buildSync } = require("esbuild");

const root = path.join(__dirname, "..");
const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawagents-pending-attachments-"));
const outputFile = path.join(outputDir, "pendingAttachments.cjs");
buildSync({
  entryPoints: [path.join(root, "src", "pendingAttachments.ts")],
  outfile: outputFile,
  bundle: true,
  platform: "node",
  format: "cjs",
  logLevel: "silent",
});
const { PendingAttachments } = require(outputFile);
const provider = fs.readFileSync(path.join(root, "src", "webviewProvider.ts"), "utf8");

test.after(() => fs.rmSync(outputDir, { recursive: true, force: true }));

function item(name) {
  return { id: name, name, data: "AAAA", mediaType: "image/png" };
}

function section(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(from, -1, `missing ${start}`);
  assert.notEqual(to, -1, `missing ${end}`);
  return source.slice(from, to);
}

test("a run claims only its own conversation's staged attachments", () => {
  const store = new PendingAttachments();
  store.images("chat-b").push(item("screenshot.png"));
  store.files("chat-b").push(item("notes.pdf"));

  // Conversation A's queued turn starts while B's composer holds attachments.
  assert.deepEqual(store.claim("chat-a"), { images: [], files: [] });
  assert.equal(store.images("chat-b").length, 1);
  assert.equal(store.files("chat-b").length, 1);

  const claimed = store.claim("chat-b");
  assert.deepEqual(claimed.images.map((i) => i.name), ["screenshot.png"]);
  assert.deepEqual(claimed.files.map((f) => f.name), ["notes.pdf"]);
  assert.equal(store.isEmpty("chat-b"), true);
});

test("claiming is one-shot", () => {
  const store = new PendingAttachments();
  store.images("chat-a").push(item("a.png"));
  assert.equal(store.claim("chat-a").images.length, 1);
  assert.equal(store.claim("chat-a").images.length, 0);
});

test("the unsaved composer's attachments follow it to its new conversation", () => {
  const store = new PendingAttachments();
  store.images(undefined).push(item("draft.png"));
  store.adopt(undefined, "chat-new");
  assert.equal(store.isEmpty(undefined), true);
  assert.deepEqual(store.images("chat-new").map((i) => i.name), ["draft.png"]);
});

test("adopt keeps what the target already had and ignores a self-move", () => {
  const store = new PendingAttachments();
  store.files("chat-a").push(item("a.pdf"));
  store.files("chat-b").push(item("b.pdf"));
  store.adopt("chat-a", "chat-b");
  assert.deepEqual(store.files("chat-b").map((f) => f.name), ["b.pdf", "a.pdf"]);
  store.adopt("chat-b", "chat-b");
  assert.equal(store.files("chat-b").length, 2);
});

test("replacing and discarding are scoped to one conversation", () => {
  const store = new PendingAttachments();
  store.images("chat-a").push(item("a1.png"), item("a2.png"));
  store.images("chat-b").push(item("b.png"));
  store.setImages("chat-a", store.images("chat-a").filter((i) => i.id !== "a1.png"));
  assert.deepEqual(store.images("chat-a").map((i) => i.name), ["a2.png"]);
  store.setImages("chat-a", []);
  assert.equal(store.isEmpty("chat-a"), true);
  store.discard("chat-b");
  assert.equal(store.isEmpty("chat-b"), true);
});

test("the provider no longer keeps provider-wide attachment arrays", () => {
  assert.doesNotMatch(provider, /private pendingImages: Array</);
  assert.doesNotMatch(provider, /private pendingFiles: Array</);
  assert.match(provider, /private readonly attachments = new PendingAttachments\(\)/);
});

test("runTask claims by run conversation and queued turns carry their own attachments", () => {
  const runTask = section(provider, "private async runTask(", "private drainQueueIfIdle(");
  assert.match(runTask, /queuedAttachments \?\? this\.claimAttachments\(runChatId\)/);
  assert.doesNotMatch(runTask, /this\.pendingImages/);
  assert.doesNotMatch(runTask, /this\.pendingFiles/);
  // Both enqueue paths snapshot attachments onto the queued turn.
  assert.equal(
    (runTask.match(/attachments: queuedAttachments \?\? this\.claimAttachments\(/g) || []).length,
    2,
  );

  const drain = section(provider, "private drainQueueIfIdle(", "private claimAttachments(");
  assert.match(drain, /next\.attachments/);
});

test("switching conversations re-syncs the attachment chips", () => {
  const setter = section(provider, "private set chatId(", "/** One temporary fork");
  assert.match(setter, /this\.postImagesPending\(\)/);
  assert.match(setter, /this\.postFilesPending\(\)/);
});
