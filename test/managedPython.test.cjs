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

test("recognises Debian's missing-ensurepip venv failure", () => {
  assert.equal(
    managed.looksLikeMissingEnsurepip(
      "The virtual environment was not created successfully because ensurepip is not available.",
    ),
    true,
  );
  assert.equal(managed.looksLikeMissingEnsurepip("apt install python3.10-venv"), true);
  assert.equal(managed.looksLikeMissingEnsurepip("No module named 'ensurepip'"), true);
  // Unrelated failures must keep bubbling up instead of triggering fallbacks.
  assert.equal(managed.looksLikeMissingEnsurepip("Permission denied: /state"), false);
  assert.equal(managed.looksLikeMissingEnsurepip("No space left on device"), false);
});

test("pip bootstrap refuses non-HTTPS and off-PyPA hosts", () => {
  assert.equal(
    managed.assertTrustedBootstrapUrl("https://bootstrap.pypa.io/pip/get-pip.py").hostname,
    "bootstrap.pypa.io",
  );
  assert.throws(
    () => managed.assertTrustedBootstrapUrl("http://bootstrap.pypa.io/pip/get-pip.py"),
    /non-HTTPS/,
  );
  assert.throws(
    () => managed.assertTrustedBootstrapUrl("https://evil.example/get-pip.py"),
    /untrusted host/,
  );
  // Lookalike hosts must not pass a substring check.
  assert.throws(
    () => managed.assertTrustedBootstrapUrl("https://bootstrap.pypa.io.evil.example/x.py"),
    /untrusted host/,
  );
});

test("pip bootstrap rejects captive-portal and truncated responses", () => {
  const realish = `#!/usr/bin/env python\nimport sys\ndef main():\n    pass\n`.padEnd(2048, "#");
  assert.equal(managed.looksLikePythonScript(realish), true);
  assert.equal(
    managed.looksLikePythonScript("<!DOCTYPE html><html><body>Sign in</body></html>".padEnd(2048, " ")),
    false,
  );
  assert.equal(managed.looksLikePythonScript("import sys\ndef main(): pass"), false); // too short
  assert.equal(managed.looksLikePythonScript(""), false);
});

test("pip --python support is gated on pip 22.3+", () => {
  assert.deepEqual(managed.parsePipVersion("pip 24.0 from /usr/lib (python 3.11)"), [24, 0]);
  assert.deepEqual(managed.parsePipVersion("pip 22.3.1 from /usr/lib (python 3.10)"), [22, 3]);
  assert.equal(managed.parsePipVersion("not pip output"), undefined);
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

const REAL_PYTHON = (() => {
  try {
    return require("node:child_process")
      .execFileSync("sh", ["-c", "command -v python3"], { encoding: "utf8" })
      .trim();
  } catch {
    return "";
  }
})();

/**
 * Stand-in for a Debian python whose stdlib `venv` cannot seed pip. The real
 * interpreter is baked in as an absolute path so the shim keeps working when a
 * test blanks PATH to hide uv.
 */
function writeEnsurepiplessPython(dir, opts = {}) {
  const shim = path.join(dir, `python3-shim-${Math.random().toString(36).slice(2, 8)}`);
  const venvGuard = opts.blockAllVenv
    ? 'if [ "$1" = "-m" ] && [ "$2" = "venv" ]; then'
    : 'if [ "$1" = "-m" ] && [ "$2" = "venv" ] && [ "$3" != "--without-pip" ]; then';
  fs.writeFileSync(
    shim,
    [
      "#!/bin/sh",
      `REAL="${REAL_PYTHON}"`,
      `SELF="${shim}"`,
      'if [ "$1" = "-c" ]; then',
      '  case "$2" in',
      "    *sys.executable*)",
      '      echo "$SELF"',
      `      "$REAL" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")'`,
      "      exit 0",
      "      ;;",
      ...(opts.blockVirtualenv ? ["    *virtualenv*) exit 1 ;;"] : []),
      "  esac",
      '  exec "$REAL" "$@"',
      "fi",
      venvGuard,
      "  echo 'The virtual environment was not created successfully because ensurepip is not available.' >&2",
      "  exit 1",
      "fi",
      'exec "$REAL" "$@"',
    ].join("\n"),
    { mode: 0o755 },
  );
  return shim;
}

const posixOnly = process.platform === "win32" || !REAL_PYTHON
  ? "needs POSIX sh and python3"
  : false;

/** Blank PATH so `uv` can never be picked up; the shim uses an absolute python. */
function withoutPathTools(state, fn) {
  const originalPath = process.env.PATH;
  const empty = path.join(state, "empty-bin");
  fs.mkdirSync(empty, { recursive: true });
  process.env.PATH = empty;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      process.env.PATH = originalPath;
      managed.clearManagedPythonFailures();
    });
}

test(
  "falls back to a pip-carrying builder when ensurepip is missing",
  { timeout: 120_000, skip: posixOnly },
  async () => {
    const state = fs.mkdtempSync(path.join(os.tmpdir(), "clawagents-noensurepip-"));
    try {
      const shim = writeEnsurepiplessPython(state);
      if (!managed.pipCanTargetOtherInterpreter(REAL_PYTHON)) {
        return; // Host has no pip 22.3+; the local-only fallback cannot apply.
      }
      const lines = [];
      await withoutPathTools(state, async () => {
        // No confirmNetworkBootstrap: this must succeed entirely offline.
        const python = await managed.ensureManagedPython(shim, state, {
          appendLine: (s) => lines.push(s),
        });
        assert.equal(fs.existsSync(python), true);
      });
      const log = lines.join("\n");
      assert.match(log, /ensurepip/);
      // Must be the local pip --python builder, not a get-pip.py download.
      assert.match(
        log,
        /Managed Python environment created via python -m venv --without-pip \+ pip --python/,
      );
      assert.doesNotMatch(log, /Downloading https/);
    } finally {
      fs.rmSync(state, { recursive: true, force: true });
    }
  },
);

test(
  "surfaces an actionable remedy when every builder fails",
  { timeout: 60_000, skip: posixOnly },
  async () => {
    const state = fs.mkdtempSync(path.join(os.tmpdir(), "clawagents-noremedy-"));
    try {
      // No venv at all and no virtualenv: every builder fails before any download.
      const shim = writeEnsurepiplessPython(state, {
        blockAllVenv: true,
        blockVirtualenv: true,
      });
      await withoutPathTools(state, () =>
        assert.rejects(managed.ensureManagedPython(shim, state, { appendLine() {} }), (err) => {
          assert.match(err.message, /ensurepip is not available/);
          assert.match(err.message, /-venv/);
          assert.match(err.message, /virtualenv/);
          assert.match(err.message, /clawagents\.pythonRuntime/);
          return true;
        }),
      );
    } finally {
      fs.rmSync(state, { recursive: true, force: true });
    }
  },
);

test(
  "the network pip bootstrap never runs without consent",
  { timeout: 60_000, skip: posixOnly },
  async () => {
    const state = fs.mkdtempSync(path.join(os.tmpdir(), "clawagents-consent-"));
    try {
      const shim = writeEnsurepiplessPython(state, {
        blockAllVenv: true,
        blockVirtualenv: true,
      });
      const lines = [];
      const record = { appendLine: (s) => lines.push(s) };

      // No callback supplied: the builder must be skipped, not silently run.
      await withoutPathTools(state, () =>
        assert.rejects(managed.ensureManagedPython(shim, state, record)),
      );
      assert.match(lines.join("\n"), /Skipping python -m venv --without-pip \+ get-pip\.py/);

      // Callback supplied but declining: still no download.
      let asked = 0;
      await withoutPathTools(state, () =>
        assert.rejects(
          managed.ensureManagedPython(shim, state, record, {
            confirmNetworkBootstrap: async () => {
              asked += 1;
              return false;
            },
          }),
        ),
      );
      assert.equal(asked, 1);
      assert.doesNotMatch(lines.join("\n"), /Downloading https/);
    } finally {
      fs.rmSync(state, { recursive: true, force: true });
    }
  },
);

test(
  "a failed environment is not rebuilt on every call",
  { timeout: 60_000, skip: posixOnly },
  async () => {
    const state = fs.mkdtempSync(path.join(os.tmpdir(), "clawagents-failcache-"));
    try {
      const shim = writeEnsurepiplessPython(state, {
        blockAllVenv: true,
        blockVirtualenv: true,
      });
      const attempts = [];
      const record = { appendLine: (s) => attempts.push(s) };
      await withoutPathTools(state, async () => {
        await assert.rejects(managed.ensureManagedPython(shim, state, record));
        const afterFirst = attempts.length;
        assert.ok(afterFirst > 0, "first attempt should do real work");

        // Second call replays the cached error without rebuilding.
        await assert.rejects(managed.ensureManagedPython(shim, state, record));
        assert.equal(attempts.length, afterFirst);

        // An explicit restart clears the cache and lets the work run again.
        managed.clearManagedPythonFailures();
        await assert.rejects(managed.ensureManagedPython(shim, state, record));
        assert.ok(attempts.length > afterFirst);
      });
    } finally {
      fs.rmSync(state, { recursive: true, force: true });
    }
  },
);

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
