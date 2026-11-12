const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { buildSync } = require("esbuild");

const root = path.join(__dirname, "..");
const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawagents-sidecar-lifecycle-"));
const outputFile = path.join(outputDir, "processTermination.cjs");
buildSync({
  entryPoints: [path.join(root, "src", "processTermination.ts")],
  outfile: outputFile,
  bundle: true,
  platform: "node",
  format: "cjs",
  logLevel: "silent",
});
const { terminateProcess } = require(outputFile);
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), "utf8");
const provider = read("src", "webviewProvider.ts");
const sidecar = read("src", "sidecar.ts");
const extension = read("src", "extension.ts");
const bridge = read("python", "bridge.py");

test.after(() => fs.rmSync(outputDir, { recursive: true, force: true }));

function section(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(from, -1, `missing ${start}`);
  assert.notEqual(to, -1, `missing ${end}`);
  return source.slice(from, to);
}

function child(script) {
  const proc = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "ignore"] });
  const ready = new Promise((resolve) => proc.stdout.once("data", resolve));
  return { proc, ready };
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("terminateProcess resolves once a cooperative child has exited", async () => {
  const { proc, ready } = child("console.log('up'); setInterval(() => {}, 1000);");
  await ready;
  const started = Date.now();
  await terminateProcess(proc, 2000);
  assert.ok(Date.now() - started < 1500, "must not wait out the grace period");
  assert.equal(alive(proc.pid), false);
});

test("terminateProcess escalates to SIGKILL when SIGTERM is ignored", { skip: process.platform === "win32" }, async () => {
  const { proc, ready } = child(
    "process.on('SIGTERM', () => {}); console.log('up'); setInterval(() => {}, 1000);",
  );
  await ready;
  const started = Date.now();
  await terminateProcess(proc, 200);
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 150 && elapsed < 2500, `unexpected wait ${elapsed}ms`);
  assert.equal(alive(proc.pid), false);
  assert.equal(proc.signalCode, "SIGKILL");
});

test("terminateProcess is a no-op for a process that already exited", async () => {
  const { proc } = child("console.log('bye')");
  await new Promise((resolve) => proc.once("exit", resolve));
  await terminateProcess(proc, 5000);
});

test("deactivation waits for the sidecar process to exit", () => {
  assert.match(extension, /export async function deactivate\(\): Promise<void>/);
  assert.match(extension, /await manager\.shutdown\(\)/);
  const shutdown = section(sidecar, "async shutdown(): Promise<void>", "dispose(): void");
  assert.match(shutdown, /await this\.stopChild\(\)/);
});

test("the sidecar gets a liveness pipe and the watchdog flag", () => {
  assert.match(sidecar, /stdio: \["pipe", "pipe", "pipe"\]/);
  assert.match(sidecar, /CLAW_PARENT_WATCHDOG: "1"/);
  assert.match(sidecar, /this\.child\.stdin\?\.on\("error"/);
  assert.match(bridge, /start_parent_watchdog\(\)/);
  assert.match(bridge, /timeout_graceful_shutdown=3/);
});

test("a start is registered before the restart cooldown is awaited", () => {
  const ensure = section(sidecar, "async ensureStarted()", "private assertCurrentStart");
  const assigned = ensure.indexOf("this.starting = tracked");
  assert.notEqual(assigned, -1);
  // The only await before registration is the health ping of a live handle.
  const beforeRegistration = ensure.slice(ensure.indexOf("if (this.starting)"), assigned);
  const topLevelAwaits = beforeRegistration
    .replace(/tracked = \(async \(\) => \{[\s\S]*?\}\)\(\)/, "")
    .match(/\bawait\b/g);
  assert.equal(topLevelAwaits, null);
});

test("busy covers turns that outlived their stream", () => {
  const busy = section(provider, "get busy(): boolean", "private currentTurnSettings");
  assert.match(busy, /this\.runs\.hasActiveRuns/);
  assert.match(busy, /this\.detachedChatPollers\?\.size/);
});

test("credential changes never restart the sidecar under a running turn", () => {
  const apply = section(provider, "private async applyCredentialChange()", "async restartSidecarInteractive");
  assert.ok(apply.indexOf("if (this.busy)") < apply.indexOf("this.sidecar.stop()"));
  assert.match(apply, /this\.pendingSidecarSettings = true/);

  // The only direct stops left are the two guarded restart helpers.
  assert.equal((provider.match(/this\.sidecar\.stop\(\)/g) || []).length, 2);
  assert.equal((provider.match(/await this\.applyCredentialChange\(\)/g) || []).length, 5);
  assert.doesNotMatch(extension, /sidecar\?\.stop\(\)/);
});

test("an explicit restart asks first when a turn is running", () => {
  const interactive = section(provider, "async restartSidecarInteractive()", "async restartSidecar(): Promise<void>");
  assert.match(interactive, /if \(this\.busy\)/);
  assert.match(interactive, /modal: true/);
  assert.match(provider, /case "restart_sidecar":\s+await this\.restartSidecarInteractive\(\)/);
  assert.match(extension, /"clawagents\.restartSidecar", async \(\) => \{\s+await provider\?\.restartSidecarInteractive\(\)/);
});

test("a deferred restart is applied when a detached run ends", () => {
  const poller = section(provider, "private watchDetachedChatRun(", "private async loadOlderChatEvents");
  assert.equal((poller.match(/applyPendingSidecarSettings\(\)/g) || []).length, 2);
});
