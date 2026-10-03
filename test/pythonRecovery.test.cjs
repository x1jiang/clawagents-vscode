const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const childProcess = require("node:child_process");
const { buildSync } = require("esbuild");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claw-python-recovery-"));
fs.mkdirSync(path.join(dir, "node_modules/vscode"), { recursive: true });
fs.writeFileSync(path.join(dir, "node_modules/vscode/index.js"),
  "module.exports = { workspace: {}, window: {}, env: {}, commands: {}, ConfigurationTarget: { Global: 1 } };");
buildSync({ entryPoints: [path.join(__dirname, "../src/config.ts")], outfile: path.join(dir, "config.cjs"), bundle: true, platform: "node", format: "cjs", external: ["vscode"], logLevel: "silent" });
const vscode = require(path.join(dir, "node_modules/vscode"));
const { selectPythonInterpreter } = require(path.join(dir, "config.cjs"));
const originalExecFile = childProcess.execFile;
test.after(() => {
  childProcess.execFile = originalExecFile;
  fs.rmSync(dir, { recursive: true, force: true });
});

function fixture(answer, version = "3.12.1", remote = false) {
  const calls = [];
  let input;
  vscode.env.remoteName = remote ? "ssh-remote" : undefined;
  vscode.workspace.getConfiguration = () => ({
    update: async (...args) => calls.push(["update", ...args]),
  });
  vscode.window.showInputBox = async (options) => { input = options; return answer; };
  vscode.window.showErrorMessage = async (message) => calls.push(["error", message]);
  childProcess.execFile = (executable, args, options, callback) => {
    calls.push(["probe", executable, args, options]);
    callback(version instanceof Error ? version : null, version instanceof Error ? "" : version, "");
    return {};
  };
  return { calls, input: () => input };
}

test("cancelled Python selection leaves host settings unchanged", async () => {
  const { calls } = fixture(undefined);
  assert.equal(await selectPythonInterpreter(), false);
  assert.deepEqual(calls, []);
});

test("valid selection preserves venv paths and saves only User/Remote settings", async () => {
  const python = path.join(dir, "venv with spaces", "bin", "python");
  fs.mkdirSync(path.dirname(python), { recursive: true });
  fs.writeFileSync(python, "");
  for (const remote of [false, true]) {
    const { calls, input } = fixture(`  ${python}  `, "3.12.1", remote);
    assert.equal(await selectPythonInterpreter(), true);
    assert.equal(calls[0][0], "probe");
    assert.equal(calls[0][1], python);
    assert.equal(calls[0][2][0], "-I");
    assert.ok(calls[0][3].timeout > 0);
    assert.deepEqual(calls[1], ["update", "pythonPath", python, 1]);
    assert.match(input().prompt, remote ? /remote/i : /this machine/i);
  }
});

test("missing, old, non-Python, and broken interpreters cannot replace the setting", async () => {
  const python = path.join(dir, "probe-python");
  fs.writeFileSync(python, "");
  for (const [answer, version] of [
    [path.join(dir, "missing"), "3.12.1"],
    [python, "3.9.9"], [python, "2.7.18"], [python, "not Python"],
    [python, new Error("spawn failed")], ["   ", "3.12.1"],
  ]) {
    const { calls } = fixture(answer, version);
    assert.equal(await selectPythonInterpreter(), false);
    assert.ok(!calls.some(([kind]) => kind === "update"));
  }
});

test("input validation reports an invalid Python before saving", async () => {
  const { input } = fixture(undefined);
  await selectPythonInterpreter();
  assert.match(await input().validateInput(path.join(dir, "missing")), /not found/);
  assert.match(await input().validateInput("   "), /Enter/);
});

const extensionBuild = require("esbuild").build({
  entryPoints: [path.join(__dirname, "../src/extension.ts")],
  outfile: path.join(dir, "extension.cjs"), bundle: true, platform: "node", format: "cjs",
  external: ["vscode"], logLevel: "silent",
  plugins: [{ name: "host-fixtures", setup(build) {
    build.onLoad({ filter: /src\/(config|sidecar|webviewProvider)\.ts$/ }, ({ path: source }) => {
      if (source.endsWith("/sidecar.ts")) return { contents: `
        export class SidecarManager { current = undefined; constructor() { global.__recoveryManager = this; } }
      `, loader: "ts" };
      if (source.endsWith("/webviewProvider.ts")) return { contents: `
        export class ClawAgentsWebviewProvider {
          busy = false; restarts = 0;
          constructor() { global.__recoveryProvider = this; }
          async requestSidecarSettingsRestart() { this.restarts++; }
        }
      `, loader: "ts" };
      return { contents: `
        export class ExtensionConfig {}
        export const setPreferredWorkspaceRoot = () => false;
        export const workspaceRoot = () => undefined;
        export const trackEditorFocus = () => {};
        export const buildProblemsContext = () => "";
        export const wrapCurrentFileRef = () => "";
        export const wrapSelectionBlock = () => "";
        export const workspaceRoots = () => [];
        export const isExternalGraphPath = () => false;
        export const selectPythonInterpreter = () => true;
      `, loader: "ts" };
    });
  } }],
});

test("Python settings changes retry a failed launch without a current sidecar handle", async () => {
  await extensionBuild;
  let onChange;
  const commands = new Map();
  vscode.env.appName = "Visual Studio Code";
  Object.assign(vscode.commands, {
    executeCommand: async () => {},
    registerCommand: (id, callback) => { commands.set(id, callback); return {}; },
  });
  vscode.workspace.getConfiguration = () => ({ get: (_key, fallback) => fallback });
  vscode.workspace.onDidChangeConfiguration = (callback) => { onChange = callback; return {}; };
  vscode.window.registerWebviewViewProvider = () => ({});
  vscode.window.showInformationMessage = async () => {};
  require(path.join(dir, "extension.cjs")).activate({
    secrets: {}, workspaceState: { get: () => undefined },
    extensionPath: dir, globalStorageUri: { fsPath: dir }, subscriptions: [],
  });
  try {
    assert.ok(commands.has("clawagents.selectPythonInterpreter"));
    const provider = global.__recoveryProvider;
    assert.equal(global.__recoveryManager.current, undefined);
    await onChange({ affectsConfiguration: (key) => key === "clawagents.pythonPath" });
    assert.equal(provider.restarts, 1);
    await onChange({ affectsConfiguration: () => false });
    assert.equal(provider.restarts, 1);
    await onChange({ affectsConfiguration: (key) => key === "clawagents.model" });
    assert.equal(provider.restarts, 1);
    await onChange({ affectsConfiguration: (key) => key === "clawagents.pythonRuntime" });
    assert.equal(provider.restarts, 2);
  } finally {
    delete global.__recoveryProvider;
    delete global.__recoveryManager;
  }
});

buildSync({ entryPoints: [path.join(__dirname, "../src/webviewProvider.ts")], outfile: path.join(dir, "provider.cjs"), bundle: true, platform: "node", format: "cjs", external: ["vscode"], logLevel: "silent" });
const { ClawAgentsWebviewProvider } = require(path.join(dir, "provider.cjs"));
buildSync({ entryPoints: [path.join(__dirname, "../src/protocol.ts")], outfile: path.join(dir, "protocol.cjs"), bundle: true, platform: "node", format: "cjs", logLevel: "silent" });
const { parseWebviewToHost } = require(path.join(dir, "protocol.cjs"));

test("error-banner actions dispatch recovery commands through the validated protocol", async () => {
  const calls = [];
  vscode.commands.executeCommand = async (command) => calls.push(command);
  const provider = Object.create(ClawAgentsWebviewProvider.prototype);
  for (const type of ["select_python", "install_python_deps"]) {
    const message = parseWebviewToHost({ type });
    assert.deepEqual(message, { type });
    await provider.handleMessage(message);
  }
  assert.deepEqual(calls, ["clawagents.selectPythonInterpreter", "clawagents.installPythonDeps"]);
});
