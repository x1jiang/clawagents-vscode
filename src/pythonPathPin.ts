import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";
import {
  ensureSidecarDeps,
  versionAtLeast,
  MIN_CLAWAGENTS_VERSION,
  MIN_CLAWAGENTS_VERSION_STR,
} from "./pythonDeps";

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

function resolvePathCandidates(name: string): string[] {
  const finder = process.platform === "win32" ? "where" : "which";
  const args = process.platform === "win32" ? [name] : ["-a", name];
  try {
    const result = spawnSync(finder, args, { encoding: "utf8" });
    return (result.stdout || "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && fs.existsSync(l));
  } catch {
    return [];
  }
}

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
    for (const resolved of resolvePathCandidates(name)) {
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
    `Install/Reinstall Python Deps upgrades them automatically (floor ${MIN_CLAWAGENTS_VERSION_STR}).`
  );
}

export type PathFloorResult = {
  upgraded: number;
  failed: Array<PathDriftHit & { detail: string }>;
};

/**
 * Upgrade every PATH interpreter that imports clawagents below the extension floor.
 * Called from ensureSidecarDeps / install / doctor so Doctor is not required.
 */
export async function ensurePathPythonFloor(
  sidecarPython: string,
  output: { appendLine(s: string): void },
): Promise<PathFloorResult> {
  const drift = probePathInterpreterDrift(sidecarPython);
  if (drift.length === 0) {
    return { upgraded: 0, failed: [] };
  }

  output.appendLine(
    `PATH Python floor: upgrading ${drift.length} interpreter(s) to clawagents>=${MIN_CLAWAGENTS_VERSION_STR}…`,
  );
  let upgraded = 0;
  const failed: PathFloorResult["failed"] = [];

  for (const hit of drift) {
    output.appendLine(
      `PATH drift: ${hit.executable} → clawagents ${hit.version} — upgrading…`,
    );
    // Nested ensure must not re-enter path-floor sync (avoid loops / double progress).
    const result = await ensureSidecarDeps(hit.executable, output, undefined, {
      syncPathFloor: false,
    });
    if (result.ok && versionAtLeast(result.version, MIN_CLAWAGENTS_VERSION)) {
      upgraded += 1;
      output.appendLine(
        `  → ${hit.executable} now clawagents ${result.version || "?"}`,
      );
    } else {
      failed.push({
        ...hit,
        detail: result.detail || `still ${result.version || "?"}`,
      });
      output.appendLine(
        `  → FAILED ${hit.executable}: ${(result.detail || "").split("\n")[0] || "unknown"}`,
      );
    }
  }

  if (failed.length === 0) {
    output.appendLine(`PATH Python floor: all interpreters ≥ ${MIN_CLAWAGENTS_VERSION_STR}`);
  } else {
    output.appendLine(
      `PATH Python floor: ${failed.length} still outdated — see ClawAgents Sidecar output.`,
    );
  }
  return { upgraded, failed };
}
