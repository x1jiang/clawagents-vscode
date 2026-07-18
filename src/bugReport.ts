import { spawn, spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { curatedProcessEnv } from "./envCurate";

export type BugScreenshot = {
  name: string;
  mediaType: string;
  data: string;
};

function whichSync(bin: string): string | undefined {
  const cmd = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(cmd, [bin], {
    encoding: "utf8",
    timeout: 5_000,
    env: process.env,
  });
  if (result.status !== 0) {
    return undefined;
  }
  return (result.stdout || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find(Boolean);
}

export function resolveAlpacaDeployRoot(extensionPath: string): string | undefined {
  const fromSetting = vscode.workspace
    .getConfiguration("clawagents")
    .get<string>("alpacaDeployPath", "")
    ?.trim();
  if (fromSetting && fs.existsSync(path.join(fromSetting, "utils", "helpers.py"))) {
    return fromSetting;
  }
  const fromEnv = (process.env.ALPACA_DEPLOY_ROOT || "").trim();
  if (fromEnv && fs.existsSync(path.join(fromEnv, "utils", "helpers.py"))) {
    return fromEnv;
  }
  const candidates = [
    path.resolve(extensionPath, "..", "..", "alpaca_deploy"),
    path.resolve(extensionPath, "..", "alpaca_deploy"),
    path.join(os.homedir(), "Dropbox", "cursor_projects", "mac", "alpaca_deploy"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, "utils", "helpers.py"))) {
      return c;
    }
  }
  return undefined;
}

/** Interactive region capture on macOS; file picker elsewhere. */
export async function captureBugScreenshot(): Promise<BugScreenshot | undefined> {
  if (process.platform === "darwin" && whichSync("screencapture")) {
    const out = path.join(
      os.tmpdir(),
      `clawagents-bug-${Date.now()}.png`,
    );
    const result = await new Promise<{ ok: boolean; detail: string }>((resolve) => {
      const child = spawn("screencapture", ["-x", "-i", out], {
        stdio: "ignore",
        env: process.env,
      });
      child.on("error", (err) => resolve({ ok: false, detail: err.message }));
      child.on("exit", (code) => {
        if (code === 0 && fs.existsSync(out)) {
          resolve({ ok: true, detail: out });
          return;
        }
        resolve({
          ok: false,
          detail: code === 1
            ? "Screenshot cancelled"
            : `screencapture exited ${code}`,
        });
      });
    });
    if (!result.ok) {
      if (result.detail !== "Screenshot cancelled") {
        void vscode.window.showWarningMessage(`Screenshot: ${result.detail}`);
      }
      return undefined;
    }
    try {
      const buf = fs.readFileSync(out);
      fs.unlinkSync(out);
      if (buf.length === 0 || buf.length > 12 * 1024 * 1024) {
        return undefined;
      }
      return {
        name: path.basename(out),
        mediaType: "image/png",
        data: buf.toString("base64"),
      };
    } catch (err) {
      void vscode.window.showErrorMessage(
        `Screenshot read failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return undefined;
    }
  }

  const uris = await vscode.window.showOpenDialog({
    canSelectMany: false,
    filters: { Images: ["png", "jpg", "jpeg", "webp", "gif"] },
    openLabel: "Attach screenshot",
  });
  if (!uris?.[0]) {
    return undefined;
  }
  const buf = fs.readFileSync(uris[0].fsPath);
  if (buf.length > 12 * 1024 * 1024) {
    void vscode.window.showErrorMessage("Screenshot too large (max 12 MiB)");
    return undefined;
  }
  const ext = path.extname(uris[0].fsPath).toLowerCase();
  const mediaType =
    ext === ".jpg" || ext === ".jpeg"
      ? "image/jpeg"
      : ext === ".webp"
        ? "image/webp"
        : ext === ".gif"
          ? "image/gif"
          : "image/png";
  return {
    name: path.basename(uris[0].fsPath),
    mediaType,
    data: buf.toString("base64"),
  };
}

export async function sendBugReportEmail(options: {
  python: string;
  extensionPath: string;
  text: string;
  screenshots: BugScreenshot[];
  output: { appendLine(s: string): void };
}): Promise<{ ok: boolean; detail: string }> {
  const script = path.join(options.extensionPath, "python", "bug_report_email.py");
  const alpaca = resolveAlpacaDeployRoot(options.extensionPath);
  if (!alpaca) {
    return {
      ok: false,
      detail:
        "alpaca_deploy not found. Set clawagents.alpacaDeployPath to the alpaca_deploy folder.",
    };
  }

  const payload = {
    text: options.text,
    screenshots: options.screenshots.slice(0, 6),
    meta: {
      vscode: `${vscode.env.appName} ${vscode.version}`,
      extension: vscode.extensions.getExtension("clawagents.clawagents")?.packageJSON
        ?.version,
      workspace: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || "",
      platform: `${process.platform} ${os.release()}`,
    },
  };

  options.output.appendLine(
    `Bug report → alpaca_deploy email (${alpaca}), screenshots=${payload.screenshots.length}`,
  );

  return await new Promise((resolve) => {
    const child = spawn(options.python, [script], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...curatedProcessEnv(),
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        USERPROFILE: process.env.USERPROFILE,
        ALPACA_DEPLOY_ROOT: alpaca,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (b: Buffer) => {
      stdout += b.toString();
    });
    child.stderr?.on("data", (b: Buffer) => {
      stderr += b.toString();
      for (const line of b.toString().split(/\r?\n/)) {
        if (line.trim()) {
          options.output.appendLine(line);
        }
      }
    });
    child.on("error", (err) => {
      resolve({ ok: false, detail: err.message });
    });
    child.on("exit", (code) => {
      try {
        const parsed = JSON.parse(stdout.trim().split(/\r?\n/).pop() || "{}") as {
          ok?: boolean;
          detail?: string;
        };
        resolve({
          ok: Boolean(parsed.ok),
          detail: parsed.detail || stderr.slice(-500) || `exit ${code}`,
        });
      } catch {
        resolve({
          ok: code === 0,
          detail: stdout.trim() || stderr.slice(-500) || `exit ${code}`,
        });
      }
    });
    child.stdin?.write(JSON.stringify(payload));
    child.stdin?.end();
  });
}
