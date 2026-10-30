const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { buildSync } = require("esbuild");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawagents-timing-"));
const output = path.join(dir, "timing.cjs");
buildSync({ entryPoints: [path.join(__dirname, "../webview/src/conversationTiming.ts")], outfile: output, bundle: true, platform: "node", format: "cjs" });
const { formatConversationDuration: format, projectConversationTiming: project } = require(output);
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test("durations format subsecond, minute, hour and multiday totals", () => {
  assert.equal(format(undefined), "—");
  assert.equal(format(999), "0s");
  assert.equal(format(61000), "1m 1s");
  assert.equal(format(3661000), "1h 1m 1s");
  assert.equal(format(90061000), "1d 1h 1m");
});

test("live timing advances from receipt without depending on remote wall clock", () => {
  const sample = { created_at: 100, last_activity_at: 200, cumulative_ms: 5000, last_run_ms: 2000, active_runs: 1, sampled_at: 200, run_count: 2 };
  assert.deepEqual(project(sample, 3000), { cumulativeMs: 8000, lastRunMs: 5000, spanMs: 103000, lastActivity: 203000 });
  assert.deepEqual(project({ ...sample, active_runs: 0 }, 999999), { cumulativeMs: 5000, lastRunMs: 2000, spanMs: 100000, lastActivity: 200000 });
  assert.equal(project({ ...sample, active_runs: 2 }, 3000).cumulativeMs, 11000);
});

test("missing history stays unknown instead of inventing timing", () => {
  assert.deepEqual(project({ cumulative_ms: 0, active_runs: 0 }, 0), { cumulativeMs: 0, lastRunMs: undefined, spanMs: undefined, lastActivity: undefined });
});
