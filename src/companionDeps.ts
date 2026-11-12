import { spawn, spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { trustedPythonPathSetting } from "./config";
import { curatedProcessEnv } from "./envCurate";
import { execCapture } from "./execCapture";
import { versionAtLeast } from "./pythonDeps";

/**
 * Floors must stay in lockstep with clawagents.companions
 * (MIN_CONTEXT_MODE / MIN_RTK / MIN_GRAPHIFY in clawagents_py).
 */
export const MIN_CONTEXT_MODE_VERSION: [number, number, number] = [1, 0, 169];
export const MIN_RTK_VERSION: [number, number, number] = [0, 43, 0];
export const MIN_GRAPHIFY_VERSION: [number, number, number] = [0, 9, 20];
export const GRAPHIFY_PIP_SPEC = "graphifyy[mcp]>=0.9.20";

export type CompanionProbe = {
  name: "context-mode" | "rtk" | "graphify";
  found: boolean;
  version?: string;
  path?: string;
  ok: boolean;
  detail: string;
};

function parseVersion(text: string | undefined): [number, number, number] | undefined {
  if (!text) {
    return undefined;
  }
  const m = text.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) {
    return undefined;
  }
  return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];
}

const WHICH_CMD = process.platform === "win32" ? "where" : "which";

function firstLine(status: number | null, stdout: string): string | undefined {
  if (status !== 0) {
    return undefined;
  }
  return (
    (stdout || "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find(Boolean) || undefined
  );
}

function whichSync(bin: string): string | undefined {
  const result = spawnSync(WHICH_CMD, [bin], {
    encoding: "utf8",
    timeout: 5_000,
    env: process.env,
  });
  return firstLine(result.status, result.stdout || "");
}

async function which(bin: string): Promise<string | undefined> {
  const result = await execCapture(WHICH_CMD, [bin], { timeout: 5_000, env: process.env });
  return firstLine(result.status, result.stdout);
}

function walkPackageJson(start: string, maxUp = 8): string | undefined {
  let cur = fs.existsSync(start) && fs.statSync(start).isDirectory()
    ? start
    : path.dirname(start);
  for (let i = 0; i < maxUp; i++) {
    const candidate = path.join(cur, "package.json");
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    const parent = path.dirname(cur);
    if (parent === cur) {
      break;
    }
    cur = parent;
  }
  return undefined;
}

export function probeContextMode(): CompanionProbe {
  return describeContextMode(whichSync("context-mode"));
}

export async function probeContextModeAsync(): Promise<CompanionProbe> {
  return describeContextMode(await which("context-mode"));
}

function describeContextMode(bin: string | undefined): CompanionProbe {
  if (!bin) {
    return {
      name: "context-mode",
      found: false,
      ok: false,
      detail: "missing — npm install -g context-mode@latest",
    };
  }
  let version: string | undefined;
  try {
    const resolved = fs.realpathSync(bin);
    const pkgPath = walkPackageJson(resolved);
    if (pkgPath) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { version?: string };
      if (typeof pkg.version === "string") {
        version = pkg.version;
      }
    }
  } catch {
    /* fall through */
  }
  const ok = versionAtLeast(version, MIN_CONTEXT_MODE_VERSION);
  const floor = MIN_CONTEXT_MODE_VERSION.join(".");
  return {
    name: "context-mode",
    found: true,
    version,
    path: bin,
    ok,
    detail: ok
      ? `${version || "?"} >= ${floor}`
      : `have ${version || "?"}, need >=${floor} — npm install -g context-mode@latest`,
  };
}

const RTK_MISSING: CompanionProbe = {
  name: "rtk",
  found: false,
  ok: false,
  detail: "missing — brew install rtk (https://www.rtk-ai.app/)",
};

export function probeRtk(): CompanionProbe {
  const bin = process.env.CLAW_RTK_BIN || whichSync("rtk");
  if (!bin) {
    return { ...RTK_MISSING };
  }
  const result = spawnSync(bin, ["--version"], {
    encoding: "utf8",
    timeout: 10_000,
    env: process.env,
  });
  return describeRtk(bin, `${result.stdout || ""}\n${result.stderr || ""}`);
}

export async function probeRtkAsync(): Promise<CompanionProbe> {
  const bin = process.env.CLAW_RTK_BIN || (await which("rtk"));
  if (!bin) {
    return { ...RTK_MISSING };
  }
  const result = await execCapture(bin, ["--version"], { timeout: 10_000, env: process.env });
  return describeRtk(bin, `${result.stdout}\n${result.stderr}`);
}

function describeRtk(bin: string, text: string): CompanionProbe {
  const parsed = parseVersion(text);
  const version = parsed ? parsed.join(".") : undefined;
  const ok = versionAtLeast(version, MIN_RTK_VERSION);
  const floor = MIN_RTK_VERSION.join(".");
  return {
    name: "rtk",
    found: true,
    version,
    path: bin,
    ok,
    detail: ok
      ? `${version || "?"} >= ${floor}`
      : `have ${version || "?"}, need >=${floor} — brew upgrade rtk`,
  };
}

/**
 * Short-lived probe cache.
 *
 * `probeGraphify` is a **synchronous** 15s-timeout subprocess and
 * `getGraphifyStatus` calls it on the extension host (UI thread) on every
 * status refresh — opening Settings, finishing a build, each webview poll.
 * The installed version cannot change without going through this module, so
 * an install invalidates the entry and everything else reuses it.
 */
const GRAPHIFY_PROBE_TTL_MS = 30_000;
const graphifyProbeCache = new Map<string, { at: number; probe: CompanionProbe }>();

/** Drop cached probes after an install/upgrade changes what is on disk. */
export function invalidateGraphifyProbe(): void {
  graphifyProbeCache.clear();
}

function cacheGraphifyProbe(py: string, probe: CompanionProbe): CompanionProbe {
  graphifyProbeCache.set(py, { at: Date.now(), probe });
  return probe;
}

export function probeGraphify(python?: string): CompanionProbe {
  const py =
    python ||
    // Never the merged setting: a repo's .vscode/settings.json could point
    // pythonPath at a binary inside the workspace, and this value is executed.
    trustedPythonPathSetting();
  const cached = graphifyProbeCache.get(py);
  if (cached && Date.now() - cached.at < GRAPHIFY_PROBE_TTL_MS) {
    return cached.probe;
  }
  const result = spawnSync(py, ["-c", GRAPHIFY_PROBE_SCRIPT], {
    encoding: "utf8",
    timeout: 15_000,
    env: process.env,
  });
  return describeGraphify(py, result.status, result.stdout || "");
}

/** Non-blocking probe; fills the same cache the blocking one reads. */
export async function probeGraphifyAsync(python?: string): Promise<CompanionProbe> {
  const py = python || trustedPythonPathSetting();
  const cached = graphifyProbeCache.get(py);
  if (cached && Date.now() - cached.at < GRAPHIFY_PROBE_TTL_MS) {
    return cached.probe;
  }
  const result = await execCapture(py, ["-c", GRAPHIFY_PROBE_SCRIPT], {
    timeout: 15_000,
    env: process.env,
  });
  return describeGraphify(py, result.status, result.stdout);
}

const GRAPHIFY_PROBE_SCRIPT = "import importlib.metadata as m; print(m.version('graphifyy'))";

function describeGraphify(py: string, status: number | null, stdout: string): CompanionProbe {
  if (status !== 0) {
    const floor = MIN_GRAPHIFY_VERSION.join(".");
    return cacheGraphifyProbe(py, {
      name: "graphify",
      found: false,
      ok: false,
      path: py,
      detail: `missing — pip install '${GRAPHIFY_PIP_SPEC}' (need >=${floor})`,
    });
  }
  const version = (stdout || "").trim().split(/\r?\n/).find(Boolean);
  const ok = versionAtLeast(version, MIN_GRAPHIFY_VERSION);
  const floor = MIN_GRAPHIFY_VERSION.join(".");
  return cacheGraphifyProbe(py, {
    name: "graphify",
    found: true,
    version,
    path: py,
    ok,
    detail: ok
      ? `${version || "?"} >= ${floor}`
      : `have ${version || "?"}, need >=${floor} — pip install -U '${GRAPHIFY_PIP_SPEC}'`,
  });
}

export function probeCompanions(python?: string): CompanionProbe[] {
  return [probeContextMode(), probeRtk(), probeGraphify(python)];
}

/** Non-blocking, and the three probes run concurrently. */
export function probeCompanionsAsync(python?: string): Promise<CompanionProbe[]> {
  return Promise.all([probeContextModeAsync(), probeRtkAsync(), probeGraphifyAsync(python)]);
}

/**
 * @param useShell Opt-in, Windows-only. `spawn(..., {shell:true})` joins argv
 *   with spaces and no quoting, so cmd.exe reinterprets shell metacharacters:
 *   `graphifyy[mcp]>=0.9.20` becomes a redirect that silently drops the version
 *   floor, swallows all subprocess output into a stray `=0.9.20` file, and
 *   writes it into the extension-host cwd. Only pass this for bare command
 *   names that genuinely need PATHEXT resolution (`npm` -> `npm.cmd`); anything
 *   spawned by absolute path must leave it off.
 */
function runCommand(
  command: string,
  args: string[],
  output: { appendLine(s: string): void },
  useShell = false,
): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    output.appendLine(`Running: ${command} ${args.join(" ")}`);
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...curatedProcessEnv(),
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        USERPROFILE: process.env.USERPROFILE,
        TMPDIR: process.env.TMPDIR,
        TMP: process.env.TMP,
        TEMP: process.env.TEMP,
        npm_config_yes: "true",
      },
      shell: useShell && process.platform === "win32",
    });
    let log = "";
    const onData = (buf: Buffer) => {
      const t = buf.toString();
      log += t;
      for (const line of t.split(/\r?\n/)) {
        if (line.trim()) {
          output.appendLine(line);
        }
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (err) => {
      resolve({ ok: false, detail: err.message });
    });
    child.on("exit", (code) => {
      if (code === 0) {
        resolve({ ok: true, detail: log.slice(-2000) });
        return;
      }
      resolve({ ok: false, detail: `exit ${code}\n${log.slice(-2000)}` });
    });
  });
}

async function confirmGlobalInstall(detail: string): Promise<boolean> {
  const choice = await vscode.window.showWarningMessage(
    detail,
    { modal: true },
    "Install",
    "Skip",
  );
  return choice === "Install";
}

async function ensureContextMode(
  output: { appendLine(s: string): void },
  options?: { force?: boolean },
): Promise<CompanionProbe> {
  let probe = await probeContextModeAsync();
  if (probe.ok) {
    return probe;
  }
  const npm = await which("npm");
  if (!npm) {
    output.appendLine("context-mode: npm not found — skip auto-install");
    return probe;
  }
  // Never mutate the global npm prefix without consent (startup used to install silently).
  const ok = options?.force
    ? true
    : await confirmGlobalInstall(
        "ClawAgents wants to run `npm install -g context-mode@latest` (global). Continue?",
      );
  if (!ok) {
    output.appendLine("context-mode: install skipped (user declined or probe-only)");
    return probe;
  }
  const result = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "ClawAgents: installing context-mode…",
      cancellable: false,
    },
    // `npm` is a bare name resolved via PATHEXT to npm.cmd on Windows.
    async () => runCommand(npm, ["install", "-g", "context-mode@latest"], output, true),
  );
  if (!result.ok) {
    output.appendLine(`context-mode install failed: ${result.detail}`);
    return probeContextModeAsync();
  }
  probe = await probeContextModeAsync();
  output.appendLine(`context-mode after ensure: ${probe.detail}`);
  return probe;
}

async function ensureRtk(
  output: { appendLine(s: string): void },
  options?: { force?: boolean },
): Promise<CompanionProbe> {
  let probe = await probeRtkAsync();
  if (probe.ok) {
    return probe;
  }
  const brew = await which("brew");
  if (!brew) {
    output.appendLine(
      "rtk: Homebrew not found — install manually from https://www.rtk-ai.app/",
    );
    return probe;
  }
  const args = probe.found
    ? ["upgrade", "rtk"]
    : ["install", "rtk"];
  const ok = options?.force
    ? true
    : await confirmGlobalInstall(
        `ClawAgents wants to run \`brew ${args.join(" ")}\` (Homebrew). Continue?`,
      );
  if (!ok) {
    output.appendLine("rtk: install skipped (user declined or probe-only)");
    return probe;
  }
  const result = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: probe.found ? "ClawAgents: upgrading rtk…" : "ClawAgents: installing rtk…",
      cancellable: false,
    },
    async () => runCommand(brew, args, output),
  );
  if (!result.ok) {
    output.appendLine(`rtk brew failed: ${result.detail}`);
    return probeRtkAsync();
  }
  probe = await probeRtkAsync();
  output.appendLine(`rtk after ensure: ${probe.detail}`);
  return probe;
}

/** Default false — startup probes only; Install via Ensure Companions or opt-in setting. */
export function ensureCompanionsEnabled(): boolean {
  return vscode.workspace.getConfiguration("clawagents").get<boolean>("ensureCompanions", false)
    === true;
}

const ensureInFlight = new Map<string, Promise<CompanionProbe[]>>();

/** Probe and auto-upgrade companions when below floor. Non-fatal. */
export function ensureCompanions(
  output: { appendLine(s: string): void },
  options?: { force?: boolean; python?: string },
): Promise<CompanionProbe[]> {
  const key = options?.python ? `py:${options.python}` : "global";
  const existing = ensureInFlight.get(key);
  if (existing && !options?.force) {
    return existing;
  }
  const run = ensureCompanionsOnce(output, options).finally(() => {
    if (ensureInFlight.get(key) === run) {
      ensureInFlight.delete(key);
    }
  });
  ensureInFlight.set(key, run);
  return run;
}

async function ensureGraphify(
  output: { appendLine(s: string): void },
  options?: { force?: boolean; python?: string },
): Promise<CompanionProbe> {
  const python =
    options?.python ||
    trustedPythonPathSetting();
  let probe = await probeGraphifyAsync(python);
  if (probe.ok) {
    return probe;
  }
  const ok = options?.force
    ? true
    : await confirmGlobalInstall(
        `ClawAgents wants to run \`${python} -m pip install -U '${GRAPHIFY_PIP_SPEC}'\` into the sidecar interpreter (not a global npm install). Continue?`,
      );
  if (!ok) {
    output.appendLine("graphify: install skipped (user declined or probe-only)");
    return probe;
  }
  const result = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "ClawAgents: installing graphifyy into sidecar Python…",
      cancellable: false,
    },
    async () =>
      runCommand(python, ["-m", "pip", "install", "-U", GRAPHIFY_PIP_SPEC], output),
  );
  // What is on disk just changed — a stale cached probe would report the
  // pre-install version (or "missing") for the rest of the TTL.
  invalidateGraphifyProbe();
  if (!result.ok) {
    output.appendLine(`graphify install failed: ${result.detail}`);
    return probeGraphifyAsync(python);
  }
  probe = await probeGraphifyAsync(python);
  output.appendLine(`graphify after ensure: ${probe.detail}`);
  return probe;
}

async function ensureCompanionsOnce(
  output: { appendLine(s: string): void },
  options?: { force?: boolean; python?: string },
): Promise<CompanionProbe[]> {
  const python =
    options?.python ||
    trustedPythonPathSetting();
  output.appendLine("=== Companion probe (context-mode, rtk, graphify) ===");
  const before = await probeCompanionsAsync(python);
  for (const p of before) {
    output.appendLine(`  ${p.name}: ${p.detail}`);
  }

  const shouldEnsure = options?.force || ensureCompanionsEnabled();
  if (!shouldEnsure) {
    output.appendLine("ensureCompanions=false — skip auto-install");
    return before;
  }

  const results: CompanionProbe[] = [];
  const byName = Object.fromEntries(before.map((p) => [p.name, p])) as Record<
    string,
    CompanionProbe
  >;
  if (!byName["context-mode"]?.ok) {
    results.push(await ensureContextMode(output, options));
  } else {
    results.push(byName["context-mode"]);
  }
  if (!byName.rtk?.ok) {
    results.push(await ensureRtk(output, options));
  } else {
    results.push(byName.rtk);
  }
  if (!byName.graphify?.ok) {
    results.push(await ensureGraphify(output, { ...options, python }));
  } else {
    results.push(byName.graphify);
  }

  const allOk = results.every((r) => r.ok);
  if (allOk) {
    output.appendLine("Companions OK");
  } else {
    output.appendLine(
      "Companions incomplete — chat still works; run ClawAgents: Ensure Companions or install manually.",
    );
  }
  return results;
}
