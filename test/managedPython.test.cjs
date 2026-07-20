const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { buildSync } = require("esbuild");

const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawagents-managed-python-"));
const outputFile = path.join(outputDir, "managedPython.cjs");
buildSync({
  entryPoints: [path.join(__dirname, "..", "src", "managedPython.ts")],
  outfile: outputFile,
  bundle: true,
  platform: "node",
  format: "cjs",
  logLevel: "silent",
  external: ["vscode"],
});
const managed = require(outputFile);

test.after(() => fs.rmSync(outputDir, { recursive: true, force: true }));

test("managed environment is isolated by base interpreter identity", () => {
  const a = managed.managedPythonEnvDir("/state", "/usr/bin/python3", "3.12");
  const b = managed.managedPythonEnvDir("/state", "/opt/python3", "3.12");
  assert.notEqual(a, b);
  assert.equal(path.dirname(a), path.join("/state", "python-envs"));
  assert.match(path.basename(a), /^py-3\.12-[a-f0-9]{12}$/);
});

test("managed interpreter path is platform-correct", () => {
  assert.equal(
    managed.managedPythonExecutable("/state/env", "win32"),
    path.join("/state/env", "Scripts", "python.exe"),
  );
  assert.equal(
    managed.managedPythonExecutable("/state/env", "darwin"),
    path.join("/state/env", "bin", "python"),
  );
});

test("python identity parsing fails closed", () => {
  assert.deepEqual(managed.parsePythonIdentity("/usr/bin/python3\n3.12\n"), {
    executable: "/usr/bin/python3",
    majorMinor: "3.12",
  });
  assert.equal(managed.parsePythonIdentity("garbage"), undefined);
  assert.equal(managed.parsePythonIdentity("/usr/bin/python3\n3.x\n"), undefined);
});

test("creates and reuses an isolated virtual environment", { timeout: 30_000 }, async () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "clawagents-managed-state-"));
  try {
    const output = { appendLine() {} };
    const first = await managed.ensureManagedPython("python3", state, output);
    const second = await managed.ensureManagedPython("python3", state, output);
    assert.equal(first, second);
    assert.equal(fs.existsSync(first), true);
    assert.match(first, /python-envs/);
  } finally {
    fs.rmSync(state, { recursive: true, force: true });
  }
});

test("concurrent starts share one managed environment creation", { timeout: 30_000 }, async () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "clawagents-managed-race-"));
  try {
    const output = { appendLine() {} };
    const [first, second] = await Promise.all([
      managed.ensureManagedPython("python3", state, output),
      managed.ensureManagedPython("python3", state, output),
    ]);
    assert.equal(first, second);
    assert.equal(fs.existsSync(first), true);
  } finally {
    fs.rmSync(state, { recursive: true, force: true });
  }
});
