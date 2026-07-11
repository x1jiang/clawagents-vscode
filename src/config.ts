import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

const SECRET_KEYS = {
  openai: "clawagents.openaiApiKey",
  anthropic: "clawagents.anthropicApiKey",
  gemini: "clawagents.geminiApiKey",
} as const;

/** Strip paste junk so keys are safe for HTTP headers (latin-1) and env. */
export function sanitizeApiKey(raw: string): string {
  let text = (raw || "")
    .replace(/^\uFEFF/, "")
    .replace(/[\u200B-\u200D\u2060]/g, "")
    .trim();
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'"))
  ) {
    text = text.slice(1, -1).trim();
  }
  const eq = text.indexOf("=");
  if (eq > 0 && /key$/i.test(text.slice(0, eq).trim())) {
    text = text.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
  }
  // API keys are ASCII; drop anything that would break urllib header encoding.
  text = [...text].filter((ch) => ch.charCodeAt(0) < 128).join("").trim();
  return text;
}

export type ProviderKind = keyof typeof SECRET_KEYS | "auto";
export type AgentMode = "ask" | "read_only" | "auto" | "full_access";

/**
 * Resolve a usable Python executable. Remote hosts often have a stale
 * clawagents.pythonPath (e.g. /usr/local/bin/python3) that does not exist;
 * fall back to common locations before spawn fails obscurely.
 */
export function resolvePythonExecutable(configured: string): string {
  const candidates: string[] = [];
  const push = (p?: string) => {
    const t = (p || "").trim();
    if (t && !candidates.includes(t)) {
      candidates.push(t);
    }
  };
  push(configured);
  if (process.platform !== "win32") {
    push("python3");
    push("/usr/bin/python3");
    push("/bin/python3");
  } else {
    push("python");
    push("py");
  }

  for (const candidate of candidates) {
    if (path.isAbsolute(candidate)) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
      continue;
    }
    // Bare command name — prefer PATH resolution via `which` / `where`.
    try {
      const finder = process.platform === "win32" ? "where" : "which";
      const result = spawnSync(finder, [candidate], { encoding: "utf8" });
      const resolved = (result.stdout || "")
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => l && fs.existsSync(l));
      if (resolved) {
        return resolved;
      }
    } catch {
      /* ignore */
    }
  }
  return configured.trim() || candidates[0] || "python3";
}

/** Bare interpreter names safe even from workspace settings. */
const SAFE_PYTHON_NAMES = new Set(["python", "python3", "py"]);

/**
 * Prefer User / Remote (global) pythonPath. Workspace may only set bare
 * python/python3/py — absolute paths from .vscode/settings.json are ignored
 * (malicious repos can point at a fake interpreter).
 */
export function trustedPythonPathSetting(): string {
  const inspected = vscode.workspace
    .getConfiguration("clawagents")
    .inspect<string>("pythonPath");
  const fallback = process.platform === "win32" ? "python" : "python3";
  const global = (inspected?.globalValue || "").trim();
  if (global) {
    return global;
  }
  const workspace =
    (inspected?.workspaceValue || inspected?.workspaceFolderValue || "").trim();
  if (workspace) {
    if (SAFE_PYTHON_NAMES.has(workspace)) {
      return workspace;
    }
    void vscode.window.showWarningMessage(
      `Ignored workspace clawagents.pythonPath ("${workspace}"). ` +
        "Set an absolute interpreter path in User or Remote settings instead.",
    );
  }
  return (inspected?.defaultValue || "").trim() || fallback;
}

/**
 * Keys allowed from workspace `.env` into the sidecar. Anything else
 * (PYTHONSTARTUP, PYTHONPATH, LD_PRELOAD, …) is dropped — a malicious repo
 * `.env` must not run code or rewrite the interpreter search path on start.
 */
export const DOTENV_ALLOWLIST = new Set([
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_GENAI_API_KEY",
  // Intentionally omit OPENAI_BASE_URL / ANTHROPIC_BASE_URL / etc. — those
  // redirect API keys. Set base_url in ClawAgents Settings (with trust prompt).
  "CLAW_MODEL",
]);

const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isSafeId(value: string): boolean {
  return SAFE_ID_RE.test(value) && !value.includes("..");
}

/** Join parts under root; return null if the result escapes root (symlink-aware). */
export function pathUnderRoot(root: string, ...parts: string[]): string | null {
  const base = path.resolve(root);
  const target = path.resolve(base, ...parts);
  if (target === base || target.startsWith(base + path.sep)) {
    return target;
  }
  return null;
}

/** Empty / loopback / unix-socket-style base URLs are trusted for API keys. */
export function isTrustedBaseUrl(raw: string): boolean {
  const text = (raw || "").trim();
  if (!text) {
    return true;
  }
  try {
    const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(text) ? text : `http://${text}`;
    const u = new URL(withScheme);
    const host = (u.hostname || "").toLowerCase();
    return (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "::1" ||
      host === "[::1]" ||
      host === "0.0.0.0"
    );
  } catch {
    return false;
  }
}

export class ExtensionConfig {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  get pythonPath(): string {
    return resolvePythonExecutable(trustedPythonPathSetting());
  }

  get model(): string {
    return vscode.workspace.getConfiguration("clawagents").get<string>("model") || "";
  }

  get provider(): ProviderKind {
    return (
      vscode.workspace.getConfiguration("clawagents").get<ProviderKind>("provider") ||
      "auto"
    );
  }

  get defaultMode(): AgentMode {
    return (
      vscode.workspace.getConfiguration("clawagents").get<AgentMode>("defaultMode") ||
      "auto"
    );
  }

  get includeContextByDefault(): boolean {
    return (
      vscode.workspace.getConfiguration("clawagents").get<boolean>("includeContextByDefault") ??
      true
    );
  }

  get contextMode(): boolean {
    return (
      vscode.workspace.getConfiguration("clawagents").get<boolean>("contextMode") ?? true
    );
  }

  async hasAnyApiKey(): Promise<boolean> {
    const env = await this.getApiKeyEnv();
    return Boolean(env.OPENAI_API_KEY || env.ANTHROPIC_API_KEY || env.GEMINI_API_KEY || env.GOOGLE_API_KEY);
  }

  async getApiKeyEnv(): Promise<Record<string, string>> {
    const env: Record<string, string> = {};
    const openai = sanitizeApiKey((await this.secrets.get(SECRET_KEYS.openai)) || "");
    const anthropic = sanitizeApiKey((await this.secrets.get(SECRET_KEYS.anthropic)) || "");
    const gemini = sanitizeApiKey((await this.secrets.get(SECRET_KEYS.gemini)) || "");
    if (openai) {
      env.OPENAI_API_KEY = openai;
    }
    if (anthropic) {
      env.ANTHROPIC_API_KEY = anthropic;
    }
    if (gemini) {
      env.GOOGLE_API_KEY = gemini;
      env.GEMINI_API_KEY = gemini;
    }
    return env;
  }

  /**
   * Load workspace `.env` (allowlisted keys only) so API keys in the file
   * can override stale shell keys — without forwarding injection vectors.
   */
  loadWorkspaceDotenv(): Record<string, string> {
    const root = workspaceRoot();
    if (!root) {
      return {};
    }
    const envPath = path.join(root, ".env");
    if (!fs.existsSync(envPath)) {
      return {};
    }
    const out: Record<string, string> = {};
    const text = fs.readFileSync(envPath, "utf8");
    for (const raw of text.split(/\r?\n/)) {
      let line = raw.trim();
      if (!line || line.startsWith("#")) {
        continue;
      }
      if (line.startsWith("export ")) {
        line = line.slice(7).trim();
      }
      const eq = line.indexOf("=");
      if (eq <= 0) {
        continue;
      }
      const key = line.slice(0, eq).trim();
      if (!DOTENV_ALLOWLIST.has(key)) {
        continue;
      }
      let val = line.slice(eq + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      out[key] = val;
    }
    return out;
  }

  async setApiKey(provider: keyof typeof SECRET_KEYS, value: string): Promise<void> {
    const cleaned = sanitizeApiKey(value);
    if (!cleaned) {
      throw new Error("API key is empty after removing whitespace/non-ASCII characters.");
    }
    await this.secrets.store(SECRET_KEYS[provider], cleaned);
  }

  /** Prompt for a provider + key. Returns the provider label when saved. */
  async promptSetApiKey(): Promise<string | undefined> {
    const provider = await vscode.window.showQuickPick(
      [
        { label: "OpenAI", id: "openai" as const },
        { label: "Anthropic", id: "anthropic" as const },
        { label: "Gemini", id: "gemini" as const },
      ],
      { title: "Which provider API key?" },
    );
    if (!provider) {
      return undefined;
    }
    const value = await vscode.window.showInputBox({
      title: `ClawAgents ${provider.label} API key`,
      password: true,
      ignoreFocusOut: true,
      prompt: "Stored in VS Code SecretStorage and passed to the Python sidecar.",
    });
    if (value) {
      await this.setApiKey(provider.id, value);
      void vscode.window.showInformationMessage(`${provider.label} API key saved.`);
      return provider.label;
    }
    return undefined;
  }
}

export function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/** Last focused editor/terminal — webview clicks clear `activeTextEditor`. */
let _lastEditor: vscode.TextEditor | undefined = vscode.window.activeTextEditor;
let _lastTerminal: vscode.Terminal | undefined = vscode.window.activeTerminal;

export function trackEditorFocus(disposables: vscode.Disposable[]): void {
  if (vscode.window.activeTextEditor) {
    _lastEditor = vscode.window.activeTextEditor;
  }
  if (vscode.window.activeTerminal) {
    _lastTerminal = vscode.window.activeTerminal;
  }
  disposables.push(
    vscode.window.onDidChangeActiveTextEditor((ed) => {
      if (ed) {
        _lastEditor = ed;
      }
    }),
    vscode.window.onDidChangeActiveTerminal((term) => {
      if (term) {
        _lastTerminal = term;
      }
    }),
    vscode.window.onDidCloseTerminal((term) => {
      if (_lastTerminal === term) {
        _lastTerminal = vscode.window.activeTerminal ?? vscode.window.terminals[0];
      }
    }),
  );
}

function resolvedEditor(): vscode.TextEditor | undefined {
  return vscode.window.activeTextEditor ?? _lastEditor;
}

function resolvedTerminal(): vscode.Terminal | undefined {
  return vscode.window.activeTerminal ?? _lastTerminal ?? vscode.window.terminals[0];
}

export function buildEditorContext(): string {
  const parts: string[] = [];
  const editor = resolvedEditor();
  if (editor) {
    const rel = vscode.workspace.asRelativePath(editor.document.uri);
    const sel = editor.document.getText(editor.selection);
    const line = editor.selection.active.line + 1;
    parts.push(`Active file: ${rel}:${line}`);
    if (sel.trim()) {
      parts.push(`Selected text:\n\`\`\`${rel}\n${sel}\n\`\`\``);
    } else {
      const start = Math.max(0, editor.selection.active.line - 20);
      const end = Math.min(editor.document.lineCount, editor.selection.active.line + 21);
      const snippet = editor.document.getText(new vscode.Range(start, 0, end, 0));
      parts.push(`Nearby code (±20 lines):\n\`\`\`${rel}\n${snippet}\n\`\`\``);
    }
  }

  const open = vscode.window.visibleTextEditors
    .map((e) => vscode.workspace.asRelativePath(e.document.uri))
    .filter((v, i, a) => a.indexOf(v) === i)
    .slice(0, 8);
  if (open.length) {
    parts.push(`Open editors:\n- ${open.join("\n- ")}`);
  }
  return parts.join("\n\n");
}

export async function buildProblemsContext(): Promise<string> {
  const diags = vscode.languages.getDiagnostics();
  const lines: string[] = [];
  for (const [uri, list] of diags) {
    const errors = list
      .filter(
        (d) =>
          d.severity === vscode.DiagnosticSeverity.Error ||
          d.severity === vscode.DiagnosticSeverity.Warning,
      )
      .slice(0, 12);
    if (!errors.length) {
      continue;
    }
    const rel = vscode.workspace.asRelativePath(uri);
    for (const d of errors) {
      const line = d.range.start.line + 1;
      const sev = d.severity === vscode.DiagnosticSeverity.Error ? "error" : "warn";
      lines.push(`- [${sev}] ${rel}:${line} ${d.message}`);
    }
    if (lines.length >= 30) {
      break;
    }
  }
  if (!lines.length) {
    return "No workspace errors/warnings reported by the language service.";
  }
  return `Workspace problems:\n${lines.join("\n")}`;
}

export async function buildTerminalContext(): Promise<string> {
  const terminal = resolvedTerminal();
  if (!terminal) {
    return "No active terminal.";
  }

  // Shell Integration: copy last command output (VS Code / Cursor).
  // Restore clipboard afterward so we don't clobber the user's paste buffer.
  try {
    const before = await vscode.env.clipboard.readText();
    terminal.show(/* preserveFocus */ true);
    await vscode.commands.executeCommand("workbench.action.terminal.copyLastCommandOutput");
    await new Promise((r) => setTimeout(r, 80));
    const after = await vscode.env.clipboard.readText();
    if (after && after !== before && after.trim()) {
      try {
        await vscode.env.clipboard.writeText(before);
      } catch {
        /* ignore */
      }
      const clipped = after.length > 8000 ? `${after.slice(0, 8000)}\n…(truncated)` : after;
      return `Active terminal: ${terminal.name}\nLast command output:\n\`\`\`\n${clipped}\n\`\`\``;
    }
    try {
      await vscode.env.clipboard.writeText(before);
    } catch {
      /* ignore */
    }
  } catch {
    /* command may be missing without shell integration */
  }

  const si = (terminal as { shellIntegration?: { cwd?: vscode.Uri } }).shellIntegration;
  const cwd = si?.cwd?.fsPath;
  return [
    `Active terminal: ${terminal.name}`,
    cwd ? `CWD: ${cwd}` : undefined,
    "(No last-command output available. Enable Terminal Shell Integration, run a command, then try +Term again — or paste output manually.)",
  ]
    .filter(Boolean)
    .join("\n");
}

function findGitRoot(start: string): string | undefined {
  let dir = start;
  for (let i = 0; i < 40; i++) {
    if (fs.existsSync(path.join(dir, ".git"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return undefined;
}

export async function buildGitContext(): Promise<string> {
  const editor = resolvedEditor();
  const fromFile = editor ? findGitRoot(path.dirname(editor.document.uri.fsPath)) : undefined;
  const root = workspaceRoot() || fromFile;
  const gitRoot = root ? findGitRoot(root) || root : fromFile;
  if (!gitRoot) {
    return "No git repository found (open a folder or a file inside a repo).";
  }
  try {
    const { execFile } = await import("child_process");
    const { promisify } = await import("util");
    const execFileAsync = promisify(execFile);
    const [{ stdout: status }, { stdout: diff }] = await Promise.all([
      execFileAsync("git", ["status", "--short", "--branch"], {
        cwd: gitRoot,
        timeout: 5000,
      }),
      execFileAsync("git", ["diff", "--stat", "HEAD"], {
        cwd: gitRoot,
        timeout: 5000,
      }).catch(() => ({ stdout: "" })),
    ]);
    const statusText = status.trim() || "(clean working tree)";
    const diffText = diff.trim();
    const parts = [
      `Git repo: ${gitRoot}`,
      `Status:\n\`\`\`\n${statusText.slice(0, 4000)}\n\`\`\``,
    ];
    if (diffText) {
      parts.push(`Diff stat:\n\`\`\`\n${diffText.slice(0, 2000)}\n\`\`\``);
    }
    return parts.join("\n");
  } catch {
    return `Git status unavailable in ${gitRoot}.`;
  }
}

export function wrapSelectionBlock(): string | undefined {
  const editor = resolvedEditor();
  if (!editor) {
    return undefined;
  }
  const text = editor.document.getText(editor.selection);
  const rel = vscode.workspace.asRelativePath(editor.document.uri);
  if (text.trim()) {
    return `Selected from \`${rel}\`:\n\`\`\`${rel}\n${text}\n\`\`\`\n\n`;
  }
  // No selection — insert nearby lines so +Sel still does something useful.
  const line = editor.selection.active.line;
  const start = Math.max(0, line - 20);
  const end = Math.min(editor.document.lineCount, line + 21);
  const snippet = editor.document.getText(new vscode.Range(start, 0, end, 0));
  return `Nearby code from \`${rel}\` (line ${line + 1}, ±20):\n\`\`\`${rel}\n${snippet}\n\`\`\`\n\n`;
}

export function formatFileRef(rel: string, line?: number): string {
  const target = line && line > 0 ? `${rel}:${line}` : rel;
  // Path only — agent should read the file with tools (saves tokens).
  return `@${target}\n`;
}

export function wrapCurrentFileRef(): string | undefined {
  const editor = resolvedEditor();
  if (!editor) {
    return undefined;
  }
  const rel = vscode.workspace.asRelativePath(editor.document.uri);
  const line = editor.selection.active.line + 1;
  return formatFileRef(rel, line);
}

