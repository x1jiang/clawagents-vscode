const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { buildSync } = require("esbuild");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawagents-python-deps-"));
const outputFile = path.join(tempDir, "pythonDeps.cjs");
const vscodeStubDir = path.join(tempDir, "node_modules", "vscode");
fs.mkdirSync(vscodeStubDir, { recursive: true });
fs.writeFileSync(path.join(vscodeStubDir, "index.js"), `module.exports = {
  ProgressLocation: { Notification: 1 },
  window: {
    withProgress: (_opts, task) => task({ report() {} }),
    showInformationMessage() {},
  },
  workspace: {
    getConfiguration() {
      return { get: (_key, def) => def };
    },
  },
};`);
buildSync({
  entryPoints: [path.join(__dirname, "..", "src", "pythonDeps.ts")],
  outfile: outputFile,
  bundle: true,
  platform: "node",
  format: "cjs",
  logLevel: "silent",
  external: ["vscode"],
});

const deps = require(outputFile);
const floor = deps.MIN_CLAWAGENTS_VERSION_STR;

test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

test("dependency versions stay inside the supported major ranges", () => {
  assert.equal(
    deps.needsPipInstall({
      ok: true,
      version: floor,
      supportsSkillsExclude: true,
    }),
    false,
  );
  // One patch below the floor must upgrade.
  const [maj, min, pat] = deps.MIN_CLAWAGENTS_VERSION;
  const below = `${maj}.${min}.${Math.max(0, pat - 1)}`;
  assert.equal(
    deps.needsPipInstall({
      ok: true,
      version: below,
      supportsSkillsExclude: true,
    }),
    true,
  );
  assert.equal(
    deps.needsPipInstall({
      ok: true,
      version: "7.0.0",
      supportsSkillsExclude: true,
    }),
    true,
  );
  assert.ok(
    deps.SIDECAR_PIP_PACKAGES.filter((spec) => !spec.includes("git+"))
      .every((spec) => spec.includes("<")),
  );
  assert.ok(
    deps.SIDECAR_PIP_PACKAGES.some(
      (spec) => spec.includes("clawagents") && spec.includes(floor),
    ),
  );
  const clawagentsSpec = deps.SIDECAR_PIP_PACKAGES.find((spec) =>
    spec.startsWith("clawagents["),
  );
  assert.match(clawagentsSpec, /\[[^\]]*\bpty\b[^\]]*\]/);
  assert.ok(
    deps.SIDECAR_PIP_PACKAGES_GITHUB_FALLBACK.some((spec) =>
      spec.startsWith("pexpect>=4.8"),
    ),
  );
  assert.ok(
    deps.SIDECAR_PIP_PACKAGES_GITHUB_FALLBACK.some((spec) =>
      spec.startsWith("pyte>=0.8"),
    ),
  );
  assert.ok(!deps.SIDECAR_PIP_PACKAGES.some((spec) => spec.includes("atlas")));
  assert.match(
    deps.CLAWAGENTS_GITHUB_WHEEL,
    new RegExp(`clawagents-${floor.replace(/\./g, "\\.")}-py3-none-any\\.whl$`),
  );
  assert.ok(
    deps.SIDECAR_PIP_PACKAGES_GITHUB_FALLBACK.includes(deps.CLAWAGENTS_GITHUB_WHEEL),
  );
});

test("dependency probe requires PTY runtime imports", () => {
  const fakePython = path.join(tempDir, "python-without-pty");
  fs.writeFileSync(
    fakePython,
    `#!/bin/sh
case "$*" in
  *"import pexpect, pyte"*)
    printf 'ModuleNotFoundError: No module named pexpect\\n' >&2
    exit 1
    ;;
esac
exit 0
`,
    { mode: 0o755 },
  );
  const probe = deps.probeSidecarDepsSync(fakePython, {});
  assert.equal(probe.ok, false);
  assert.equal(deps.needsPipInstall(probe), true);
  assert.match(probe.detail, /ModuleNotFoundError/);
});

test("concurrent dependency checks share one in-flight promise", async () => {
  const fakePython = path.join(tempDir, "fake-python");
  fs.writeFileSync(
    fakePython,
    `#!/bin/sh\nprintf '/fake/python\\n${floor}\\nTrue\\n'\n`,
    { mode: 0o755 },
  );
  const output = { appendLine() {} };
  const first = deps.ensureSidecarDeps(fakePython, output, {}, { syncPathFloor: false });
  const second = deps.ensureSidecarDeps(fakePython, output, {}, { syncPathFloor: false });
  assert.strictEqual(first, second);
  assert.equal((await first).ok, true);
});
