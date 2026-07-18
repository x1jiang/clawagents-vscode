const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { buildSync } = require("esbuild");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawagents-autoopen-"));
const outputFile = path.join(tempDir, "autoOpenFiles.cjs");
buildSync({
  entryPoints: [path.join(__dirname, "..", "src", "autoOpenFiles.ts")],
  outfile: outputFile,
  bundle: true,
  platform: "node",
  format: "cjs",
  logLevel: "silent",
});
const mod = require(outputFile);
test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

test("looksLikeSecretPath blocks credentials", () => {
  assert.equal(mod.looksLikeSecretPath("/ws/.env"), true);
  assert.equal(mod.looksLikeSecretPath("/ws/id_rsa"), true);
  assert.equal(mod.looksLikeSecretPath("/ws/src/app.ts"), false);
});

test("pathHasDotDot rejects traversal", () => {
  assert.equal(mod.pathHasDotDot("../etc/passwd"), true);
  assert.equal(mod.pathHasDotDot("src/app.ts"), false);
});

test("AutoOpenScheduler skips secrets and opens latest safe path", async () => {
  const opened = [];
  const logs = [];
  const sched = new mod.AutoOpenScheduler(
    (p) => opened.push(p),
    (m) => logs.push(m),
    20,
  );
  sched.schedule("/ws/.env");
  sched.schedule("/ws/a.ts");
  sched.schedule("/ws/b.ts");
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(opened, ["/ws/b.ts"]);
  assert.ok(logs.some((m) => m.includes("skipped")));
  sched.dispose();
});
