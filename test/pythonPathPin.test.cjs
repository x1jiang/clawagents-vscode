const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { buildSync } = require("esbuild");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claw-pin-"));
fs.mkdirSync(path.join(dir, "node_modules/vscode"), { recursive: true });
fs.writeFileSync(path.join(dir, "node_modules/vscode/index.js"), "module.exports = {};");
buildSync({ entryPoints: [path.join(__dirname, "../src/pythonPathPin.ts")], outfile: path.join(dir, "pin.cjs"), bundle: true, platform: "node", format: "cjs", external: ["vscode"], logLevel: "silent" });
const { pinPythonPathEnv } = require(path.join(dir, "pin.cjs"));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("pinPythonPathEnv", () => {
  it("preserves the venv directory when its interpreter is a symlink", () => {
    const base = path.join(dir, "system");
    const venv = path.join(dir, "venv with spaces");
    fs.mkdirSync(base);
    fs.mkdirSync(path.join(venv, "bin"), { recursive: true });
    fs.writeFileSync(path.join(base, "python3"), "");
    fs.writeFileSync(path.join(venv, "pyvenv.cfg"), "home = " + base);
    const python = path.join(venv, "bin/python");
    fs.symlinkSync(path.join(base, "python3"), python);
    const prior = { PATH: [base, path.dirname(python), base].join(path.delimiter), VIRTUAL_ENV: "/stale", KEEP: "yes" };
    const env = pinPythonPathEnv(python, prior);
    assert.equal(env.PATH.split(path.delimiter)[0], path.dirname(python));
    assert.equal(env.PATH.split(path.delimiter).filter(p => p === path.dirname(python)).length, 1);
    assert.equal(env.CLAWAGENTS_PYTHON, python);
    assert.equal(env.VIRTUAL_ENV, venv);
    assert.equal(env.KEEP, "yes");
    assert.equal(prior.VIRTUAL_ENV, "/stale");
  });
  it("clears a stale virtualenv when selecting a non-venv interpreter", () => {
    const python = path.join(dir, "python");
    fs.writeFileSync(python, "");
    assert.equal(pinPythonPathEnv(python, { PATH: "", VIRTUAL_ENV: "/old" }).VIRTUAL_ENV, undefined);
  });
  it("leaves PATH alone for an unresolved bare command", () => {
    const env = pinPythonPathEnv("python3", { PATH: "/custom/bin" });
    assert.equal(env.PATH, "/custom/bin");
    assert.equal(env.CLAWAGENTS_PYTHON, "python3");
  });
});
