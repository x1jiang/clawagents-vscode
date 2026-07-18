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

export type BugReportMeta = {
  vscode: string;
  extension?: string;
  workspace: string;
  platform: string;
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

function smtpEnvFromSettings(): Record<string, string> {
  const cfg = vscode.workspace.getConfiguration("clawagents");
  const out: Record<string, string> = {};
  const map: Array<[string, string]> = [
    ["bugReportSmtpServer", "EMAIL_SMTP_SERVER"],
    ["bugReportSmtpPort", "EMAIL_SMTP_PORT"],
    ["bugReportEmailSender", "EMAIL_SENDER"],
    ["bugReportEmailTo", "CLAWAGENTS_BUG_REPORT_EMAIL"],
  ];
  for (const [settingKey, envKey] of map) {
    const value = cfg.get<string>(settingKey, "")?.trim();
    if (value) {
      out[envKey] = value;
    }
  }
  return out;
}

function smtpEnvFromProcess(): Record<string, string> {
  const keys = [
    "EMAIL_PASSWORD",
    "EMAIL_SENDER",
    "EMAIL_SMTP_SERVER",
    "EMAIL_SMTP_PORT",
    "EMAIL_ENABLED",
    "CLAWAGENTS_BUG_REPORT_EMAIL",
    "ALPACA_DEPLOY_ROOT",
  ];
  const out: Record<string, string> = {};
  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (value) {
      out[key] = value;
    }
  }
  return out;
}

function hasSmtpCredentials(env: Record<string, string>): boolean {
  return Boolean(env.EMAIL_PASSWORD?.trim());
}

export function buildBugReportMeta(): BugReportMeta {
  return {
    vscode: `${vscode.env.appName} ${vscode.version}`,
    extension: vscode.extensions.getExtension("clawagents.clawagents")?.packageJSON?.version,
    workspace: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || "",
    platform: `${process.platform} ${os.release()}`,
  };
}

export function formatBugReportBody(
  text: string,
  meta: BugReportMeta,
  screenshots: BugScreenshot[] = [],
): string {
  const lines = [
    "ClawAgents bug report",
    "=".repeat(40),
    text.trim(),
    "",
    "— Meta —",
    `vscode: ${meta.vscode}`,
  ];
  if (meta.extension) {
    lines.push(`extension: ${meta.extension}`);
  }
  if (meta.workspace) {
    lines.push(`workspace: ${meta.workspace}`);
  }
  lines.push(`platform: ${meta.platform}`);
  if (screenshots.length > 0) {
    lines.push("");
    lines.push(
      `— Attachments (${screenshots.length}) —`,
      ...screenshots.map((s, i) => `${i + 1}. ${s.name} (${s.mediaType})`),
      "Re-attach screenshots manually if email SMTP was unavailable.",
    );
  }
  return lines.join("\n");
}

function resolveMailtoRecipient(): string {
  const cfg = vscode.workspace.getConfiguration("clawagents");
  return (
    cfg.get<string>("bugReportEmailTo", "")?.trim() ||
    process.env.CLAWAGENTS_BUG_REPORT_EMAIL?.trim() ||
    process.env.EMAIL_SENDER?.trim() ||
    ""
  );
}

export async function submitBugReportFallback(options: {
  text: string;
  screenshots: BugScreenshot[];
  smtpError: string;
}): Promise<{ ok: boolean; detail: string }> {
  const meta = buildBugReportMeta();
  const body = formatBugReportBody(options.text, meta, options.screenshots);
  await vscode.env.clipboard.writeText(body);

  const subjectShort = options.text.slice(0, 72).replace(/\n/g, " ").trim() || "bug report";
  const subject = encodeURIComponent(`[ClawAgents-bug-report] ${subjectShort}`);
  const bodyEnc = encodeURIComponent(body.slice(0, 1800));
  const to = encodeURIComponent(resolveMailtoRecipient());
  const mailto = to
    ? `mailto:${to}?subject=${subject}&body=${bodyEnc}`
    : `mailto:?subject=${subject}&body=${bodyEnc}`;
  await vscode.env.openExternal(vscode.Uri.parse(mailto));

  const shotNote =
    options.screenshots.length > 0
      ? ` Attach ${options.screenshots.length} screenshot(s) manually in your mail client.`
      : "";
  return {
    ok: true,
    detail: `SMTP unavailable (${options.smtpError}). Report copied to clipboard and opened in your mail client.${shotNote}`,
  };
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
}): Promise<{ ok: boolean; detail: string; usedFallback?: boolean }> {
  const script = path.join(options.extensionPath, "python", "bug_report_email.py");
  const alpaca = resolveAlpacaDeployRoot(options.extensionPath);
  const smtpEnv = {
    ...smtpEnvFromProcess(),
    ...smtpEnvFromSettings(),
    ...(alpaca ? { ALPACA_DEPLOY_ROOT: alpaca } : {}),
  };

  if (!hasSmtpCredentials(smtpEnv) && !alpaca) {
    return submitBugReportFallback({
      text: options.text,
      screenshots: options.screenshots,
      smtpError: "SMTP not configured",
    }).then((r) => ({ ...r, usedFallback: true }));
  }

  const meta = buildBugReportMeta();
  const payload = {
    text: options.text,
    screenshots: options.screenshots.slice(0, 6),
    meta,
  };

  const via = hasSmtpCredentials(smtpEnv)
    ? smtpEnv.ALPACA_DEPLOY_ROOT
      ? `SMTP via env/settings (+ optional ${smtpEnv.ALPACA_DEPLOY_ROOT})`
      : "SMTP via env/settings"
    : alpaca
      ? `alpaca_deploy (${alpaca})`
      : "SMTP";
  options.output.appendLine(
    `Bug report email (${via}), screenshots=${payload.screenshots.length}`,
  );

  const emailResult = await new Promise<{ ok: boolean; detail: string }>((resolve) => {
    const child = spawn(options.python, [script], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...curatedProcessEnv(),
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        USERPROFILE: process.env.USERPROFILE,
        ...smtpEnv,
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

  if (emailResult.ok) {
    return emailResult;
  }

  const fallback = await submitBugReportFallback({
    text: options.text,
    screenshots: options.screenshots,
    smtpError: emailResult.detail,
  });
  return { ...fallback, usedFallback: true };
}
