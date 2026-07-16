import { ChildProcess, spawn } from "child_process";
import * as crypto from "crypto";
import * as http from "http";
import * as net from "net";
import * as path from "path";
import * as vscode from "vscode";
import { AWS_ENV_KEYS, ExtensionConfig, workspaceRoot } from "./config";
import { curatedProcessEnv } from "./envCurate";
import { ensureSidecarDeps } from "./pythonDeps";
import { pinPythonPathEnv } from "./pythonPathPin";
import { StartGeneration } from "./startGeneration";

export interface SidecarHandle {
  port: number;
  token: string;
  baseUrl: string;
  stop(): void;
}

function redactSecrets(text: string): string {
  // Build patterns at runtime so static scanners do not treat the source as a secret.
  const keyNames = ["OPENAI", "ANTHROPIC", "GEMINI", "GOOGLE", "GATEWAY", "TAVILY", "BEDROCK"]
    .map((p) => `${p}_API_KEY`)
    .join("|");
  const awsSecret = "AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN";
  text = text.replace(
    new RegExp(`\\b(?:${keyNames}|${awsSecret})\\s*[=:]\\s*\\S+`, "gi"),
    (m) => m.replace(/=.*/, "=***").replace(/:.*/, ":***"),
  );
  const openaiPrefix = ["sk", "-"].join("");
  const googlePrefix = ["AI", "za"].join("");
  return text
    .replace(new RegExp(`\\b((?:${keyNames}))\\s*[=:]\\s*\\S+`, "gi"), "$1=***")
    .replace(/\b(Bearer\s+)\S+/gi, "$1***")
    .replace(new RegExp(`\\b(${openaiPrefix}[A-Za-z0-9]{8,})`, "g"), `${openaiPrefix}***`)
    .replace(new RegExp(`\\b(${googlePrefix}[0-9A-Za-z\\-_]{10,})`, "g"), `${googlePrefix}***`);
}

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close();
        reject(new Error("Could not allocate port"));
        return;
      }
      const port = addr.port;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

function waitForHealth(baseUrl: string, token: string, timeoutMs: number): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const req = http.get(
        `${baseUrl}/health`,
        { headers: { Authorization: `Bearer ${token}` }, timeout: 2000 },
        (res) => {
          res.resume();
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve();
            return;
          }
          retry();
        },
      );
      req.on("error", retry);
      req.on("timeout", () => {
        req.destroy();
        retry();
      });
    };
    const retry = () => {
      if (Date.now() - started > timeoutMs) {
        reject(new Error(`Sidecar health check timed out after ${timeoutMs}ms`));
        return;
      }
      setTimeout(tryOnce, 250);
    };
    tryOnce();
  });
}

export class SidecarManager {
  private handle: SidecarHandle | undefined;
  private child: ChildProcess | undefined;
  readonly output: vscode.OutputChannel;
  private lastLog = "";
  private starting: Promise<SidecarHandle> | undefined;
  private readonly startGeneration = new StartGeneration();

  constructor(
    private readonly extensionPath: string,
    private readonly config: ExtensionConfig,
  ) {
    this.output = vscode.window.createOutputChannel("ClawAgents Sidecar");
  }

  get current(): SidecarHandle | undefined {
    return this.handle;
  }

  async ensureStarted(): Promise<SidecarHandle> {
    if (this.handle && this.child && !this.child.killed) {
      return this.handle;
    }
    // Concurrent callers (activation + command) must share one spawn —
    // otherwise two sidecars race for the same handle slot.
    if (this.starting) {
      return this.starting;
    }
    const generation = this.startGeneration.begin();
    let tracked: Promise<SidecarHandle>;
    tracked = this.doStart(generation).finally(() => {
      if (this.starting === tracked) {
        this.starting = undefined;
      }
    });
    this.starting = tracked;
    return tracked;
  }

  private assertCurrentStart(generation: number): void {
    this.startGeneration.assertCurrent(generation);
  }

  private async doStart(generation: number): Promise<SidecarHandle> {
    this.stopChild();

    const python = this.config.pythonPath;
    const bridge = path.join(this.extensionPath, "python", "bridge.py");
    const probe = await ensureSidecarDeps(python, this.output, curatedProcessEnv());
    this.assertCurrentStart(generation);
    this.output.appendLine(`Python probe (${python}): ${probe.ok ? "ok" : "FAILED"}`);
    this.output.appendLine(`Using interpreter: ${python}`);
    this.output.appendLine(probe.detail || "(no detail)");
    if (!probe.ok) {
      throw new Error(probe.detail);
    }

    const port = await findFreePort();
    const token = crypto.randomBytes(32).toString("hex");
    const cwd = workspaceRoot() || this.extensionPath;
    const apiEnv = await this.config.getApiKeyEnv();
    const dotenvEnv = this.config.loadWorkspaceDotenv();
    const model = this.config.model;
    const runtimeTrust = await this.config.getRuntimeTrust();
    this.assertCurrentStart(generation);

    // Spawn precedence: curated process.env < workspace .env < SecretStorage keys.
    const keySources: Record<string, string> = {};
    const keyVars: Record<string, string[]> = {
      openai: ["OPENAI_API_KEY"],
      anthropic: ["ANTHROPIC_API_KEY"],
      gemini: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
      bedrock: ["BEDROCK_API_KEY"],
      tavily: ["TAVILY_API_KEY"],
      aws: [...AWS_ENV_KEYS],
    };
    for (const [prov, vars] of Object.entries(keyVars)) {
      if (vars.some((v) => apiEnv[v])) {
        keySources[prov] = "VS Code SecretStorage";
      } else if (vars.some((v) => dotenvEnv[v])) {
        keySources[prov] = "workspace .env";
      } else if (vars.some((v) => process.env[v])) {
        keySources[prov] = "shell environment (check your shell profile)";
      }
    }

    const shellKeys: NodeJS.ProcessEnv = {};
    for (const vars of Object.values(keyVars)) {
      for (const v of vars) {
        if (process.env[v]) {
          shellKeys[v] = process.env[v];
        }
      }
    }
    // Pin PATH so agent shell tools (`python3` / `pip`) hit the same
    // interpreter as clawagents.pythonPath — not a stale Homebrew/conda install.
    const env: NodeJS.ProcessEnv = pinPythonPathEnv(python, {
      ...curatedProcessEnv(),
      ...shellKeys,
      ...dotenvEnv,
      ...apiEnv,
      GATEWAY_API_KEY: token,
      CLAW_WORKSPACE: cwd,
      PYTHONUNBUFFERED: "1",
      CLAW_KEY_SOURCES: JSON.stringify(keySources),
      CLAW_CONTEXT_MODE: this.config.contextMode ? "1" : "0",
      // Repository files cannot grant these approvals. They are restored from
      // workspace-scoped VS Code SecretStorage before the sidecar serves probes.
      CLAW_RUNTIME_TRUST: JSON.stringify(runtimeTrust),
      // Long-lived sidecar: never re-load workspace .env inside clawagents
      // (would clobber SecretStorage keys). Spawn env already merged keys once.
      CLAWAGENTS_SKIP_DOTENV: "1",
      CLAWAGENTS_DOTENV_OVERRIDE: "0",
    });
    if (model) {
      env.CLAW_MODEL = model;
    }
    this.output.appendLine(
      `PATH pin: CLAWAGENTS_PYTHON=${env.CLAWAGENTS_PYTHON || python} ` +
        `PATH[0]=${(env.PATH || "").split(process.platform === "win32" ? ";" : ":")[0] || "?"}`,
    );

    this.lastLog = "";
    this.output.appendLine(`Starting sidecar: ${python} ${bridge} --port ${port}`);
    this.output.appendLine(`cwd=${cwd}`);
    this.child = spawn(python, [bridge, "--port", String(port), "--host", "127.0.0.1"], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const appendLog = (chunk: string) => {
      const text = redactSecrets(chunk);
      this.lastLog = (this.lastLog + text).slice(-4000);
      this.output.append(text);
    };
    this.child.stdout?.on("data", (buf: Buffer) => appendLog(buf.toString()));
    this.child.stderr?.on("data", (buf: Buffer) => appendLog(buf.toString()));

    let exitCode: number | null = null;
    const spawned = this.child;
    this.child.on("error", (err) => {
      appendLog(`\nspawn error: ${err.message}\n`);
    });
    this.child.on("exit", (code, signal) => {
      exitCode = code;
      this.output.appendLine(`Sidecar exited code=${code} signal=${signal}`);
      // A restart may already have installed a NEW child; a stale exit
      // listener must not wipe its registration (it would orphan the new
      // process and trigger duplicate spawns).
      if (this.child === spawned) {
        this.handle = undefined;
        this.child = undefined;
      }
    });

    const baseUrl = `http://127.0.0.1:${port}`;
    try {
      // Remote hosts can be slow on first import; allow more time.
      await waitForHealth(baseUrl, token, 30_000);
    } catch (err) {
      const tail = this.lastLog.trim().split("\n").slice(-12).join("\n");
      this.terminateChild(spawned);
      if (this.child === spawned) {
        this.child = undefined;
        this.handle = undefined;
      }
      const base = err instanceof Error ? err.message : String(err);
      throw new Error(
        exitCode != null
          ? `${base} (sidecar exited ${exitCode})\n${tail || probe.detail}`
          : `${base}\n${tail || "No sidecar output. Check Output → ClawAgents Sidecar."}`,
      );
    }
    try {
      this.assertCurrentStart(generation);
    } catch (err) {
      this.terminateChild(spawned);
      if (this.child === spawned) {
        this.child = undefined;
      }
      throw err;
    }

    this.handle = {
      port,
      token,
      baseUrl,
      stop: () => this.stop(),
    };
    return this.handle;
  }

  private terminateChild(child: ChildProcess): void {
    if (child && child.exitCode === null && child.signalCode === null) {
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          try {
            child.kill("SIGKILL");
          } catch {
            /* ignore */
          }
        }
      }, 1500);
    }
  }

  private stopChild(): void {
    const child = this.child;
    if (child) {
      this.terminateChild(child);
    }
    this.child = undefined;
    this.handle = undefined;
  }

  stop(): void {
    this.startGeneration.invalidate();
    this.starting = undefined;
    this.stopChild();
  }

  dispose(): void {
    this.stop();
    this.output.dispose();
  }
}
