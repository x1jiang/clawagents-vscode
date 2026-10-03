const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { buildSync } = require("esbuild");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claw-python-host-"));
buildSync({ entryPoints: [path.join(__dirname, "../src/pythonInterpreter.ts")], outfile: path.join(dir, "python.cjs"), bundle: true, platform: "node", format: "cjs", logLevel: "silent" });
const python = require(path.join(dir, "python.cjs"));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

function interpreter(name, version) {
  const executable = path.join(dir, name);
  fs.writeFileSync(executable, `#!/bin/sh\nprintf '%s\\n' '${version}'\n`, { mode: 0o755 });
  return executable;
}
const posix = process.platform === "win32" ? "requires POSIX fixture interpreters" : false;

test("managed runtime recovers a missing host path and skips older PATH Python", { skip: posix }, async () => {
  const prior = process.env.PATH;
  const logs = [];
  interpreter("python3", "3.9.1");
  const compatible = interpreter("python3.11", "3.11.15");
  process.env.PATH = dir;
  try {
    assert.equal(await python.resolveSidecarBasePython("/missing/mac/python3", "managed", { appendLine: s => logs.push(s) }), compatible);
    assert.match(logs.join("\n"), /3\.9/);
    assert.match(logs.join("\n"), /discovered.*3\.11/i);
  } finally { process.env.PATH = prior; }
});

test("custom runtime never replaces a missing, old, or broken selection", { skip: posix }, async () => {
  for (const selected of [path.join(dir, "missing"), interpreter("old", "3.9.0"), interpreter("broken", "garbage")]) {
    await assert.rejects(python.resolveSidecarBasePython(selected, "custom", { appendLine() {} }), /not found|requires Python/);
  }
});

test("compatible explicit interpreter keeps its venv symlink and spaces", { skip: posix }, async () => {
  const target = interpreter("base", "3.10.17");
  const selected = path.join(dir, "venv with spaces", "bin", "python");
  fs.mkdirSync(path.dirname(selected), { recursive: true });
  fs.symlinkSync(target, selected);
  for (const mode of ["managed", "custom"]) {
    assert.equal(await python.resolveSidecarBasePython(selected, mode, { appendLine() {} }), selected);
  }
});

test("missing Python on a host has an actionable bounded failure", async () => {
  await assert.rejects(python.resolveSidecarBasePython(path.join(dir, "missing"), "managed", { appendLine() {} }, [path.parse(dir).root]), /No compatible Python.*Select Python Interpreter/);
});

test("discovery refuses workspace executables and relative PATH entries", { skip: posix }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claw-untrusted-python-"));
  const sentinel = path.join(root, "executed");
  fs.writeFileSync(path.join(root, "python3"), `#!/bin/sh\n/bin/touch '${sentinel}'\necho 3.12.1\n`, { mode: 0o755 });
  const prior = process.env.PATH;
  process.env.PATH = [".", root, dir].join(path.delimiter);
  try {
    const selected = await python.resolveSidecarBasePython(path.join(dir, "missing"), "managed", { appendLine() {} }, [root]);
    assert.notEqual(selected, path.join(root, "python3"));
    assert.notEqual(await python.resolveSidecarBasePython("python3", "managed", { appendLine() {} }, [root]), path.join(root, "python3"));
    await assert.rejects(python.resolveSidecarBasePython("python3", "custom", { appendLine() {} }, [root]), /inside a workspace/);
    assert.equal(fs.existsSync(sentinel), false);
    assert.ok(!python.pythonDiscoveryCandidates().some(candidate => !path.isAbsolute(candidate)));
  } finally { process.env.PATH = prior; fs.rmSync(root, { recursive: true, force: true }); }
});

test("discovery includes Homebrew, user-local, and Windows Python locations", () => {
  assert.ok(python.pythonDiscoveryCandidates("darwin", { PATH: "" }, "/Users/example").includes("/opt/homebrew/bin/python3"));
  assert.ok(python.pythonDiscoveryCandidates("linux", { PATH: "" }, "/home/example").includes("/home/example/.local/bin/python3"));
  const windows = python.pythonDiscoveryCandidates("win32", { PATH: "C:\\Python312", LOCALAPPDATA: "C:\\Users\\example\\AppData\\Local" }, "C:\\Users\\example");
  assert.ok(windows.includes("C:\\Python312\\python.exe"));
  assert.ok(windows.includes("C:\\Users\\example\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe"));
});

test("version probe times out hung executables and ignores inherited Python injection", { skip: posix, timeout: 10_000 }, async () => {
  const executable = path.join(dir, "hung");
  fs.writeFileSync(executable, "#!/bin/sh\nexec /bin/sleep 15\n", { mode: 0o755 });
  await assert.rejects(python.probePythonVersion(executable), /Python probe failed/);
  const envProbe = path.join(dir, "env-probe");
  fs.writeFileSync(envProbe, '#!/bin/sh\nif [ "$1" != "-I" ] || [ -n "$PYTHONPATH" ]; then exit 1; fi\necho 3.12.1\n', { mode: 0o755 });
  const prior = process.env.PYTHONPATH;
  process.env.PYTHONPATH = "/untrusted";
  try { assert.equal(await python.probePythonVersion(envProbe), "3.12.1"); }
  finally { if (prior === undefined) delete process.env.PYTHONPATH; else process.env.PYTHONPATH = prior; }
});
