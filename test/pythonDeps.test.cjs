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

test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

test("dependency versions stay inside the supported major ranges", () => {
  assert.equal(
    deps.needsPipInstall({
      ok: true,
      version: "6.17.7",
      supportsSkillsExclude: true,
    }),
    false,
  );
  assert.equal(
    deps.needsPipInstall({
      ok: true,
      version: "6.17.6",
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
    deps.SIDECAR_PIP_PACKAGES.some((spec) => spec.includes("clawagents") && spec.includes("6.17.7")),
  );
  assert.ok(!deps.SIDECAR_PIP_PACKAGES.some((spec) => spec.includes("atlas")));
});

test("concurrent dependency checks share one in-flight promise", async () => {
  const fakePython = path.join(tempDir, "fake-python");
  fs.writeFileSync(
    fakePython,
    "#!/bin/sh\nprintf '/fake/python\\n6.17.7\\nTrue\\n'\n",
    { mode: 0o755 },
  );
  const output = { appendLine() {} };
  const first = deps.ensureSidecarDeps(fakePython, output, {});
  const second = deps.ensureSidecarDeps(fakePython, output, {});
  assert.strictEqual(first, second);
  assert.equal((await first).ok, true);
});
