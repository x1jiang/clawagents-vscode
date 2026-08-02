// Webview requests are untrusted input: a job id becomes a URL path segment on
// the sidecar, and pinned text is injected into every LLM round. Both need to
// be rejected at the boundary rather than sanitised downstream.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { buildSync } = require("esbuild");

const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawagents-jobs-protocol-"));
const outputFile = path.join(outputDir, "protocol.cjs");
buildSync({
  entryPoints: [path.join(__dirname, "..", "src", "protocol.ts")],
  outfile: outputFile,
  bundle: true,
  platform: "node",
  format: "cjs",
  logLevel: "silent",
});
const { parseWebviewToHost, PINNED_CONTEXT_MAX_CHARS } = require(outputFile);

test.after(() => fs.rmSync(outputDir, { recursive: true, force: true }));

test("job listing and pinned loading need no payload", () => {
  for (const type of ["list_jobs", "load_pinned"]) {
    assert.deepEqual(parseWebviewToHost({ type }), { type });
  }
});

test("job actions accept an opaque job id", () => {
  for (const type of ["job_output", "stop_job", "report_job"]) {
    const message = { type, jobId: "9d65aec3ae224c28" };
    assert.deepEqual(parseWebviewToHost(message), message);
  }
});

test("job ids that could escape the sidecar URL path are rejected", () => {
  for (const jobId of ["../../etc/passwd", "a/b", "a\\b", "..", "", "has space"]) {
    assert.equal(
      parseWebviewToHost({ type: "stop_job", jobId }),
      undefined,
      `expected rejection for ${JSON.stringify(jobId)}`,
    );
  }
  assert.equal(parseWebviewToHost({ type: "stop_job" }), undefined);
});

test("pinned context is accepted up to its cap and refused beyond it", () => {
  assert.ok(PINNED_CONTEXT_MAX_CHARS > 0);
  const atCap = { type: "save_pinned", text: "x".repeat(PINNED_CONTEXT_MAX_CHARS) };
  assert.deepEqual(parseWebviewToHost(atCap), atCap);

  // This text rides every request, so an oversized paste must not get through.
  assert.equal(
    parseWebviewToHost({ type: "save_pinned", text: "x".repeat(PINNED_CONTEXT_MAX_CHARS + 1) }),
    undefined,
  );
  assert.equal(parseWebviewToHost({ type: "save_pinned", text: 42 }), undefined);
  assert.equal(parseWebviewToHost({ type: "save_pinned" }), undefined);
});

test("clearing pinned context is a valid save", () => {
  const message = { type: "save_pinned", text: "" };
  assert.deepEqual(parseWebviewToHost(message), message);
});
