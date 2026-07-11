import { spawn, spawnSync } from "child_process";
import * as vscode from "vscode";

/** Packages installed into clawagents.pythonPath on first run / when missing. */
export const SIDECAR_PIP_PACKAGES = [
  "clawagents[gemini,anthropic,mcp]",
  "fastapi",
  "uvicorn",
  "pydantic",
  "python-dotenv",
] as const;

export type DepProbe = {
  ok: boolean;
  executable?: string;
  version?: string;
  supportsSkillsExclude?: boolean;
  detail: string;
};

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
  return !probe.ok || probe.supportsSkillsExclude === false;
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
          env: process.env,
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
export async function ensureSidecarDeps(
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
      ? "clawagents is too old for this extension — upgrading packages…"
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
