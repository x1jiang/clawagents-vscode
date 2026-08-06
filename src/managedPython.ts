import { spawn, spawnSync } from "child_process";
import { createHash } from "crypto";
import * as fs from "fs";
import * as https from "https";
import * as os from "os";
import * as path from "path";

/** Official PyPA pip bootstrap — last resort when the host carries no installer. */
export const GET_PIP_URL = "https://bootstrap.pypa.io/pip/get-pip.py";
/** Redirects may not leave PyPA infrastructure. */
export const GET_PIP_ALLOWED_HOSTS = ["bootstrap.pypa.io"] as const;
/** get-pip.py is ~2.5 MB; refuse anything that is not plausibly it. */
const GET_PIP_MAX_BYTES = 16 * 1024 * 1024;
const GET_PIP_MIN_BYTES = 1024;

export type PythonIdentity = {
  executable: string;
  majorMinor: string;
};

const ensureInFlight = new Map<string, Promise<string>>();

/**
 * Every webview action calls ensureStarted(), so a broken interpreter used to
 * rebuild (and re-delete) the environment once per message. Remember a failure
 * briefly and replay it instead.
 */
const recentFailures = new Map<string, { error: Error; at: number }>();
export const MANAGED_PYTHON_FAILURE_TTL_MS = 30_000;

/** Called on explicit restart so a user who just fixed their host isn't stonewalled. */
export function clearManagedPythonFailures(): void {
  recentFailures.clear();
}

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

type CommandResult = { code: number | null; log: string };

function runCommand(
  command: string,
  args: string[],
  output: { appendLine(s: string): void },
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
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
    child.once("error", (err) => resolve({ code: null, log: `${log}\n${err.message}`.trim() }));
    child.once("exit", (code) => resolve({ code, log: log.trim() }));
  });
}

/**
 * Debian/Ubuntu split `ensurepip` into a separate `pythonX.Y-venv` package, so
 * the stdlib `venv` module imports fine but cannot seed pip.
 */
export function looksLikeMissingEnsurepip(log: string): boolean {
  return /ensurepip is not available|No module named ['"`]?ensurepip|python3?[\d.]*-venv/i.test(log);
}

function moduleAvailable(python: string, moduleName: string): boolean {
  const result = spawnSync(python, ["-c", `import ${moduleName}`], {
    timeout: 10_000,
    windowsHide: true,
  });
  return result.status === 0;
}

export function parsePipVersion(stdout: string): [number, number] | undefined {
  const match = /^pip (\d+)\.(\d+)/.exec(stdout.trim());
  return match ? [Number(match[1]), Number(match[2])] : undefined;
}

/** pip 22.3 added `--python <interpreter>`, which can seed a pip-less venv. */
export function pipCanTargetOtherInterpreter(python: string): boolean {
  const result = spawnSync(python, ["-m", "pip", "--version"], {
    encoding: "utf8",
    timeout: 15_000,
    windowsHide: true,
  });
  if (result.status !== 0) return false;
  const version = parsePipVersion(result.stdout || "");
  if (!version) return false;
  const [major, minor] = version;
  return major > 22 || (major === 22 && minor >= 3);
}

function uvAvailable(): boolean {
  const result = spawnSync("uv", ["--version"], {
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
  });
  return result.status === 0;
}

/** Reject anything that is not plain HTTPS to a PyPA host (captive portals, MITM redirects). */
export function assertTrustedBootstrapUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== "https:") {
    throw new Error(`Refusing non-HTTPS pip bootstrap URL: ${url.protocol}//${url.host}`);
  }
  if (!(GET_PIP_ALLOWED_HOSTS as readonly string[]).includes(url.hostname)) {
    throw new Error(`Refusing pip bootstrap redirect to untrusted host: ${url.hostname}`);
  }
  return url;
}

/** A captive portal or error page is the realistic failure here, not a valid script. */
export function looksLikePythonScript(body: string): boolean {
  if (body.length < GET_PIP_MIN_BYTES) return false;
  const head = body.slice(0, 4096).toLowerCase();
  if (head.includes("<!doctype") || head.includes("<html")) return false;
  return /\bimport\b/.test(body) && /\bdef\b/.test(body);
}

function downloadText(rawUrl: string, redirectsLeft = 3): Promise<string> {
  const url = assertTrustedBootstrapUrl(rawUrl);
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      // Explicit: never inherit a relaxed TLS posture from elsewhere.
      { timeout: 30_000, rejectUnauthorized: true },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          if (redirectsLeft <= 0) {
            reject(new Error(`Too many redirects fetching ${url.href}`));
            return;
          }
          try {
            const next = assertTrustedBootstrapUrl(new URL(res.headers.location, url).toString());
            resolve(downloadText(next.toString(), redirectsLeft - 1));
          } catch (err) {
            reject(err);
          }
          return;
        }
        if (status !== 200) {
          res.resume();
          reject(new Error(`GET ${url.href} returned HTTP ${status}`));
          return;
        }
        let size = 0;
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > GET_PIP_MAX_BYTES) {
            req.destroy();
            reject(new Error(`pip bootstrap exceeded ${GET_PIP_MAX_BYTES} bytes — refusing`));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      },
    );
    req.once("error", reject);
    req.once("timeout", () => {
      req.destroy(new Error(`Timed out fetching ${url.href}`));
    });
  });
}

type EnvBuilder = {
  label: string;
  usable(): boolean;
  build(): Promise<CommandResult>;
};

/**
 * Ways to get a pip-equipped venv when the base interpreter has no ensurepip.
 * Each carries its own pip payload, so none of them needs root or apt.
 */
function pipFreeBuilders(
  identity: PythonIdentity,
  envDir: string,
  output: { appendLine(s: string): void },
  confirmNetworkBootstrap?: (url: string) => Promise<boolean>,
): EnvBuilder[] {
  return [
    {
      label: "uv venv --seed",
      usable: uvAvailable,
      build: () =>
        runCommand("uv", ["venv", "--seed", "--python", identity.executable, envDir], output),
    },
    {
      label: "python -m virtualenv",
      usable: () => moduleAvailable(identity.executable, "virtualenv"),
      build: () => runCommand(identity.executable, ["-m", "virtualenv", envDir], output),
    },
    {
      label: "python -m venv --without-pip + pip --python",
      usable: () => pipCanTargetOtherInterpreter(identity.executable),
      build: async () => {
        const created = await runCommand(
          identity.executable,
          ["-m", "venv", "--without-pip", envDir],
          output,
        );
        if (created.code !== 0) return created;
        return runCommand(
          identity.executable,
          [
            "-m",
            "pip",
            // pip rejects --python after the subcommand name.
            "--python",
            managedPythonExecutable(envDir),
            "install",
            "--upgrade",
            "pip",
            "setuptools",
            "wheel",
          ],
          output,
        );
      },
    },
    {
      // Hosts with no pip, no uv and no virtualenv have nothing local left to
      // try. Fetching pip the way PyPA documents means running code from the
      // network, so it is the only builder that asks first.
      label: "python -m venv --without-pip + get-pip.py",
      usable: () => Boolean(confirmNetworkBootstrap),
      build: async () => {
        if (!(await confirmNetworkBootstrap?.(GET_PIP_URL))) {
          return { code: null, log: "pip bootstrap download declined" };
        }
        const created = await runCommand(
          identity.executable,
          ["-m", "venv", "--without-pip", envDir],
          output,
        );
        if (created.code !== 0) return created;
        const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "clawagents-get-pip-"));
        const script = path.join(scratch, "get-pip.py");
        try {
          output.appendLine(`Downloading ${GET_PIP_URL} …`);
          const body = await downloadText(GET_PIP_URL);
          if (!looksLikePythonScript(body)) {
            throw new Error(
              `${GET_PIP_URL} did not return a Python script (captive portal or proxy?)`,
            );
          }
          fs.writeFileSync(script, body, { encoding: "utf8", mode: 0o600 });
        } catch (err) {
          fs.rmSync(scratch, { recursive: true, force: true });
          return { code: null, log: err instanceof Error ? err.message : String(err) };
        }
        try {
          return await runCommand(managedPythonExecutable(envDir), [script], output);
        } finally {
          fs.rmSync(scratch, { recursive: true, force: true });
        }
      },
    },
  ];
}

function ensurepipRemedy(identity: PythonIdentity): string {
  return [
    `${identity.executable} cannot create a virtual environment with pip: ensurepip is missing`,
    "and no fallback (uv, virtualenv, or pip --python) was available.",
    "",
    "Fix with any one of:",
    `  sudo apt install python${identity.majorMinor}-venv`,
    `  ${identity.executable} -m pip install --user virtualenv`,
    "  curl -LsSf https://astral.sh/uv/install.sh | sh",
    "",
    "Or point ClawAgents at an interpreter that already has pip: set clawagents.pythonRuntime",
    "to \"custom\" and clawagents.pythonPath to that interpreter.",
  ].join("\n");
}

async function createManagedEnv(
  identity: PythonIdentity,
  envDir: string,
  output: { appendLine(s: string): void },
  confirmNetworkBootstrap?: (url: string) => Promise<boolean>,
): Promise<void> {
  const stdlib = await runCommand(identity.executable, ["-m", "venv", envDir], output);
  if (stdlib.code === 0) return;

  const firstFailure = `python -m venv exited ${stdlib.code}\n${stdlib.log}`;
  if (!looksLikeMissingEnsurepip(stdlib.log)) {
    throw new Error(firstFailure);
  }

  output.appendLine(
    "Base Python has no ensurepip — trying pip-carrying alternatives before giving up.",
  );
  for (const builder of pipFreeBuilders(identity, envDir, output, confirmNetworkBootstrap)) {
    if (!builder.usable()) {
      output.appendLine(`Skipping ${builder.label}: not available.`);
      continue;
    }
    fs.rmSync(envDir, { recursive: true, force: true });
    output.appendLine(`Creating managed Python environment via ${builder.label} …`);
    const result = await builder.build();
    if (result.code === 0) {
      output.appendLine(`Managed Python environment created via ${builder.label}.`);
      return;
    }
    output.appendLine(`${builder.label} exited ${result.code}.`);
  }
  throw new Error(`${firstFailure}\n\n${ensurepipRemedy(identity)}`);
}

/** Create/reuse an extension-owned virtualenv without mutating the user's Python. */
export async function ensureManagedPython(
  basePython: string,
  globalStoragePath: string,
  output: { appendLine(s: string): void },
  options?: {
    /** Asked before pip is fetched from the network; omit to disable that fallback. */
    confirmNetworkBootstrap?: (url: string) => Promise<boolean>;
  },
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
    recentFailures.delete(envDir);
    return python;
  }
  const failed = recentFailures.get(envDir);
  if (failed && Date.now() - failed.at < MANAGED_PYTHON_FAILURE_TTL_MS) {
    throw failed.error;
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
      await createManagedEnv(identity, envDir, output, options?.confirmNetworkBootstrap);
    } catch (err) {
      fs.rmSync(envDir, { recursive: true, force: true });
      throw err;
    }
    if (!managedPythonIsUsable(python)) {
      fs.rmSync(envDir, { recursive: true, force: true });
      throw new Error(
        `Managed Python at ${python} is missing a working pip installation\n\n`
        + ensurepipRemedy(identity),
      );
    }
    recentFailures.delete(envDir);
    return python;
  })()
    .catch((err: unknown) => {
      const error = err instanceof Error ? err : new Error(String(err));
      recentFailures.set(envDir, { error, at: Date.now() });
      throw error;
    })
    .finally(() => {
      ensureInFlight.delete(envDir);
    });
  ensureInFlight.set(envDir, creating);
  return creating;
}
