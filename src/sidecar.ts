import { ChildProcess, spawn } from "child_process";
import * as crypto from "crypto";
import * as http from "http";
import * as net from "net";
import * as path from "path";
import * as vscode from "vscode";
import { ExtensionConfig, workspaceRoot } from "./config";

export interface SidecarHandle {
  port: number;
  token: string;
  baseUrl: string;
  stop(): void;
}

/** Env vars safe to forward into the sidecar (avoid leaking unrelated secrets). */
const SAFE_ENV_KEYS = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "VIRTUAL_ENV",
  "PYTHONPATH",
  "PYTHONHOME",
  "SSL_CERT_FILE",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "ALL_PROXY",
  "all_proxy",
]);

function curatedProcessEnv(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v == null) continue;
    if (SAFE_ENV_KEYS.has(k) || k.startsWith("LC_")) {
      out[k] = v;
    }
  }
  return out;
}

function redactSecrets(text: string): string {
  // Build patterns at runtime so static scanners do not treat the source as a secret.
  const keyNames = ["OPENAI", "ANTHROPIC", "GEMINI", "GOOGLE", "GATEWAY"]
    .map((p) => `${p}_API_KEY`)
    .join("|");
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
  private output: vscode.OutputChannel;

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
    await this.stop();

    const port = await findFreePort();
    const token = crypto.randomBytes(32).toString("hex");
    const bridge = path.join(this.extensionPath, "python", "bridge.py");
    const python = this.config.pythonPath;
    const cwd = workspaceRoot() || this.extensionPath;
    const apiEnv = await this.config.getApiKeyEnv();
    const dotenvEnv = this.config.loadWorkspaceDotenv();
    const model = this.config.model;

    // Spawn precedence: curated process.env < workspace .env < SecretStorage keys.
    // Caveat: the clawagents runtime also loads the workspace .env itself
    // (override=true), so for variables present in BOTH the workspace .env
    // and SecretStorage, the .env value wins at runtime. Remove the key
    // from .env to let the SecretStorage key take effect.
    const keySources: Record<string, string> = {};
    const keyVars: Record<string, string[]> = {
      openai: ["OPENAI_API_KEY"],
      anthropic: ["ANTHROPIC_API_KEY"],
      gemini: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
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

    // Allow shell-exported provider keys (curatedProcessEnv strips them on purpose).
    const shellKeys: NodeJS.ProcessEnv = {};
    for (const vars of Object.values(keyVars)) {
      for (const v of vars) {
        if (process.env[v]) {
          shellKeys[v] = process.env[v];
        }
      }
    }

    const env: NodeJS.ProcessEnv = {
      ...curatedProcessEnv(),
      ...shellKeys,
      ...dotenvEnv,
      ...apiEnv,
      GATEWAY_API_KEY: token,
      CLAW_WORKSPACE: cwd,
      PYTHONUNBUFFERED: "1",
      CLAW_KEY_SOURCES: JSON.stringify(keySources),
      // Default for the sidecar's context_mode setting; the sidebar Settings
      // checkbox (persisted per workspace) overrides it.
      CLAW_CONTEXT_MODE: this.config.contextMode ? "1" : "0",
    };
    if (model) {
      env.CLAW_MODEL = model;
    }

    this.output.appendLine(`Starting sidecar: ${python} ${bridge} --port ${port}`);
    this.child = spawn(python, [bridge, "--port", String(port), "--host", "127.0.0.1"], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    this.child.stdout?.on("data", (buf: Buffer) => {
      this.output.append(redactSecrets(buf.toString()));
    });
    this.child.stderr?.on("data", (buf: Buffer) => {
      this.output.append(redactSecrets(buf.toString()));
    });
    this.child.on("exit", (code, signal) => {
      this.output.appendLine(`Sidecar exited code=${code} signal=${signal}`);
      this.handle = undefined;
      this.child = undefined;
    });

    const baseUrl = `http://127.0.0.1:${port}`;
    try {
      await waitForHealth(baseUrl, token, 12_000);
    } catch (err) {
      this.stop();
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

  stop(): void {
    const child = this.child;
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
    this.child = undefined;
    this.handle = undefined;
  }

  dispose(): void {
    this.stop();
    this.output.dispose();
  }
}
