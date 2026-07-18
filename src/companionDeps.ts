import { spawn, spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { curatedProcessEnv } from "./envCurate";
import { versionAtLeast } from "./pythonDeps";

/**
 * Floors must stay in lockstep with clawagents.companions
 * (MIN_CONTEXT_MODE / MIN_RTK in clawagents_py).
 */
export const MIN_CONTEXT_MODE_VERSION: [number, number, number] = [1, 0, 169];
export const MIN_RTK_VERSION: [number, number, number] = [0, 43, 0];

export type CompanionProbe = {
  name: "context-mode" | "rtk";
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

export function probeCompanions(): CompanionProbe[] {
  return [probeContextMode(), probeRtk()];
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

async function ensureContextMode(
  output: { appendLine(s: string): void },
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

export function ensureCompanionsEnabled(): boolean {
  return vscode.workspace.getConfiguration("clawagents").get<boolean>("ensureCompanions", true)
    !== false;
}

const ensureInFlight = new Map<string, Promise<CompanionProbe[]>>();

/** Probe and auto-upgrade companions when below floor. Non-fatal. */
export function ensureCompanions(
  output: { appendLine(s: string): void },
  options?: { force?: boolean },
): Promise<CompanionProbe[]> {
  const key = "global";
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

async function ensureCompanionsOnce(
  output: { appendLine(s: string): void },
  options?: { force?: boolean },
): Promise<CompanionProbe[]> {
  output.appendLine("=== Companion probe (context-mode, rtk) ===");
  const before = probeCompanions();
  for (const p of before) {
    output.appendLine(`  ${p.name}: ${p.detail}`);
  }

  const shouldEnsure = options?.force || ensureCompanionsEnabled();
  if (!shouldEnsure) {
    output.appendLine("ensureCompanions=false — skip auto-install");
    return before;
  }

  const results: CompanionProbe[] = [];
  if (!before[0]?.ok) {
    results.push(await ensureContextMode(output));
  } else {
    results.push(before[0]);
  }
  if (!before[1]?.ok) {
    results.push(await ensureRtk(output));
  } else {
    results.push(before[1]);
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
