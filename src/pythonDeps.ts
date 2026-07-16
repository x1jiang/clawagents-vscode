import { spawn, spawnSync } from "child_process";
import * as vscode from "vscode";
import { curatedProcessEnv } from "./envCurate";

/** Packages installed into clawagents.pythonPath on first run / when missing. */
export const SIDECAR_PIP_PACKAGES = [
  // Keep in lockstep with python/requirements.txt and MIN_CLAWAGENTS_VERSION:
  // 6.17.9: multi-interpreter doctor + PATH drift detection.
  "clawagents[gemini,anthropic,bedrock,mcp]>=6.17.9,<7",
  "fastapi>=0.115.0,<1",
  "uvicorn>=0.30.0,<1",
  "pydantic>=2.7.0,<3",
  "python-dotenv>=1.0.0,<2",
] as const;

/** Minimum clawagents version required by this extension host. */
export const MIN_CLAWAGENTS_VERSION: [number, number, number] = [6, 17, 9];
export const MAX_CLAWAGENTS_VERSION: [number, number, number] = [7, 0, 0];

export type DepProbe = {
  ok: boolean;
  executable?: string;
  version?: string;
  supportsSkillsExclude?: boolean;
  detail: string;
};

export function versionAtLeast(
  version: string | undefined,
  min: [number, number, number],
): boolean {
  if (!version || version === "?") {
    return false;
  }
  // Keep segment positions aligned: strip a non-numeric prefix per segment
  // ("v6" → 6) and map the rest of an unparseable segment to 0 instead of
  // filtering it out (filtering shifted e.g. "v6.12.1" to [12, 1]).
  const parts = version
    .split(/[.+-]/)
    .map((p) => parseInt(p.replace(/^[^\d]*/, ""), 10))
    .map((n) => (Number.isNaN(n) ? 0 : n));
  for (let i = 0; i < 3; i++) {
    const a = parts[i] ?? 0;
    const b = min[i];
    if (a > b) {
      return true;
    }
    if (a < b) {
      return false;
    }
  }
  return true;
}

export function probeSidecarDepsSync(
  python: string,
  env?: NodeJS.ProcessEnv,
): DepProbe {
  try {
    const result = spawnSync(
      python,
      [
        "-c",
        [
          "import sys, inspect",
          "import fastapi, uvicorn, pydantic",
          "import clawagents",
          "from clawagents.agent import create_claw_agent",
          "print(sys.executable)",
          "print(getattr(clawagents, '__version__', '?'))",
          "print('skills_exclude' in inspect.signature(create_claw_agent).parameters)",
        ].join("; "),
      ],
      { encoding: "utf8", timeout: 25_000, env },
    );
    if (result.error) {
      const err = result.error as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        return {
          ok: false,
          detail:
            `Python not found: "${python}". Set clawagents.pythonPath to the full interpreter path.`,
        };
      }
      return { ok: false, detail: String(result.error) };
    }
    if (result.status !== 0) {
      return {
        ok: false,
        detail: (result.stderr || result.stdout || `exit ${result.status}`).trim(),
      };
    }
    const lines = (result.stdout || "")
      .trim()
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    return {
      ok: true,
      executable: lines[0],
      version: lines[1],
      supportsSkillsExclude: lines[2] === "True",
      detail: lines.join("\n"),
    };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

export function needsPipInstall(probe: DepProbe): boolean {
  return (
    !probe.ok ||
    probe.supportsSkillsExclude === false ||
    !versionAtLeast(probe.version, MIN_CLAWAGENTS_VERSION) ||
    versionAtLeast(probe.version, MAX_CLAWAGENTS_VERSION)
  );
}

export async function installSidecarDeps(
  python: string,
  output: { appendLine(s: string): void },
  options?: { forceUser?: boolean },
): Promise<{ ok: boolean; detail: string }> {
  const args = ["-m", "pip", "install", "-U", ...SIDECAR_PIP_PACKAGES];
  if (options?.forceUser) {
    args.splice(3, 0, "--user");
  }

  output.appendLine(`Running: ${python} ${args.join(" ")}`);

  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "ClawAgents: installing Python packages…",
      cancellable: false,
    },
    async (progress) => {
      progress.report({ message: "pip install (may take a minute on first run)" });
      return await new Promise<{ ok: boolean; detail: string }>((resolve) => {
        const child = spawn(python, args, {
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...curatedProcessEnv(),
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            USERPROFILE: process.env.USERPROFILE,
            TMPDIR: process.env.TMPDIR,
            TMP: process.env.TMP,
            TEMP: process.env.TEMP,
          },
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
          resolve({
            ok: false,
            detail: `pip exited ${code}\n${log.slice(-2000)}`,
          });
        });
      });
    },
  );
}

/** Ensure deps exist (and support skills_exclude). Auto-installs if needed. */
const ensureInFlight = new Map<string, Promise<DepProbe>>();

export function ensureSidecarDeps(
  python: string,
  output: { appendLine(s: string): void },
  env?: NodeJS.ProcessEnv,
): Promise<DepProbe> {
  const key = python.trim() || python;
  const existing = ensureInFlight.get(key);
  if (existing) {
    return existing;
  }
  const run = ensureSidecarDepsOnce(python, output, env).finally(() => {
    if (ensureInFlight.get(key) === run) {
      ensureInFlight.delete(key);
    }
  });
  ensureInFlight.set(key, run);
  return run;
}

async function ensureSidecarDepsOnce(
  python: string,
  output: { appendLine(s: string): void },
  env?: NodeJS.ProcessEnv,
): Promise<DepProbe> {
  let probe = probeSidecarDepsSync(python, env);
  output.appendLine(
    `Deps probe: ok=${probe.ok} version=${probe.version || "?"} skills_exclude=${probe.supportsSkillsExclude}`,
  );
  if (!needsPipInstall(probe)) {
    return probe;
  }

  output.appendLine(
    probe.ok
      ? "clawagents version is incompatible with this extension — installing a supported version…"
      : "Missing Python packages — installing automatically…",
  );

  let result = await installSidecarDeps(python, output);
  if (!result.ok && /Permission denied|not writable|access denied/i.test(result.detail)) {
    output.appendLine("Retrying pip with --user …");
    result = await installSidecarDeps(python, output, { forceUser: true });
  }
  if (!result.ok) {
    return {
      ok: false,
      detail:
        `Auto-install failed.\n${result.detail}\n\n`
        + `Manual fix:\n"${python}" -m pip install -U ${SIDECAR_PIP_PACKAGES.map((p) => `'${p}'`).join(" ")}`,
    };
  }

  probe = probeSidecarDepsSync(python, env);
  if (!probe.ok) {
    return {
      ok: false,
      detail: `Packages installed but import still fails:\n${probe.detail}`,
    };
  }
  if (probe.supportsSkillsExclude === false) {
    output.appendLine(
      "Warning: installed clawagents still lacks skills_exclude — extension will degrade gracefully.",
    );
  }
  void vscode.window.showInformationMessage(
    `ClawAgents Python ready (${probe.version || "ok"}) on ${python}`,
  );
  return probe;
}
