import { spawn, spawnSync } from "child_process";
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";

export type PythonIdentity = {
  executable: string;
  majorMinor: string;
};

const ensureInFlight = new Map<string, Promise<string>>();

export function parsePythonIdentity(stdout: string): PythonIdentity | undefined {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 2 || !/^\d+\.\d+$/.test(lines[1])) {
    return undefined;
  }
  return { executable: lines[0], majorMinor: lines[1] };
}

export function probePythonIdentity(basePython: string): PythonIdentity | undefined {
  const result = spawnSync(
    basePython,
    ["-c", "import sys; print(sys.executable); print(f'{sys.version_info.major}.{sys.version_info.minor}')"],
    { encoding: "utf8", timeout: 10_000, windowsHide: true },
  );
  if (result.status !== 0) {
    return undefined;
  }
  return parsePythonIdentity(result.stdout || "");
}

export function managedPythonEnvDir(
  globalStoragePath: string,
  executable: string,
  majorMinor: string,
): string {
  const digest = createHash("sha256")
    .update(`${path.resolve(executable)}\0${majorMinor}`, "utf8")
    .digest("hex")
    .slice(0, 12);
  return path.join(globalStoragePath, "python-envs", `py-${majorMinor}-${digest}`);
}

export function managedPythonExecutable(
  envDir: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return platform === "win32"
    ? path.join(envDir, "Scripts", "python.exe")
    : path.join(envDir, "bin", "python");
}

function managedPythonIsUsable(python: string): boolean {
  if (!fs.existsSync(python)) return false;
  const result = spawnSync(python, ["-c", "import pip, sys; print(sys.executable)"], {
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
  });
  return result.status === 0;
}

function runVenv(
  basePython: string,
  envDir: string,
  output: { appendLine(s: string): void },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(basePython, ["-m", "venv", envDir], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let log = "";
    const onData = (buf: Buffer) => {
      const text = buf.toString();
      log = (log + text).slice(-8_000);
      for (const line of text.split(/\r?\n/)) {
        if (line.trim()) output.appendLine(line);
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`python -m venv exited ${code}\n${log.trim()}`));
    });
  });
}

/** Create/reuse an extension-owned virtualenv without mutating the user's Python. */
export async function ensureManagedPython(
  basePython: string,
  globalStoragePath: string,
  output: { appendLine(s: string): void },
): Promise<string> {
  const identity = probePythonIdentity(basePython);
  if (!identity) {
    throw new Error(`Could not inspect base Python interpreter: ${basePython}`);
  }
  const [major, minor] = identity.majorMinor.split(".").map(Number);
  if (major < 3 || (major === 3 && minor < 10)) {
    throw new Error(
      `ClawAgents requires Python 3.10+; ${identity.executable} is ${identity.majorMinor}`,
    );
  }
  const envDir = managedPythonEnvDir(
    globalStoragePath,
    identity.executable,
    identity.majorMinor,
  );
  const python = managedPythonExecutable(envDir);
  // Check ownership before inspecting/removing the directory: another start may
  // be creating it right now, and an incomplete venv is expected in that window.
  const existing = ensureInFlight.get(envDir);
  if (existing) {
    return existing;
  }
  if (managedPythonIsUsable(python)) {
    return python;
  }
  if (fs.existsSync(envDir)) {
    output.appendLine(`Removing incomplete managed Python environment: ${envDir}`);
    fs.rmSync(envDir, { recursive: true, force: true });
  }
  const creating = (async () => {
    fs.mkdirSync(path.dirname(envDir), { recursive: true });
    output.appendLine(
      `Creating managed Python environment (${identity.majorMinor}) at ${envDir}`,
    );
    try {
      await runVenv(identity.executable, envDir, output);
    } catch (err) {
      fs.rmSync(envDir, { recursive: true, force: true });
      throw err;
    }
    if (!managedPythonIsUsable(python)) {
      fs.rmSync(envDir, { recursive: true, force: true });
      throw new Error(`Managed Python at ${python} is missing a working pip installation`);
    }
    return python;
  })().finally(() => {
    ensureInFlight.delete(envDir);
  });
  ensureInFlight.set(envDir, creating);
  return creating;
}
