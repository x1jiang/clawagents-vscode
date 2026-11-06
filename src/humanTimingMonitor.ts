import * as path from "path";
import * as vscode from "vscode";
import { HumanTiming, type HumanTimingPolicy, type HumanTimingState } from "./humanTiming";

const STORAGE_KEY = "clawagents.humanTiming";
const CHECKPOINT_MS = 15_000;

type StoredTiming = { enabled: boolean; timing: HumanTimingState };

/** Routes VS Code, composer, and transcript events to the policy-independent timer. */
export class HumanTimingMonitor {
  readonly timer: HumanTiming;
  enabled: boolean;
  private listeners: vscode.Disposable[] = [];
  private checkpoint?: ReturnType<typeof setTimeout>;
  private viewFocused = false;
  private fileTarget?: { file: string; chatId: string; background: boolean };
  private editorFile?: string;
  private lastFilePulse = -Infinity;

  constructor(
    private readonly state: vscode.Memento,
    private readonly selectedChat: () => string | undefined,
    private readonly reportError: (message: string) => void,
    policy?: HumanTimingPolicy,
  ) {
    const saved = state.get<StoredTiming>(STORAGE_KEY);
    this.enabled = saved?.enabled !== false;
    this.timer = new HumanTiming(saved?.timing, policy);
  }

  listen(): void {
    if (!this.enabled || this.listeners.length) return;
    this.listeners = [
      vscode.window.onDidChangeWindowState(() => this.focusChanged()),
      vscode.window.onDidChangeActiveTextEditor(() => this.refreshFile()),
      vscode.window.tabGroups.onDidChangeTabs(() => this.refreshFile()),
      vscode.window.tabGroups.onDidChangeTabGroups(() => this.refreshFile()),
      vscode.window.onDidChangeTextEditorSelection((event) => {
        if (event.kind && event.kind !== vscode.TextEditorSelectionChangeKind.Command) {
          this.editorActivity(event.textEditor);
        }
      }),
      vscode.window.onDidChangeTextEditorVisibleRanges((event) => this.editorActivity(event.textEditor, "scroll")),
    ];
  }

  private editorActivity(editor: vscode.TextEditor, signal: "selection" | "scroll" = "selection"): void {
    if (editor !== vscode.window.activeTextEditor) return;
    const now = performance.now();
    if (this.fileTarget && now - this.lastFilePulse < 1000) return;
    this.refreshFile(signal);
  }

  private focusChanged(): void {
    if (this.fileTarget) this.fileTarget.background = false;
    this.refreshFile("focus");
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (enabled) {
      this.listen();
      this.refreshFile();
    } else {
      this.timer.stop();
      this.fileTarget = undefined;
      this.unlisten();
    }
    this.flush();
  }

  setViewFocused(focused: boolean): void {
    if (!focused) {
      this.timer.suspendInput();
      this.timer.suspendReading();
    }
    if (focused === this.viewFocused) return;
    this.viewFocused = focused;
    this.focusChanged();
  }

  input(chatId: string): void {
    if (!this.enabled || !vscode.window.state.focused) return;
    this.setViewFocused(true);
    this.pauseFile();
    this.timer.suspendReading();
    this.timer.pulse(chatId, "input");
    this.scheduleSave();
  }

  reading(chatId: string, background = false): void {
    if (!this.enabled || (!vscode.window.state.focused && !background)) return;
    if (!background) this.setViewFocused(true);
    this.pauseFile();
    this.timer.suspendInput();
    this.timer.pulse(chatId, "reading");
    this.scheduleSave();
  }

  pauseReading(): void {
    this.timer.suspendReading();
  }

  endInput(): void {
    this.timer.stop("input");
  }

  rememberFile(chatId: string, file: string): void {
    if (!this.enabled || !this.timer.rememberFile(chatId, path.normalize(file))) return;
    this.scheduleSave();
  }

  forgetChat(chatId: string): void {
    this.timer.forgetChat(chatId);
    this.refreshFile();
    this.scheduleSave();
  }

  private pauseFile(): void {
    if (!this.fileTarget) return;
    this.timer.suspendFile(this.fileTarget.file);
    this.fileTarget = undefined;
  }

  refreshFile(signal?: "focus" | "selection" | "scroll"): void {
    if (!this.enabled) return;
    const windowFocused = vscode.window.state.focused;
    if (!windowFocused) {
      this.timer.suspendInput();
      if (signal === "focus") this.timer.suspendReading();
    }
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    const input = tab?.input as { uri?: vscode.Uri; modified?: vscode.Uri } | undefined;
    const uri = input?.uri ?? input?.modified;
    const file = uri?.scheme === "file" || uri?.scheme === "vscode-remote"
      ? path.normalize(uri.fsPath) : undefined;
    if (file !== this.editorFile) {
      this.timer.stop("file");
      this.fileTarget = undefined;
      this.editorFile = file;
    }
    const chatId = file && this.timer.fileOwner(file, this.selectedChat());
    if (this.fileTarget && this.fileTarget.chatId !== chatId) {
      this.timer.stop("file");
      this.fileTarget = undefined;
    }
    const foreground = windowFocused && !this.viewFocused;
    const sameTarget = this.fileTarget?.file === file && this.fileTarget?.chatId === chatId;
    const background = !foreground && !this.timer.hasActiveInput() &&
      (signal === "scroll" || (sameTarget && this.fileTarget?.background));
    if (!file || !chatId || (!foreground && !background)) {
      this.pauseFile();
      return;
    }
    if (sameTarget && (signal === undefined || (!foreground && signal !== "scroll"))) return;
    this.timer.suspendReading();
    this.fileTarget = { file, chatId, background: Boolean(background) };
    this.timer.resumeFile(chatId, file);
    this.lastFilePulse = performance.now();
    this.scheduleSave();
  }

  scheduleSave(): void {
    if (this.checkpoint) return;
    this.checkpoint = setTimeout(() => this.flush(), CHECKPOINT_MS);
  }

  private flush(): void {
    clearTimeout(this.checkpoint);
    this.checkpoint = undefined;
    const { state, active } = this.timer.checkpoint();
    void this.state.update(STORAGE_KEY, { enabled: this.enabled, timing: state } satisfies StoredTiming)
      .then(undefined, (error: unknown) => this.reportError(String(error)));
    if (active) this.scheduleSave();
  }

  private unlisten(): void {
    for (const listener of this.listeners) listener.dispose();
    this.listeners = [];
  }

  dispose(): void {
    this.unlisten();
    this.timer.stop();
    if (this.checkpoint) this.flush();
  }
}
