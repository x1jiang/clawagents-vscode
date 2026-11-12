const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { buildSync } = require("esbuild");

const root = path.join(__dirname, "..");
const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawagents-detached-poll-"));
const outputFile = path.join(outputDir, "detachedPoll.cjs");
buildSync({
  entryPoints: [path.join(root, "src", "detachedPoll.ts")],
  outfile: outputFile,
  bundle: true,
  platform: "node",
  format: "cjs",
  logLevel: "silent",
});
const {
  DETACHED_POLL_INTERVAL_MS,
  DETACHED_POLL_MAX_FAILURES,
  detachedPollRetryDelay,
} = require(outputFile);
const provider = fs.readFileSync(path.join(root, "src", "webviewProvider.ts"), "utf8");
const companion = fs.readFileSync(path.join(root, "src", "companionDeps.ts"), "utf8");

test.after(() => fs.rmSync(outputDir, { recursive: true, force: true }));

test("a failed poll is retried with capped exponential backoff", () => {
  const delays = [];
  for (let n = 1; n < DETACHED_POLL_MAX_FAILURES; n++) {
    delays.push(detachedPollRetryDelay(n, false));
  }
  assert.equal(delays[0], DETACHED_POLL_INTERVAL_MS);
  assert.deepEqual(delays, [1500, 3000, 6000, 12000, 15000, 15000, 15000]);
});

test("polling stops when the chat is gone or the sidecar stays unreachable", () => {
  assert.equal(detachedPollRetryDelay(1, true), undefined);
  assert.equal(detachedPollRetryDelay(DETACHED_POLL_MAX_FAILURES, false), undefined);
});

test("the poller retries instead of declaring the turn finished on one error", () => {
  const from = provider.indexOf("private watchDetachedChatRun(");
  const to = provider.indexOf("private async loadOlderChatEvents", from);
  const poller = provider.slice(from, to);
  assert.match(poller, /detachedPollRetryDelay\(failures, isChatNotFoundError\(err, chatId\)\)/);
  assert.match(poller, /failures = 0;/);
  // Giving up must not strand queued turns.
  const giveUp = poller.slice(poller.indexOf("} catch (err) {"));
  assert.match(giveUp, /this\.drainQueueIfIdle\(chatId\)/);
  // Timers are tracked so dispose() can cancel them.
  assert.match(provider, /for \(const timer of this\.detachedPollTimers\.values\(\)\)/);
});

test("companion probes never fall back to the workspace-merged pythonPath", () => {
  assert.doesNotMatch(companion, /get<string>\("pythonPath"\)/);
  // probeGraphify, probeGraphifyAsync, ensureGraphify, ensureCompanionsOnce.
  assert.equal((companion.match(/trustedPythonPathSetting\(\)/g) || []).length, 4);
});
