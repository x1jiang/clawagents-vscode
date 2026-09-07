const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const app = fs.readFileSync(path.join(root, "webview", "src", "App.tsx"), "utf8");
const panel = fs.readFileSync(
  path.join(root, "webview", "src", "DiagnosticsPanel.tsx"),
  "utf8",
);
const styles = fs.readFileSync(path.join(root, "webview", "src", "styles.css"), "utf8");

test("diagnostics is a troubleshooting subpage instead of a primary tab", () => {
  assert.match(app, /\["chat", "history", "settings"\] as Panel\[\]/);
  assert.match(app, /id="settings-troubleshooting"/);
  assert.match(app, /href="#settings-troubleshooting"/);
  assert.match(app, />\s*Open system diagnostics\s*</);
  assert.match(panel, />\s*← Settings\s*</);
});

test("diagnostics presents summaries while keeping raw data behind disclosure", () => {
  assert.match(panel, /System is ready/);
  assert.match(panel, /className="diagnostics-grid"/);
  assert.match(panel, /Advanced diagnostic data/);
  assert.match(panel, /Workspace paths are redacted/);
  assert.match(styles, /\.diagnostics-summary\.ok/);
});

test("support reports keep raw data behind the redaction boundary", () => {
  assert.match(panel, /redactDiagnosticText/);
  assert.match(panel, /redactDiagnosticValue/);
  assert.match(panel, /local_stats: stats/);
  assert.match(panel, /: "Copy report"/);
});
