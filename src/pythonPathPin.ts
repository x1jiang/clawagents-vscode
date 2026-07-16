import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";
import { versionAtLeast, MIN_CLAWAGENTS_VERSION } from "./pythonDeps";

/** Put the configured interpreter's directory first on PATH (and CLAWAGENTS_PYTHON). */
export function pinPythonPathEnv(
  python: string,
  baseEnv: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  const abs = path.isAbsolute(python) ? python : python;
  let binDir = "";
  try {
    if (path.isAbsolute(python) && fs.existsSync(python)) {
      binDir = path.dirname(fs.realpathSync(python));
    }
  } catch {
    binDir = path.isAbsolute(python) ? path.dirname(python) : "";
  }
  if (binDir) {
    const sep = process.platform === "win32" ? ";" : ":";
    const prior = env.PATH || process.env.PATH || "";
    const parts = prior.split(sep).filter((p) => p && p !== binDir);
    env.PATH = [binDir, ...parts].join(sep);
  }
  env.CLAWAGENTS_PYTHON = abs;
  return env;
}

export type PathDriftHit = {
  executable: string;
  version: string;
};

/** Probe PATH python* binaries that import a different / older clawagents. */
export function probePathInterpreterDrift(sidecarPython: string): PathDriftHit[] {
  let sidecarReal = sidecarPython;
  try {
    if (path.isAbsolute(sidecarPython) && fs.existsSync(sidecarPython)) {
      sidecarReal = fs.realpathSync(sidecarPython);
    }
  } catch {
    /* keep */
  }

  const names =
    process.platform === "win32"
      ? ["python", "python3", "py"]
      : ["python3", "python", "python3.13", "python3.12", "python3.11"];
  const seen = new Set<string>([sidecarReal]);
  const hits: PathDriftHit[] = [];

  for (const name of names) {
    const finder = process.platform === "win32" ? "where" : "which";
    let resolved = "";
    try {
      const result = spawnSync(finder, [name], { encoding: "utf8" });
      resolved = (result.stdout || "")
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => l && fs.existsSync(l)) || "";
    } catch {
      continue;
    }
    if (!resolved) {
      continue;
    }
    let real = resolved;
    try {
      real = fs.realpathSync(resolved);
    } catch {
      /* keep */
    }
    if (seen.has(real)) {
      continue;
    }
    seen.add(real);

    const probe = spawnSync(
      resolved,
      [
        "-c",
        "import clawagents; print(getattr(clawagents, '__version__', '?'))",
      ],
      { encoding: "utf8", timeout: 12_000 },
    );
    if (probe.status !== 0) {
      continue;
    }
    const version = (probe.stdout || "").trim().split(/\r?\n/)[0] || "?";
    if (!versionAtLeast(version, MIN_CLAWAGENTS_VERSION)) {
      hits.push({ executable: resolved, version });
    }
  }
  return hits;
}

export function formatDriftWarning(hits: PathDriftHit[], sidecarPython: string): string {
  const lines = hits
    .slice(0, 4)
    .map((h) => `• ${h.executable} → clawagents ${h.version}`)
    .join("\n");
  return (
    `ClawAgents: other PATH Pythons are outdated (sidecar uses ${sidecarPython}).\n` +
    `${lines}\n` +
    `Shell tools that call \`python3\` may use the wrong install. ` +
    `Run “ClawAgents: Doctor (Python versions)” or upgrade those interpreters.`
  );
}
