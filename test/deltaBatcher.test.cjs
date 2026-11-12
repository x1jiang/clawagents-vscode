const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { buildSync } = require("esbuild");

const root = path.join(__dirname, "..");
const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawagents-delta-batcher-"));
const outputFile = path.join(outputDir, "deltaBatcher.cjs");
buildSync({
  entryPoints: [path.join(root, "src", "deltaBatcher.ts")],
  outfile: outputFile,
  bundle: true,
  platform: "node",
  format: "cjs",
  logLevel: "silent",
});
const { DeltaBatcher, DELTA_FLUSH_INTERVAL_MS } = require(outputFile);
const provider = fs.readFileSync(path.join(root, "src", "webviewProvider.ts"), "utf8");

test.after(() => fs.rmSync(outputDir, { recursive: true, force: true }));

function harness() {
  const sent = [];
  const timers = [];
  const clock = {
    setTimeout: (fn, ms) => {
      const t = { fn, ms, cleared: false };
      timers.push(t);
      return t;
    },
    clearTimeout: (t) => {
      t.cleared = true;
    },
  };
  const batcher = new DeltaBatcher((m) => sent.push(m), DELTA_FLUSH_INTERVAL_MS, clock);
  const fire = () => {
    for (const t of timers.splice(0)) if (!t.cleared) t.fn();
  };
  return { batcher, sent, timers, fire };
}
const delta = (text, chatId = "a") => ({ type: "assistant_delta", delta: text, chatId });

test("a burst of tokens becomes one message per interval", () => {
  const { batcher, sent, timers, fire } = harness();
  for (const tok of ["The ", "quick ", "brown ", "fox"]) batcher.post(delta(tok));
  assert.deepEqual(sent, [], "nothing is posted per token");
  assert.equal(timers.length, 1, "one timer for the whole burst");
  assert.equal(timers[0].ms, DELTA_FLUSH_INTERVAL_MS);
  fire();
  assert.deepEqual(sent, [delta("The quick brown fox")]);
  batcher.post(delta("!"));
  fire();
  assert.deepEqual(sent, [delta("The quick brown fox"), delta("!")]);
});

test("other messages flush pending text first, so order is preserved", () => {
  const { batcher, sent } = harness();
  batcher.post(delta("Running the tests"));
  batcher.post(delta("…"));
  const tool = { type: "tool_started", id: "1", name: "execute", chatId: "a" };
  batcher.post(tool);
  assert.deepEqual(sent, [delta("Running the tests…"), tool]);
  const final = { type: "assistant_message", text: "done", chatId: "a" };
  batcher.post(delta("do"));
  batcher.post(final);
  assert.deepEqual(sent.slice(2), [delta("do"), final]);
});

test("a reset is never overtaken by, or merged across, the text around it", () => {
  const { batcher, sent, fire } = harness();
  batcher.post(delta("partial"));
  batcher.post({ type: "assistant_reset", chatId: "a" });
  batcher.post(delta("fresh"));
  fire();
  assert.deepEqual(sent, [delta("partial"), { type: "assistant_reset", chatId: "a" }, delta("fresh")]);
});

test("conversations streaming at once are not merged into each other", () => {
  const { batcher, sent, fire } = harness();
  batcher.post(delta("a1", "a"));
  batcher.post(delta("b1", "b"));
  batcher.post(delta("b2", "b"));
  batcher.post(delta("a2", "a"));
  fire();
  assert.deepEqual(sent, [delta("a1", "a"), delta("b1b2", "b"), delta("a2", "a")]);
});

test("non-delta messages pass straight through with no timer", () => {
  const { batcher, sent, timers } = harness();
  const msg = { type: "status", message: "hi" };
  batcher.post(msg);
  assert.deepEqual(sent, [msg]);
  assert.equal(timers.length, 0);
});

test("dispose drops pending text and cancels the timer", () => {
  const { batcher, sent, timers, fire } = harness();
  batcher.post(delta("x"));
  batcher.dispose();
  assert.equal(timers[0].cleared, true);
  fire();
  assert.deepEqual(sent, []);
});

test("the provider posts through the batcher and disposes it", () => {
  const post = provider.slice(provider.indexOf("  post(msg: HostToWebview): void {"));
  assert.match(post.slice(0, 400), /new DeltaBatcher\(/);
  assert.match(provider, /this\.deltaBatcher\?\.dispose\(\)/);
});
