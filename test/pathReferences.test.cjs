const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { buildSync } = require("esbuild");

const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawagents-path-references-"));
const outputFile = path.join(outputDir, "pathReferences.cjs");
buildSync({
  entryPoints: [path.join(__dirname, "..", "src", "pathReferences.ts")],
  outfile: outputFile,
  bundle: true,
  platform: "node",
  format: "cjs",
  logLevel: "silent",
});
const {
  isBareFileName,
  isWorkspaceSearchCandidate,
  parseInlinePathReference,
} = require(outputFile);

test.after(() => fs.rmSync(outputDir, { recursive: true, force: true }));

test("parses inline file and directory references", () => {
  assert.deepEqual(parseInlinePathReference("report.md"), { path: "report.md" });
  assert.deepEqual(parseInlinePathReference("src/report.ts:42"), { path: "src/report.ts", line: 42 });
  assert.deepEqual(parseInlinePathReference("src/report.ts#L17C3"), { path: "src/report.ts", line: 17 });
  assert.deepEqual(parseInlinePathReference("/workspace/src/report.ts:9"), {
    path: "/workspace/src/report.ts",
    line: 9,
  });
  assert.deepEqual(parseInlinePathReference("visual\\_assitant/src/main.jsx"), {
    path: "visual_assitant/src/main.jsx",
  });
  assert.deepEqual(parseInlinePathReference("traumatic_injury/gemini-outputs/"), {
    path: "traumatic_injury/gemini-outputs",
  });
});

test("does not turn prose, URLs, or unsafe values into path references", () => {
  for (const value of ["diagnosis-validation scripts", "https://example.com/a.py", "#heading", "--flag", "../secret.txt"]) {
    assert.equal(parseInlinePathReference(value), undefined);
  }
  assert.equal(isBareFileName("report.md"), true);
  assert.equal(isBareFileName("not a file"), false);
  assert.equal(isWorkspaceSearchCandidate("src/main.jsx"), true);
  assert.equal(isWorkspaceSearchCandidate(".clawagents/snapshots/1/src/main.jsx"), false);
});
