const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { buildSync } = require("esbuild");

const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawagents-diagnostics-redaction-"));
const outputFile = path.join(outputDir, "diagnosticsRedaction.cjs");
buildSync({
  entryPoints: [path.join(__dirname, "..", "webview", "src", "diagnosticsRedaction.ts")],
  outfile: outputFile,
  bundle: true,
  platform: "node",
  format: "cjs",
  logLevel: "silent",
});
const { redactDiagnosticText, redactDiagnosticValue } = require(outputFile);

test.after(() => fs.rmSync(outputDir, { recursive: true, force: true }));

test("redacts exact workspace paths and common user homes on every platform", () => {
  const workspace = "/Users/alice/work/clawagents";
  assert.equal(
    redactDiagnosticText(`workspace=${workspace}/python/app.py`, [workspace]),
    "workspace=<workspace>/python/app.py",
  );
  assert.equal(redactDiagnosticText("cache=/home/bob/.cache/tool", []), "cache=~/.cache/tool");
  assert.equal(
    redactDiagnosticText("cache=C:\\Users\\Carol\\AppData\\Local", []),
    "cache=~\\AppData\\Local",
  );
  assert.equal(
    redactDiagnosticText("cache=d:/users/Dave/AppData/Local", []),
    "cache=~/AppData/Local",
  );
});

test("redacts nested diagnostic payloads without changing non-string values", () => {
  assert.deepEqual(
    redactDiagnosticValue({ paths: ["/Users/alice/a", "/home/bob/b"], ok: true }, []),
    { paths: ["~/a", "~/b"], ok: true },
  );
});
