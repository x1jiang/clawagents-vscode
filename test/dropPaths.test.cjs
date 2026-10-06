const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { buildSync } = require("esbuild");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawagents-drop-"));
const out = path.join(dir, "dropPaths.cjs");
buildSync({ entryPoints: [path.join(__dirname, "../webview/src/dropPaths.ts")], outfile: out, bundle: true, platform: "node", format: "cjs", logLevel: "silent" });
const { collectDropUris, hasVsCodeUriPayload } = require(out);
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
function transfer(payload, files = []) {
  return { types: Object.keys(payload), files, getData: (type) => payload[type] || "" };
}
test("Explorer JSON directories and files survive MIME casing changes", () => {
  const data = transfer({ RESOURCEURLS: JSON.stringify(["vscode-remote://ssh-remote+host/workspace/src", "vscode-remote://ssh-remote+host/workspace/src/a.ts"]) });
  assert.equal(hasVsCodeUriPayload(data), true);
  assert.deepEqual(collectDropUris(data), ["vscode-remote://ssh-remote+host/workspace/src", "vscode-remote://ssh-remote+host/workspace/src/a.ts"]);
});
test("OS URI lists preserve folder paths alongside browser file objects", () => {
  const data = transfer({ "text/uri-list": "# comment\r\nfile:///workspace/my%20folder\r\nfile:///workspace/a.ts" }, [{ name: "my folder" }]);
  assert.deepEqual(collectDropUris(data), ["file:///workspace/my%20folder", "file:///workspace/a.ts"]);
});
test("plain path drops preserve spaces and Windows paths", () => {
  assert.deepEqual(collectDropUris(transfer({ "text/plain": "/workspace/my folder\nC:\\project\\src" })), ["/workspace/my folder", "C:\\project\\src"]);
});
test("legacy Electron file paths are available without URI payloads", () => {
  assert.deepEqual(collectDropUris(transfer({}, [{ name: "src", path: "/workspace/src" }])), ["/workspace/src"]);
  assert.deepEqual(collectDropUris(transfer({}, [{ name: "src" }])), []);
});
test("duplicate URI representations collapse and web links are excluded", () => {
  assert.deepEqual(collectDropUris(transfer({ "application/vnd.code.uri-list": "file:///workspace/src", "text/uri-list": "file:///workspace/src\nhttps://example.com" })), ["file:///workspace/src"]);
});
