const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { buildSync } = require("esbuild");

const root = path.join(__dirname, "..");
const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawagents-exec-capture-"));
const outputFile = path.join(outputDir, "execCapture.cjs");
buildSync({
  entryPoints: [path.join(root, "src", "execCapture.ts")],
  outfile: outputFile,
  bundle: true,
  platform: "node",
  format: "cjs",
  logLevel: "silent",
});
const { execCapture } = require(outputFile);
const read = (name) => fs.readFileSync(path.join(root, "src", name), "utf8");

test.after(() => fs.rmSync(outputDir, { recursive: true, force: true }));

const node = process.execPath;

test("captures stdout, stderr and a zero exit", async () => {
  const r = await execCapture(node, ["-e", "console.log('out'); console.error('err')"]);
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), "out");
  assert.equal(r.stderr.trim(), "err");
  assert.equal(r.error, undefined);
});

test("reports a non-zero exit as status, not as a spawn error", async () => {
  const r = await execCapture(node, ["-e", "console.error('boom'); process.exit(3)"]);
  assert.equal(r.status, 3);
  assert.match(r.stderr, /boom/);
  assert.equal(r.error, undefined);
});

test("a missing binary resolves with ENOENT instead of rejecting", async () => {
  const r = await execCapture(path.join(outputDir, "no-such-binary"), ["--version"]);
  assert.equal(r.status, null);
  assert.equal(r.error.code, "ENOENT");
});

test("a hung process is cut off by the timeout", async () => {
  const started = Date.now();
  const r = await execCapture(node, ["-e", "setInterval(() => {}, 1000)"], { timeout: 300 });
  assert.ok(Date.now() - started < 5000);
  assert.equal(r.status, null);
  assert.ok(r.error);
});

test("the event loop keeps running while the child runs", async () => {
  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 10);
  await execCapture(node, ["-e", "setTimeout(() => {}, 300)"]);
  clearInterval(timer);
  assert.ok(ticks >= 5, `event loop was blocked (only ${ticks} ticks)`);
});

test("the sidecar start path uses the non-blocking probes", () => {
  const deps = read("pythonDeps.ts");
  const ensure = deps.slice(deps.indexOf("async function ensureSidecarDepsOnce"));
  assert.doesNotMatch(ensure, /probeSidecarDepsSync\(/);
  assert.equal((ensure.match(/await probeSidecarDeps\(/g) || []).length, 2);

  const companions = read("companionDeps.ts");
  const ensureCompanions = companions.slice(companions.indexOf("async function ensureContextMode"));
  assert.doesNotMatch(ensureCompanions, /whichSync\(|[^a-zA-Z]probe(ContextMode|Rtk|Graphify|Companions)\(/);

  const managed = read("managedPython.ts");
  const ensureManaged = managed.slice(managed.indexOf("export async function ensureManagedPython"));
  assert.match(ensureManaged, /await probePythonIdentityAsync\(basePython\)/);
  assert.doesNotMatch(ensureManaged, /spawnSync\(/);
  // Registration happens before the first await that follows the ownership check.
  const afterCheck = ensureManaged.slice(ensureManaged.indexOf("const existing = ensureInFlight.get(envDir)"));
  assert.ok(
    afterCheck.indexOf("const creating: Promise<string> = (async () => {")
      < afterCheck.indexOf("await managedPythonIsUsable(python)"),
  );
});
