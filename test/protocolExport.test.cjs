const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

test("webview vscodeApi re-exports host protocol types", () => {
  const apiPath = path.join(__dirname, "..", "webview", "src", "vscodeApi.ts");
  const src = fs.readFileSync(apiPath, "utf8");
  assert.match(src, /from ["']\.\.\/\.\.\/src\/protocol["']/);
  assert.match(src, /export type \{/);
  assert.match(src, /HostToWebview/);
  assert.match(src, /WebviewToHost/);
  // Must not redefine duplicate message unions locally.
  assert.doesNotMatch(src, /export type HostToWebview\s*=/);
});
