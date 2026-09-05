"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { buildSync } = require("esbuild");

const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawagents-tool-presentation-"));
const outputFile = path.join(outputDir, "toolPresentation.cjs");
buildSync({
  entryPoints: [path.join(__dirname, "..", "webview", "src", "toolPresentation.ts")],
  outfile: outputFile,
  bundle: true,
  platform: "node",
  format: "cjs",
  logLevel: "silent",
});
const presentation = require(outputFile);

test.after(() => fs.rmSync(outputDir, { recursive: true, force: true }));

function done(name, args, durationMs = 100) {
  return { kind: "tool", id: name, name, args, status: "done", success: true, durationMs };
}

test("high-frequency tools receive concise English descriptions", () => {
  assert.deepEqual(
    presentation.presentTool(done("read_file", { path: "webview/src/App.tsx" })),
    { category: "read", title: "Read App.tsx", detail: "webview/src/App.tsx" },
  );
  assert.deepEqual(
    presentation.presentTool(done("ctx_search", { query: "tool_completed", path: "src" })),
    {
      category: "context",
      title: "Searched context for “tool_completed”",
      detail: "Scope: src",
    },
  );
});

test("unknown tools use a useful generic fallback", () => {
  assert.deepEqual(
    presentation.presentTool(done("mcp__custom__analyze_widget", { name: "sidebar" })),
    { category: "generic", title: "Ran Analyze Widget", detail: "sidebar" },
  );
});

test("a tool path collapses into one aggregate sentence", () => {
  const calls = [
    done("read_file", { path: "App.tsx" }),
    done("read_file", { path: "styles.css" }),
    done("exec_command", { cmd: "npm run typecheck" }),
  ];
  assert.equal(presentation.summarizeToolRun(calls, false), "Read files and ran a command");
});

test("durations stay compact from milliseconds through minutes", () => {
  assert.equal(presentation.formatToolDuration(183), "183ms");
  assert.equal(presentation.formatToolDuration(1_260), "1.3s");
  assert.equal(presentation.formatToolDuration(68_000), "1m 8s");
});
