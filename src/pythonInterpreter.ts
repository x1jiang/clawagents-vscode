import { execFile } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { curatedProcessEnv } from "./envCurate";

export const MIN_PYTHON_VERSION = "3.10";
const PROBE_TIMEOUT_MS = 3_000;
type Output = { appendLine(line: string): void };

/** Resolve an exact request without a shell or changing its virtualenv symlink. */
export function resolvePythonExecutable(configured: string): string {
  const candidate = configured.trim() || (process.platform === "win32" ? "python" : "python3");
  const expanded = candidate.startsWith("~/") || candidate.startsWith("~\\")
    ? path.join(os.homedir(), candidate.slice(2)) : candidate;
  if (path.isAbsolute(expanded)) {
    if (fs.existsSync(expanded)) return expanded;
  } else if (!/[\\/]/.test(expanded)) {
    for (const folder of (process.env.PATH || "").split(path.delimiter)) {
      if (!path.isAbsolute(folder)) continue;
      for (const suffix of process.platform === "win32" ? ["", ".exe"] : [""]) {
        const executable = path.join(folder, expanded + suffix);
        if (fs.existsSync(executable)) return executable;
      }
    }
  }
  throw new Error(
    `Python interpreter "${candidate}" not found. Set clawagents.pythonPath in User `
    + "or Remote settings to an interpreter on this host, or run ClawAgents: Select Python Interpreter.",
  );
}

/** Check Python itself, with no workspace imports, provider secrets, or pip installs. */
export function probePythonVersion(python: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(python, ["-I", "-c", "import sys; print('.'.join(map(str, sys.version_info[:3])))"], {
      timeout: PROBE_TIMEOUT_MS, windowsHide: true, cwd: os.homedir(),
      env: { ...curatedProcessEnv(), SystemRoot: process.env.SystemRoot },
    }, (error, stdout) => {
      if (error) {
        reject(new Error(`Python probe failed (${python}): ${error.code || "could not execute"}`));
        return;
      }
      const version = stdout.trim();
      const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
      if (!match || Number(match[1]) !== 3 || Number(match[2]) < 10) {
        reject(new Error(`ClawAgents requires Python ${MIN_PYTHON_VERSION}+; ${python} reports ${version || "no version"}.`));
        return;
      }
      resolve(version);
    });
  });
}

/** Host-local discovery only; never source a shell profile or search a project. */
export function pythonDiscoveryCandidates(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): string[] {
  const windows = platform === "win32";
  const paths = windows ? path.win32 : path.posix;
  const folders = (env.PATH || "").split(windows ? ";" : ":").filter(folder => paths.isAbsolute(folder));
  folders.push(paths.join(home, ".local", "bin"));
  if (windows) {
    if (env.LOCALAPPDATA) {
      folders.push(paths.join(env.LOCALAPPDATA, "Microsoft", "WindowsApps"));
      const installs = paths.join(env.LOCALAPPDATA, "Programs", "Python");
      try {
        folders.push(...fs.readdirSync(installs).filter(name => /^Python3\d+$/.test(name))
          .sort().reverse().map(name => paths.join(installs, name)));
      } catch { /* Python may only be on PATH. */ }
    }
  } else {
    folders.push(paths.join(home, ".pyenv", "shims"), paths.join(home, "miniconda3", "bin"),
      paths.join(home, "anaconda3", "bin"));
    if (platform === "darwin") folders.push("/opt/homebrew/bin");
    folders.push("/usr/local/bin", "/usr/bin", "/bin");
  }
  const names = windows ? ["python.exe", "python3.exe", "py.exe"]
    : ["python3", "python", "python3.14", "python3.13", "python3.12", "python3.11", "python3.10"];
  return [...new Set(folders.flatMap(folder => names.map(name => paths.join(folder, name))))];
}

function insideRoot(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return !relative || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** Managed mode can recover a stale base; custom mode always uses the exact request. */
export async function resolveSidecarBasePython(
  configured: string,
  runtime: "managed" | "custom",
  output: Output,
  workspaceRoots: string[] = [],
): Promise<string> {
  const roots = workspaceRoots.map(root => {
    try { return fs.realpathSync(root); } catch { return path.resolve(root); }
  });
  let requestedFailure: string;
  let requested: string | undefined;
  try {
    requested = resolvePythonExecutable(configured);
    if (!/[\\/]/.test(configured) && roots.some(root =>
      insideRoot(requested!, root) || insideRoot(fs.realpathSync(requested!), root))) {
      throw new Error("Python command resolves inside a workspace. Select a full interpreter path in User or Remote settings.");
    }
    const version = await probePythonVersion(requested);
    output.appendLine(`Python base: ${requested} (${version}, ${runtime}, host ${os.hostname()})`);
    return requested;
  } catch (error) {
    if (runtime === "custom") throw error;
    requestedFailure = error instanceof Error ? error.message : String(error);
    output.appendLine(`Managed Python base unavailable: ${requestedFailure}`);
  }
  const seen = new Set<string>();
  if (requested) {
    try { seen.add(fs.realpathSync(requested)); } catch { /* Broken symlink. */ }
  }
  const candidates = pythonDiscoveryCandidates().filter(candidate => {
    try {
      const real = fs.realpathSync(candidate);
      if (seen.has(real) || !fs.statSync(candidate).isFile()
        || roots.some(root => insideRoot(candidate, root) || insideRoot(real, root))) return false;
      seen.add(real);
      return true;
    } catch { return false; }
  });
  // Bound recovery time even when PATH contains hung launchers. Probe small
  // batches while preserving candidate priority and collecting every rejection.
  const deadline = Date.now() + 15_000;
  for (let offset = 0; offset < candidates.length && Date.now() < deadline; offset += 4) {
    const batch = candidates.slice(offset, offset + 4);
    const results = await Promise.allSettled(batch.map(probePythonVersion));
    for (let index = 0; index < results.length; index++) {
      const result = results[index];
      if (result.status === "fulfilled") {
        output.appendLine(`Managed Python discovered: ${batch[index]} (${result.value}, host ${os.hostname()}). Settings unchanged.`);
        return batch[index];
      }
      output.appendLine(String(result.reason instanceof Error ? result.reason.message : result.reason));
    }
  }
  throw new Error(`No compatible Python ${MIN_PYTHON_VERSION}+ found on this host. Run ClawAgents: Select Python Interpreter `
    + `or install Python on the host running this window. Configured base: ${configured}. ${requestedFailure}`);
}
