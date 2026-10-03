const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { buildSync } = require("esbuild");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claw-no-folder-"));
const out = path.join(dir, "workspace.cjs");
buildSync({ entryPoints: [path.join(__dirname, "../src/sidecarWorkspace.ts")], outfile: out,
  bundle: true, platform: "node", format: "cjs", logLevel: "silent" });
const { resolveSidecarWorkspace } = require(out);
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

function fixture(name) {
  const root = path.join(dir, name);
  const storage = path.join(root, "globalStorage");
  const current = path.join(root, "extensions", "clawagents.clawagents-1.0.197");
  fs.mkdirSync(current, { recursive: true });
  return { root, storage, current };
}
function legacy(root, version, relative, content) {
  const file = path.join(root, "extensions", `clawagents.clawagents-${version}`, ".clawagents", relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

test("an open workspace keeps its own state and does not import no-folder history", () => {
  const f = fixture("open");
  assert.equal(resolveSidecarWorkspace("/selected/workspace", f.storage, f.current), "/selected/workspace");
  assert.equal(fs.existsSync(f.storage), false);
});

test("no-folder state survives extension upgrades and recovers retained chat history", () => {
  const f = fixture("upgrade");
  legacy(f.root, "1.0.195", "vscode-chats/chat_saved.json", '{"id":"chat_saved"}');
  legacy(f.root, "1.0.195", "sessions-memory/chat_saved.jsonl", "original history\n");
  legacy(f.root, "1.0.195", "vscode_settings.json", "older settings");
  legacy(f.root, "1.0.196", "vscode_settings.json", "latest settings");
  const cwd = resolveSidecarWorkspace(undefined, f.storage, f.current);
  assert.equal(cwd, path.join(f.storage, "no-folder-workspace"));
  assert.equal(fs.readFileSync(path.join(cwd, ".clawagents/vscode-chats/chat_saved.json"), "utf8"), '{"id":"chat_saved"}');
  assert.equal(fs.readFileSync(path.join(cwd, ".clawagents/sessions-memory/chat_saved.jsonl"), "utf8"), "original history\n");
  assert.equal(fs.readFileSync(path.join(cwd, ".clawagents/vscode_settings.json"), "utf8"), "latest settings");
  const next = path.join(f.root, "extensions", "clawagents.clawagents-1.0.198");
  fs.mkdirSync(next);
  assert.equal(resolveSidecarWorkspace(undefined, f.storage, next), cwd);
  assert.equal(fs.readFileSync(path.join(f.root, "extensions/clawagents.clawagents-1.0.195/.clawagents/sessions-memory/chat_saved.jsonl"), "utf8"), "original history\n");
});

test("migration neither overwrites current state nor resurrects deleted conversations", () => {
  const f = fixture("preserve");
  legacy(f.root, "1.0.196", "vscode-chats/chat_saved.json", "legacy");
  const file = path.join(f.storage, "no-folder-workspace/.clawagents/vscode-chats/chat_saved.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "current");
  resolveSidecarWorkspace(undefined, f.storage, f.current);
  assert.equal(fs.readFileSync(file, "utf8"), "current");
  fs.unlinkSync(file);
  resolveSidecarWorkspace(undefined, f.storage, f.current);
  assert.equal(fs.existsSync(file), false);
});

test("legacy migration skips symlinks and unrelated extensions", { skip: process.platform === "win32" }, () => {
  const f = fixture("symlink");
  const source = legacy(f.root, "1.0.196", "vscode-chats/chat_saved.json", "safe");
  const secret = path.join(f.root, "outside.json");
  fs.writeFileSync(secret, "outside");
  fs.symlinkSync(secret, path.join(path.dirname(source), "outside.json"));
  const other = path.join(f.root, "extensions/other.plugin-1.0.196/.clawagents/vscode-chats");
  fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(path.join(other, "other.json"), "unrelated");
  const cwd = resolveSidecarWorkspace(undefined, f.storage, f.current);
  assert.equal(fs.existsSync(path.join(cwd, ".clawagents/vscode-chats/outside.json")), false);
  assert.equal(fs.existsSync(path.join(cwd, ".clawagents/vscode-chats/other.json")), false);
});
