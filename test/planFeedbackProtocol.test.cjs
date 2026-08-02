// Plan feedback is untrusted webview input that becomes part of the next LLM
// round, so it is bounded at the boundary rather than trimmed downstream.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { buildSync } = require("esbuild");

const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawagents-plan-protocol-"));
const outputFile = path.join(outputDir, "protocol.cjs");
buildSync({
  entryPoints: [path.join(__dirname, "..", "src", "protocol.ts")],
  outfile: outputFile,
  bundle: true,
  platform: "node",
  format: "cjs",
  logLevel: "silent",
});
const { parseWebviewToHost, PLAN_FEEDBACK_MAX_CHARS } = require(outputFile);

const REQUEST_ID = "9d65aec3ae224c28";

test.after(() => fs.rmSync(outputDir, { recursive: true, force: true }));

test("every decision is accepted", () => {
  for (const decision of ["approve", "request_changes", "reject"]) {
    const message = { type: "plan_approval", requestId: REQUEST_ID, decision };
    assert.deepEqual(parseWebviewToHost(message), message);
  }
});

test("an unknown decision is rejected", () => {
  for (const decision of ["allow", "", undefined, "APPROVE"]) {
    assert.equal(
      parseWebviewToHost({ type: "plan_approval", requestId: REQUEST_ID, decision }),
      undefined,
      `expected rejection for ${JSON.stringify(decision)}`,
    );
  }
});

test("request ids that could escape the sidecar URL path are rejected", () => {
  // The id becomes a path segment: POST /plan_approvals/{requestId}.
  for (const requestId of ["../../etc/passwd", "a/b", "a\\b", "..", "", "has space"]) {
    assert.equal(
      parseWebviewToHost({
        type: "plan_approval",
        requestId,
        decision: "approve",
      }),
      undefined,
      `expected rejection for ${JSON.stringify(requestId)}`,
    );
  }
});

test("feedback is carried through and bounded", () => {
  assert.ok(PLAN_FEEDBACK_MAX_CHARS > 0);

  const withFeedback = {
    type: "plan_approval",
    requestId: REQUEST_ID,
    decision: "request_changes",
    comment: "Use the existing .venv; confirm the cohort count first.",
  };
  assert.deepEqual(parseWebviewToHost(withFeedback), withFeedback);

  const atCap = {
    type: "plan_approval",
    requestId: REQUEST_ID,
    decision: "request_changes",
    comment: "x".repeat(PLAN_FEEDBACK_MAX_CHARS),
  };
  assert.deepEqual(parseWebviewToHost(atCap), atCap);

  // An oversized paste would crowd the plan itself out of the next round.
  assert.equal(
    parseWebviewToHost({
      type: "plan_approval",
      requestId: REQUEST_ID,
      decision: "request_changes",
      comment: "x".repeat(PLAN_FEEDBACK_MAX_CHARS + 1),
    }),
    undefined,
  );
  assert.equal(
    parseWebviewToHost({
      type: "plan_approval",
      requestId: REQUEST_ID,
      decision: "request_changes",
      comment: 42,
    }),
    undefined,
  );
});

test("approve and reject may carry a note too", () => {
  // The plumbing surfaces it as a host comment, so it must validate the same.
  for (const decision of ["approve", "reject"]) {
    const message = {
      type: "plan_approval",
      requestId: REQUEST_ID,
      decision,
      comment: "note",
    };
    assert.deepEqual(parseWebviewToHost(message), message);
  }
});
