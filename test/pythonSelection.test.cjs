const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { buildSync } = require("esbuild");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claw-selection-"));
fs.mkdirSync(path.join(dir, "node_modules/vscode"), { recursive: true });
fs.writeFileSync(path.join(dir, "node_modules/vscode/index.js"), `module.exports = {
 workspace: { getConfiguration: () => ({ inspect: () => global.__pythonSetting }) },
 window: { showWarningMessage: () => Promise.resolve() }
};`);
buildSync({ entryPoints: [path.join(__dirname, "../src/config.ts")], outfile: path.join(dir, "config.cjs"), bundle: true, platform: "node", format: "cjs", external: ["vscode"], logLevel: "silent" });
const { resolvePythonExecutable, trustedPythonPathSetting } = require(path.join(dir, "config.cjs"));
test.after(() => { delete global.__pythonSetting; fs.rmSync(dir, { recursive: true, force: true }); });
test("missing explicit interpreter never falls back to system Python", () => {
 const missing = path.join(dir, "missing/bin/python");
 assert.throws(() => resolvePythonExecutable(missing), /Python interpreter.*not found/);
});
test("missing named interpreter never falls back to another command", () => {
 assert.throws(() => resolvePythonExecutable("clawagents-python-does-not-exist"), /Python interpreter.*not found/);
});
test("configured symlink path is preserved", () => {
 const target = path.join(dir, "base"); fs.writeFileSync(target, "");
 const link = path.join(dir, "python"); fs.symlinkSync(target, link);
 assert.equal(resolvePythonExecutable(link), link);
});
test("User or Remote selection wins over workspace selection", () => {
 global.__pythonSetting = { globalValue: "/selected/bin/python", workspaceValue: "/untrusted/python" };
 assert.equal(trustedPythonPathSetting(), "/selected/bin/python");
});
test("workspace absolute paths remain untrusted", () => {
 global.__pythonSetting = { workspaceValue: "/untrusted/python", defaultValue: "python3" };
 assert.equal(trustedPythonPathSetting(), "python3");
});

buildSync({ entryPoints: [path.join(__dirname, "../src/webviewProvider.ts")], outfile: path.join(dir, "provider.cjs"), bundle: true, platform: "node", format: "cjs", external: ["vscode"], logLevel: "silent" });
const { ClawAgentsWebviewProvider } = require(path.join(dir, "provider.cjs"));
test("settings changed during a run restart once when idle", async () => {
 const provider = Object.create(ClawAgentsWebviewProvider.prototype);
 provider.runs = { hasActiveRuns: true };
 let restarts = 0;
 provider.restartSidecar = async () => { restarts++; };
 await provider.requestSidecarSettingsRestart();
 await provider.requestSidecarSettingsRestart();
 assert.equal(restarts, 0);
 provider.runs.hasActiveRuns = false;
 await Promise.all([provider.applyPendingSidecarSettings(), provider.applyPendingSidecarSettings()]);
 assert.equal(restarts, 1);
 await provider.applyPendingSidecarSettings();
 assert.equal(restarts, 1);
});
