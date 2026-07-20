import { spawn, spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { curatedProcessEnv } from "./envCurate";
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

function whichSync(bin: string): string | undefined {
  const cmd = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(cmd, [bin], {
    encoding: "utf8",
    timeout: 5_000,
    env: process.env,
  });
  if (result.status !== 0) {
    return undefined;
  }
  const line = (result.stdout || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find(Boolean);
  return line || undefined;
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
  const bin = whichSync("context-mode");
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

export function probeRtk(): CompanionProbe {
  const bin = process.env.CLAW_RTK_BIN || whichSync("rtk");
  if (!bin) {
    return {
      name: "rtk",
      found: false,
      ok: false,
      detail: "missing — brew install rtk (https://www.rtk-ai.app/)",
    };
  }
  const result = spawnSync(bin, ["--version"], {
    encoding: "utf8",
    timeout: 10_000,
    env: process.env,
  });
  const text = `${result.stdout || ""}\n${result.stderr || ""}`;
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

export function probeGraphify(python?: string): CompanionProbe {
  const py =
    python ||
    vscode.workspace.getConfiguration("clawagents").get<string>("pythonPath") ||
    "python3";
  const result = spawnSync(
    py,
    [
      "-c",
      "import importlib.metadata as m; print(m.version('graphifyy'))",
    ],
    {
      encoding: "utf8",
      timeout: 15_000,
      env: process.env,
    },
  );
  if (result.status !== 0) {
    const floor = MIN_GRAPHIFY_VERSION.join(".");
    return {
      name: "graphify",
      found: false,
      ok: false,
      path: py,
      detail: `missing — pip install '${GRAPHIFY_PIP_SPEC}' (need >=${floor})`,
    };
  }
  const version = (result.stdout || "").trim().split(/\r?\n/).find(Boolean);
  const ok = versionAtLeast(version, MIN_GRAPHIFY_VERSION);
  const floor = MIN_GRAPHIFY_VERSION.join(".");
  return {
    name: "graphify",
    found: true,
    version,
    path: py,
    ok,
    detail: ok
      ? `${version || "?"} >= ${floor}`
      : `have ${version || "?"}, need >=${floor} — pip install -U '${GRAPHIFY_PIP_SPEC}'`,
  };
}

export function probeCompanions(python?: string): CompanionProbe[] {
  return [probeContextMode(), probeRtk(), probeGraphify(python)];
}

function runCommand(
  command: string,
  args: string[],
  output: { appendLine(s: string): void },
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
      shell: process.platform === "win32",
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
  let probe = probeContextMode();
  if (probe.ok) {
    return probe;
  }
  const npm = whichSync("npm");
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
    async () => runCommand(npm, ["install", "-g", "context-mode@latest"], output),
  );
  if (!result.ok) {
    output.appendLine(`context-mode install failed: ${result.detail}`);
    return probeContextMode();
  }
  probe = probeContextMode();
  output.appendLine(`context-mode after ensure: ${probe.detail}`);
  return probe;
}

async function ensureRtk(
  output: { appendLine(s: string): void },
  options?: { force?: boolean },
): Promise<CompanionProbe> {
  let probe = probeRtk();
  if (probe.ok) {
    return probe;
  }
  const brew = whichSync("brew");
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
    return probeRtk();
  }
  probe = probeRtk();
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
    vscode.workspace.getConfiguration("clawagents").get<string>("pythonPath") ||
    "python3";
  let probe = probeGraphify(python);
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
  if (!result.ok) {
    output.appendLine(`graphify install failed: ${result.detail}`);
    return probeGraphify(python);
  }
  probe = probeGraphify(python);
  output.appendLine(`graphify after ensure: ${probe.detail}`);
  return probe;
}

async function ensureCompanionsOnce(
  output: { appendLine(s: string): void },
  options?: { force?: boolean; python?: string },
): Promise<CompanionProbe[]> {
  const python =
    options?.python ||
    vscode.workspace.getConfiguration("clawagents").get<string>("pythonPath") ||
    undefined;
  output.appendLine("=== Companion probe (context-mode, rtk, graphify) ===");
  const before = probeCompanions(python);
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
