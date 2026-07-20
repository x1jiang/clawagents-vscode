import { spawn, spawnSync } from "child_process";
import * as vscode from "vscode";
import { curatedProcessEnv } from "./envCurate";

/** Minimum clawagents version required by this extension host. */
export const MIN_CLAWAGENTS_VERSION: [number, number, number] = [6, 20, 31];
export const MAX_CLAWAGENTS_VERSION: [number, number, number] = [7, 0, 0];
export const MIN_CLAWAGENTS_VERSION_STR = MIN_CLAWAGENTS_VERSION.join(".");

/** GitHub release wheel — used when PyPI has not published the floor yet. */
export const CLAWAGENTS_GITHUB_WHEEL =
  `https://github.com/x1jiang/clawagents_py/releases/download/v${MIN_CLAWAGENTS_VERSION_STR}/clawagents-${MIN_CLAWAGENTS_VERSION_STR}-py3-none-any.whl`;

/** Packages installed into clawagents.pythonPath on first run / when missing. */
export const SIDECAR_PIP_PACKAGES = [
  // Keep in lockstep with python/requirements.txt and MIN_CLAWAGENTS_VERSION.
  // `media` pulls Pillow; `accurate-tokens` pulls tiktoken for BPE counts
  // used by Luna 231K/258K compaction thresholds.
  `clawagents[gemini,anthropic,bedrock,mcp,media,accurate-tokens]>=${MIN_CLAWAGENTS_VERSION_STR},<7`,
  "fastapi>=0.115.0,<1",
  "uvicorn>=0.30.0,<1",
  "pydantic>=2.7.0,<3",
  "python-dotenv>=1.0.0,<2",
] as const;

/** Fallback install when PyPI lacks the required clawagents version. */
export const SIDECAR_PIP_PACKAGES_GITHUB_FALLBACK = [
  CLAWAGENTS_GITHUB_WHEEL,
  "google-genai>=0.1.0",
  "anthropic>=0.40.0",
  "boto3>=1.34.0",
  "mcp>=1.0.0",
  "Pillow>=10.0.0",
  "tiktoken>=0.5.0",
  "fastapi>=0.115.0,<1",
  "uvicorn>=0.30.0,<1",
  "pydantic>=2.7.0,<3",
  "python-dotenv>=1.0.0,<2",
] as const;

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

function pipEnv(): NodeJS.ProcessEnv {
  return {
    ...curatedProcessEnv(),
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    TMPDIR: process.env.TMPDIR,
    TMP: process.env.TMP,
    TEMP: process.env.TEMP,
  };
}

async function runPipInstall(
  python: string,
  packages: readonly string[],
  output: { appendLine(s: string): void },
  options?: {
    forceUser?: boolean;
    breakSystemPackages?: boolean;
    title?: string;
  },
): Promise<{ ok: boolean; detail: string }> {
  const args = ["-m", "pip", "install", "-U", ...packages];
  // Insert flags after `install` (index 2 is "install", 3 is "-U").
  if (options?.breakSystemPackages) {
    args.splice(3, 0, "--break-system-packages");
  }
  if (options?.forceUser) {
    args.splice(3, 0, "--user");
  }

  output.appendLine(`Running: ${python} ${args.join(" ")}`);

  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: options?.title || "ClawAgents: installing Python packages…",
      cancellable: false,
    },
    async (progress) => {
      progress.report({ message: "pip install (may take a minute on first run)" });
      return await new Promise<{ ok: boolean; detail: string }>((resolve) => {
        const child = spawn(python, args, {
          stdio: ["ignore", "pipe", "pipe"],
          env: pipEnv(),
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

export async function installSidecarDeps(
  python: string,
  output: { appendLine(s: string): void },
  options?: { forceUser?: boolean; breakSystemPackages?: boolean },
): Promise<{ ok: boolean; detail: string }> {
  return runPipInstall(python, SIDECAR_PIP_PACKAGES, output, options);
}

function looksLikeMissingOnPyPI(detail: string): boolean {
  return /No matching distribution found for clawagents|Could not find a version that satisfies the requirement clawagents/i
    .test(detail);
}

function looksLikeExternallyManaged(detail: string): boolean {
  return /externally-managed-environment|PEP 668/i.test(detail);
}

/** Retry pip with --user / --break-system-packages when the environment blocks writes. */
async function installWithWritableFallbacks(
  python: string,
  packages: readonly string[],
  output: { appendLine(s: string): void },
  title?: string,
): Promise<{ ok: boolean; detail: string }> {
  let result = await runPipInstall(python, packages, output, { title });
  if (!result.ok && /Permission denied|not writable|access denied/i.test(result.detail)) {
    output.appendLine("Retrying pip with --user …");
    result = await runPipInstall(python, packages, output, {
      forceUser: true,
      title,
    });
  }
  // Homebrew / Debian PEP 668 — never apply --break-system-packages without consent.
  if (!result.ok && looksLikeExternallyManaged(result.detail)) {
    const choice = await vscode.window.showWarningMessage(
      "This Python is externally managed (PEP 668). Allow pip --break-system-packages, or cancel and use a venv / clawagents.pythonPath?",
      { modal: true },
      "Allow --break-system-packages",
      "Cancel",
    );
    if (choice === "Allow --break-system-packages") {
      output.appendLine(
        "Retrying pip with --break-system-packages (user confirmed)…",
      );
      result = await runPipInstall(python, packages, output, {
        breakSystemPackages: true,
        title,
      });
    } else {
      output.appendLine(
        "Skipped --break-system-packages — set clawagents.pythonPath to a venv, then Install Python Deps.",
      );
    }
  }
  return result;
}

export type EnsureDepsOptions = {
  /** Also upgrade other PATH Pythons below the floor (default true). */
  syncPathFloor?: boolean;
};

/** Ensure deps exist (and support skills_exclude). Auto-installs if needed. */
const ensureInFlight = new Map<string, Promise<DepProbe>>();

export function ensureSidecarDeps(
  python: string,
  output: { appendLine(s: string): void },
  env?: NodeJS.ProcessEnv,
  opts?: EnsureDepsOptions,
): Promise<DepProbe> {
  const key = python.trim() || python;
  const existing = ensureInFlight.get(key);
  if (existing) {
    return existing;
  }
  const run = ensureSidecarDepsOnce(python, output, env, opts).finally(() => {
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
  opts?: EnsureDepsOptions,
): Promise<DepProbe> {
  let probe = probeSidecarDepsSync(python, env);
  output.appendLine(
    `Deps probe: ok=${probe.ok} version=${probe.version || "?"} skills_exclude=${probe.supportsSkillsExclude}`,
  );
  if (needsPipInstall(probe)) {
    output.appendLine(
      probe.ok
        ? "clawagents version is incompatible with this extension — installing a supported version…"
        : "Missing Python packages — installing automatically…",
    );

    let result = await installWithWritableFallbacks(python, SIDECAR_PIP_PACKAGES, output);

    // PyPI may lag the GitHub release (common right after a VSIX bump).
    if (!result.ok && looksLikeMissingOnPyPI(result.detail)) {
      output.appendLine(
        `PyPI does not have clawagents>=${MIN_CLAWAGENTS_VERSION_STR} yet — installing from GitHub release wheel…`,
      );
      result = await installWithWritableFallbacks(
        python,
        SIDECAR_PIP_PACKAGES_GITHUB_FALLBACK,
        output,
        "ClawAgents: installing from GitHub release…",
      );
    }

    if (!result.ok) {
      const manualGithub = SIDECAR_PIP_PACKAGES_GITHUB_FALLBACK.map((p) => `'${p}'`).join(" ");
      return {
        ok: false,
        detail:
          `Auto-install failed.\n${result.detail}\n\n`
          + `Manual fix (PyPI):\n"${python}" -m pip install -U ${SIDECAR_PIP_PACKAGES.map((p) => `'${p}'`).join(" ")}\n\n`
          + `Or from GitHub release (when PyPI lags):\n"${python}" -m pip install -U ${manualGithub}`,
      };
    }

    probe = probeSidecarDepsSync(python, env);
    if (!probe.ok) {
      return {
        ok: false,
        detail: `Packages installed but import still fails:\n${probe.detail}`,
      };
    }
    // pip can exit 0 with a stale cached wheel below the floor — re-check.
    if (
      !versionAtLeast(probe.version, MIN_CLAWAGENTS_VERSION) ||
      versionAtLeast(probe.version, MAX_CLAWAGENTS_VERSION)
    ) {
      return {
        ok: false,
        detail:
          `Packages installed but clawagents ${probe.version || "?"} is still outside `
          + `the required range (>=${MIN_CLAWAGENTS_VERSION_STR}, <${MAX_CLAWAGENTS_VERSION.join(".")}). `
          + `Clear pip cache and retry:\n`
          + `"${python}" -m pip install -U --force-reinstall ${SIDECAR_PIP_PACKAGES.map((p) => `'${p}'`).join(" ")}`,
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
  }

  // Keep other PATH interpreters on the same floor so shell `python3` matches.
  // Opt-in via opts + setting; never throw when vscode.workspace is stubbed (tests).
  let syncPath = opts?.syncPathFloor === true;
  if (opts?.syncPathFloor !== false && opts?.syncPathFloor !== true) {
    try {
      syncPath =
        vscode.workspace?.getConfiguration?.("clawagents")?.get<boolean>(
          "syncPathPythons",
          true,
        ) ?? true;
    } catch {
      syncPath = false;
    }
  }
  if (syncPath && probe.ok) {
    try {
      const { ensurePathPythonFloor } = await import("./pythonPathPin");
      await ensurePathPythonFloor(python, output);
    } catch (err) {
      output.appendLine(
        `PATH Python floor sync skipped: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return probe;
}
