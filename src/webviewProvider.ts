import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import {
  buildEditorContext,
  buildGitContext,
  buildProblemsContext,
  buildTerminalContext,
  ExtensionConfig,
  formatFileRef,
  isSafeId,
  isTrustedBaseUrl,
  pathUnderRoot,
  workspaceRoot,
  wrapCurrentFileRef,
  wrapSelectionBlock,
} from "./config";
import { GatewayClient, isSidecarTransportError } from "./gatewayClient";
import {
  decodeLocalAttachment,
  detectDocumentMediaType,
  detectImageMediaType,
  safeLocalAttachmentName,
} from "./localAttachments";
import { captureBugScreenshot, sendBugReportEmail } from "./bugReport";
import { hostDictation } from "./hostDictation";
import { ensureCompanions } from "./companionDeps";
import {
  adoptUpstreamGraph,
  getGraphifyStatus,
  openGraphifyFolder,
  runGraphifyMode,
} from "./graphifyOps";
import { parseWebviewToHost } from "./protocol";
import type {
  AgentMode,
  AutoApprove,
  ChatSummary,
  HostToWebview,
  InteractionStyle,
  WebviewToHost,
} from "./protocol";
import { AutoOpenScheduler } from "./autoOpenFiles";
import { SidecarManager } from "./sidecar";

export const SIDEBAR_ID = "clawagents.sidebar";
export const SIDEBAR_ACTIVITY_ID = "clawagents.sidebarActivity";
const STATE_KEY = "clawagents.chatState.v2";

const DEFAULT_AUTO_APPROVE: AutoApprove = {
  edit: true,
  execute: true,
  web: false,
  browser: false,
};

/** Image file extension → MIME type for chat attachments. */
const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};
const MAX_PENDING_IMAGES = 8;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** Document extension → MIME type for chat attachments. PDFs reach the model
 *  natively; .docx is text-extracted by the core. Legacy .doc is not
 *  parseable and stays a plain @path ref. */
const DOC_MIME: Record<string, string> = {
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};
const MAX_PENDING_FILES = 4;
const MAX_FILE_ATTACH_BYTES = 10 * 1024 * 1024;

/** Warn once per session about a non-local base_url from workspace settings. */
let warnedUntrustedBaseUrl = false;

async function warnUntrustedBaseUrl(settings: Record<string, unknown>): Promise<void> {
  if (warnedUntrustedBaseUrl) {
    return;
  }
  const baseUrl = typeof settings.base_url === "string" ? settings.base_url.trim() : "";
  if (!baseUrl || isTrustedBaseUrl(baseUrl)) {
    return;
  }
  warnedUntrustedBaseUrl = true;
  void vscode.window.showWarningMessage(
    `ClawAgents base URL "${baseUrl}" is not localhost — API keys will be sent there. Clear it in Settings if you did not set this.`,
  );
}

type PersistedState = {
  draft: string;
  mode: AgentMode;
  chatId?: string;
  autoApprove?: AutoApprove;
  interaction?: InteractionStyle;
  caveman?: boolean;
  goal?: boolean;
};


function sessionCostFromChat(chat: Record<string, unknown> | undefined): number | undefined {
  if (!chat) return undefined;
  const v = chat.session_cost_usd ?? chat.sessionCostUsd;
  return typeof v === "number" ? v : undefined;
}

export class ClawAgentsWebviewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = SIDEBAR_ID;

  private view?: vscode.WebviewView;
  private abort?: AbortController;
  private chatId: string | undefined;
  /** Absolute UI-log offset of the oldest event currently shown (for load-older). */
  private eventsOffset = 0;
  private eventsHasMore = false;
  private mode: AgentMode;
  private interaction: InteractionStyle = "interactive";
  private caveman = true;
  private goalMode = false;
  private autoApprove: AutoApprove = DEFAULT_AUTO_APPROVE;
  private queue: string[] = [];
  /** True while Stop is clearing/promoting stranded redirects. */
  private cancelling = false;
  /** Image attachments staged for the next send (base64 stays host-side). */
  private pendingImages: Array<{ id: string; name: string; data: string; mediaType: string }> = [];
  /** File attachments (PDF/DOCX) staged for the next send — same contract. */
  private pendingFiles: Array<{ id: string; name: string; data: string; mediaType: string }> = [];
  private readonly gateway: GatewayClient;
  /** Serialize settings saves — concurrent autosaves + live /providers probes
   *  stampeded the sidecar (root cause of ETIMEDOUT / EADDRNOTAVAIL). */
  private saveSettingsChain: Promise<void> = Promise.resolve();
  /** Debounced auto-open of agent-edited files (avoid focus thrash). */
  private readonly autoOpen = new AutoOpenScheduler(
    (filePath) => {
      void this.openPath(filePath, undefined, { quiet: true });
    },
    (message) => this.sidecar.output.appendLine(message),
  );

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly sidecar: SidecarManager,
    private readonly config: ExtensionConfig,
  ) {
    hostDictation.configure(context.extensionPath, context.globalState);
    this.gateway = new GatewayClient(() => this.sidecar.current);
    this.mode = this.config.defaultMode;
    // Chats live under the workspace's .clawagents dir, so the pointer to
    // the active chat must be workspace-scoped too.
    const saved = context.workspaceState.get<PersistedState>(STATE_KEY);
    const cavemanMigrated = Boolean(
      context.workspaceState.get<boolean>("clawagents.migratedCavemanDefaultOn"),
    );
    if (saved) {
      this.mode = saved.mode || this.mode;
      this.chatId = saved.chatId;
      if (saved.autoApprove) {
        this.autoApprove = { ...DEFAULT_AUTO_APPROVE, ...saved.autoApprove };
      }
      if (saved.interaction === "interactive" || saved.interaction === "auto") {
        this.interaction = saved.interaction;
      }
      if (typeof saved.goal === "boolean") {
        this.goalMode = saved.goal;
      }
    }
    // Default caveman ON. One-time migrate so prior persisted `false` flips up;
    // after that, the user's toggle is respected.
    if (!cavemanMigrated) {
      this.caveman = true;
      void context.workspaceState.update("clawagents.migratedCavemanDefaultOn", true);
    } else if (saved && typeof saved.caveman === "boolean") {
      this.caveman = saved.caveman;
    }
    // Plan is always interactive.
    if (this.mode === "read_only") {
      this.interaction = "interactive";
    }
  }

  private persistState(draft = ""): PersistedState {
    return {
      draft,
      mode: this.mode,
      chatId: this.chatId,
      autoApprove: this.autoApprove,
      interaction: this.interaction,
      caveman: this.caveman,
      goal: this.goalMode,
    };
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.file(path.join(this.context.extensionPath, "webview", "dist")),
        vscode.Uri.file(path.join(this.context.extensionPath, "media")),
      ],
    };
    webviewView.webview.html = this.getHtml(webviewView.webview);
    webviewView.webview.onDidReceiveMessage((raw: unknown) => {
      const msg = parseWebviewToHost(raw);
      if (!msg) {
        this.post({ type: "error", message: "Rejected an invalid webview request." });
        return;
      }
      void this.handleMessage(msg);
    });
    webviewView.onDidChangeVisibility(() => {
      if (!webviewView.visible) {
        this.post({ type: "view_hidden" } as HostToWebview);
      }
    });
  }

  post(msg: HostToWebview): void {
    void this.view?.webview.postMessage(msg);
  }

  /** Push Graphify companion status into the webview Settings panel. */
  postGraphifyStatus(data: Record<string, unknown>): void {
    this.post({ type: "graphify_status", data });
  }

  private async handleGraphifyAction(
    action:
      | "status"
      | "extract_code"
      | "extract_full"
      | "update"
      | "adopt_upstream"
      | "ensure"
      | "open_folder",
  ): Promise<void> {
    const python = this.config.pythonPath;
    const out = this.sidecar.output;
    try {
      if (action === "ensure") {
        await ensureCompanions(out, { force: true, python });
      } else if (action === "extract_code") {
        await runGraphifyMode(python, "extract_code", out);
      } else if (action === "extract_full") {
        await runGraphifyMode(python, "extract_full", out);
      } else if (action === "update") {
        await runGraphifyMode(python, "update", out);
      } else if (action === "adopt_upstream") {
        await adoptUpstreamGraph(out);
      } else if (action === "open_folder") {
        await openGraphifyFolder();
      }
      // Prefer sidecar status when running; fall back to host filesystem probe.
      try {
        const remote = await this.gateway.getGraphifyStatus();
        this.postGraphifyStatus(remote as Record<string, unknown>);
      } catch {
        this.postGraphifyStatus(getGraphifyStatus(python) as unknown as Record<string, unknown>);
      }
    } catch (err) {
      this.post({
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async postChatRestore(
    chatId: string,
    chat: Record<string, unknown>,
    draft = "",
    chatTitle?: string,
  ): Promise<void> {
    const events = (chat.events as Array<Record<string, unknown>>) || [];
    this.eventsOffset = Number(chat.events_offset ?? 0) || 0;
    this.eventsHasMore = Boolean(chat.events_has_more);
    const title =
      (typeof chatTitle === "string" && chatTitle.trim()) ||
      (typeof chat.title === "string" ? chat.title : undefined);
    this.post({
      type: "restore",
      items: eventsToItems(events),
      draft,
      mode: (chat.mode as AgentMode) || this.mode,
      chatId,
      chatTitle: title,
      autoApprove: this.autoApprove,
      interaction: this.interaction,
      caveman: this.caveman,
      goal: this.goalMode,
      sessionCostUsd: sessionCostFromChat(chat),
      eventsOffset: this.eventsOffset,
      eventsTotal: Number(chat.events_total ?? events.length) || events.length,
      eventsHasMore: this.eventsHasMore,
    });
  }

  private async loadOlderChatEvents(): Promise<void> {
    if (!this.chatId || !this.eventsHasMore || this.eventsOffset <= 0) {
      return;
    }
    const chat = await this.gateway.getChat(this.chatId, {
      before: this.eventsOffset,
      tail: 400,
    });
    const events = (chat.events as Array<Record<string, unknown>>) || [];
    this.eventsOffset = Number(chat.events_offset ?? 0) || 0;
    this.eventsHasMore = Boolean(chat.events_has_more);
    this.post({
      type: "prepend_items",
      items: eventsToItems(events),
      eventsOffset: this.eventsOffset,
      eventsTotal: Number(chat.events_total ?? 0) || undefined,
      eventsHasMore: this.eventsHasMore,
    });
  }

  get busy(): boolean {
    return this.abort !== undefined;
  }

  async openChat(): Promise<void> {
    // VS Code: Secondary Side Bar (right), same strip as Claude Code / Codex.
    // Cursor: Activity Bar.
    const isCursor = vscode.env.appName.toLowerCase().includes("cursor");
    if (!isCursor) {
      try {
        await vscode.commands.executeCommand("workbench.action.focusAuxiliaryBar");
      } catch {
        /* older hosts */
      }
      try {
        await vscode.commands.executeCommand("clawagents.sidebar.focus");
        return;
      } catch {
        /* fall through */
      }
    }
    for (const id of [
      "clawagents.sidebarActivity.focus",
      "clawagents.sidebar.focus",
    ]) {
      try {
        await vscode.commands.executeCommand(id);
        return;
      } catch {
        /* try next */
      }
    }
  }

  async toggleChat(): Promise<void> {
    const isCursor = vscode.env.appName.toLowerCase().includes("cursor");
    if (isCursor) {
      try {
        await vscode.commands.executeCommand("workbench.action.toggleSidebarVisibility");
      } catch {
        /* ignore */
      }
      await this.openChat();
      return;
    }
    try {
      await vscode.commands.executeCommand("workbench.action.toggleAuxiliaryBar");
      await vscode.commands.executeCommand("clawagents.sidebar.focus");
    } catch {
      await this.openChat();
    }
  }

  async addSelection(text: string): Promise<void> {
    await this.openChat();
    this.post({ type: "prepend", text });
  }

  async newChat(): Promise<void> {
    try {
      await this.sidecar.ensureStarted();
      const chat = await this.gateway.createChat(this.mode);
      this.chatId = String(chat.id);
      await this.refreshChats();
      this.post({
        type: "restore",
        items: [],
        draft: "",
        mode: this.mode,
        chatId: this.chatId,
        autoApprove: this.autoApprove,
        interaction: this.interaction,
        caveman: this.caveman,
        goal: this.goalMode,
        sessionCostUsd: 0,
      });
      await this.persistLocal(this.persistState());
    } catch (err) {
      this.post({
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async cancelTask(): Promise<void> {
    // Stop clears user-queued follow-ups, but stranded mid-turn interjects
    // are promoted afterward. Gate stream finally so it cannot drain the
    // queue before promotion lands (or auto-start an unrelated prompt).
    this.cancelling = true;
    const hadQueued = this.queue.length;
    if (hadQueued > 0) {
      this.queue = [];
      this.post({ type: "status", message: "Queue cleared" });
    }
    const hadStream = this.abort !== undefined;
    this.abort?.abort();
    this.abort = undefined;
    try {
      const res = await this.gateway.cancel();
      const stranded = (res.stranded_prompts || [])
        .map((p) => String(p).trim())
        .filter(Boolean);
      if (stranded.length) {
        // Dedupe against anything SSE already promoted.
        const seen = new Set(this.queue);
        const unique = stranded.filter((p) => !seen.has(p));
        this.queue = [...unique, ...this.queue];
        this.post({
          type: "status",
          message: `Queued stranded redirect${this.queue.length > 1 ? "s" : ""} (${this.queue.length})`,
        });
      }
    } catch {
      /* ignore */
    } finally {
      this.cancelling = false;
    }
    if (!hadStream) {
      this.post({ type: "cancelled" });
    }
    // If idle after cancel, start the stranded redirect immediately.
    if (!this.abort && this.queue.length > 0) {
      const next = this.queue.shift();
      if (next) {
        void this.runTask(next, this.config.includeContextByDefault, this.chatId);
      }
    }
  }

  async restartSidecar(): Promise<void> {
    this.post({ type: "sidecar", state: "starting" });
    this.sidecar.stop();
    try {
      await this.sidecar.ensureStarted();
      this.post({ type: "sidecar", state: "running" });
      await this.pushReady();
    } catch (err) {
      this.post({
        type: "sidecar",
        state: "error",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async persistLocal(state: PersistedState): Promise<void> {
    await this.context.workspaceState.update(STATE_KEY, state);
  }

  private async refreshChats(query?: string): Promise<void> {
    try {
      const chats = (await this.gateway.listChats(query)) as ChatSummary[];
      this.post({ type: "chats", chats, chatId: this.chatId });
    } catch {
      /* ignore until sidecar up */
    }
  }

  private async bootstrapAfterReady(): Promise<void> {
    try {
      await this.sidecar.ensureStarted();
      this.post({ type: "sidecar", state: "running" });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.post({
        type: "sidecar",
        state: "error",
        detail,
      });
      void vscode.window
        .showErrorMessage(
          `ClawAgents sidecar failed: ${detail.split("\n")[0]}`,
          "Show Sidecar Log",
          "Open Settings",
        )
        .then((choice) => {
          if (choice === "Show Sidecar Log") {
            void vscode.commands.executeCommand("workbench.action.output.toggleOutput");
          } else if (choice === "Open Settings") {
            void vscode.commands.executeCommand(
              "workbench.action.openSettings",
              "clawagents.pythonPath",
            );
          }
        });
    }
    await this.pushReady();
    // Re-sync staged attachment chips: the webview loses its local list on
    // reload while the attachments stay staged host-side (and would still send).
    this.postImagesPending();
    this.postFilesPending();
    if (!this.chatId) {
      return;
    }
    try {
      const chat = await this.gateway.getChat(this.chatId, { tail: 400 });
      await this.postChatRestore(this.chatId, chat);
    } catch {
      /* ignore */
    }
  }

  private async pushReady(): Promise<void> {
    let health: { model?: string; workspace?: string; provider?: string } | undefined;
    try {
      await this.sidecar.ensureStarted();
      health = await this.gateway.fetchHealth();
    } catch {
      health = undefined;
    }
    let chats: ChatSummary[] = [];
    let settings: Record<string, unknown> = {};
    let providers: unknown[] = [];
    let diagnostics: unknown;
    let stats: unknown;
    let mcp: unknown[] = [];
    try {
      chats = (await this.gateway.listChats()) as ChatSummary[];
      settings = await this.gateway.getSettings();
      // Fast start: fetch without live network probes.
      providers = await this.gateway.getProviders({ probe: false });
      diagnostics = await this.gateway.getDiagnostics();
      stats = await this.gateway.getStats();
      mcp = await this.gateway.getMcp();
      await warnUntrustedBaseUrl(settings);
    } catch {
      /* partial — sidecar may still be starting or down */
    }
    const keyFlags = await this.config.collectKeyFlags();
    this.post({
      type: "ready",
      workspace: workspaceRoot(),
      // Prefer workspace settings.model — health/config leftovers (e.g. llama3.1)
      // must not win over a healed OpenAI default.
      model:
        String(settings.model || "").trim() ||
        health?.model ||
        this.config.model ||
        "default",
      mode: this.mode,
      interaction: this.interaction,
      caveman: this.caveman,
      goal: this.goalMode,
      ...keyFlags,
      sidecar: this.sidecar.current ? "running" : "stopped",
      chatId: this.chatId,
      chats,
      settings,
      providers,
      diagnostics,
      stats,
      mcp,
      includeContextByDefault: this.config.includeContextByDefault,
    });

    // Fire-and-forget a live probe so the UI gets remote models (e.g. OpenAI/Mantle) shortly after ready.
    if (this.sidecar.current) {
      this.gateway
        .getProviders({ probe: true })
        .then((probed) => {
          if (this.sidecar.current) {
            void this.postSettingsWithKeyFlags(settings, probed);
          }
        })
        .catch(() => {
          /* ignore */
        });
    }
  }

  /** Attach authoritative key flags whenever we push a providers catalog. */
  private async postSettingsWithKeyFlags(
    settings: Record<string, unknown>,
    providers?: unknown[],
    saveOutcome?: "ok" | "cancelled",
    revision?: number,
  ): Promise<void> {
    const keyFlags = await this.config.collectKeyFlags();
    this.post({
      type: "settings",
      settings,
      ...(providers ? { providers } : {}),
      ...(saveOutcome ? { saveOutcome } : {}),
      ...(revision ? { revision } : {}),
      ...keyFlags,
    });
  }

  private async handleMessage(msg: WebviewToHost): Promise<void> {
    switch (msg.type) {
      case "ready":
        // Show the webview immediately; never block the first paint on a
        // slow/hung Python sidecar (that left the CLAWAGENTS tab spinning).
        this.post({ type: "sidecar", state: "starting" });
        void this.bootstrapAfterReady();
        break;
      case "send":
        this.mode = msg.mode;
        if (msg.autoApprove) {
          this.autoApprove = { ...DEFAULT_AUTO_APPROVE, ...msg.autoApprove };
        }
        if (msg.interaction === "interactive" || msg.interaction === "auto") {
          this.interaction = msg.interaction;
        }
        if (typeof msg.caveman === "boolean") {
          this.caveman = msg.caveman;
        }
        if (typeof msg.goal === "boolean") {
          this.goalMode = msg.goal;
        }
        if (this.mode === "read_only") {
          this.interaction = "interactive";
        }
        // Drain in-flight settings saves first — sidecar reads disk per turn.
        await this.saveSettingsChain.catch(() => undefined);
        await this.runTask(msg.text, msg.includeContext, msg.chatId, msg.model);
        break;
      case "queue_send":
        // Prefer mid-turn redirect when a run is active; else queue for next turn.
        try {
          const res = await this.gateway.interject(msg.text, this.chatId);
          if (res.ok && (res.applied ?? 0) > 0) {
            this.post({
              type: "status",
              message: "Redirected mid-turn",
            });
            break;
          }
        } catch {
          /* fall through to queue */
        }
        this.queue.push(msg.text);
        this.post({ type: "status", message: `Queued (${this.queue.length})` });
        // If the run finished while interject raced, finally already drained —
        // start the queued turn now so the message is not stranded.
        this.drainQueueIfIdle(true);
        break;
      case "interject":
        try {
          const res = await this.gateway.interject(msg.text, this.chatId);
          if (res.ok && (res.applied ?? 0) > 0) {
            this.post({
              type: "status",
              message: "Redirected mid-turn",
            });
            break;
          }
          this.queue.push(msg.text);
          this.post({
            type: "status",
            message: "No active run to redirect — queued for next turn",
          });
          this.drainQueueIfIdle(true);
        } catch (err) {
          this.post({
            type: "error",
            message: err instanceof Error ? err.message : String(err),
          });
        }
        break;
      case "cancel":
        await this.cancelTask();
        break;
      case "permission":
        try {
          await this.gateway.resolvePermission(msg.requestId, msg.decision);
        } catch (err) {
          this.post({
            type: "error",
            message: err instanceof Error ? err.message : String(err),
          });
        }
        break;
      case "ask_user_reply":
        try {
          await this.gateway.resolveAskUser(msg.requestId, {
            answer: msg.answer,
            skip: msg.skip,
          });
        } catch (err) {
          this.post({
            type: "error",
            message: err instanceof Error ? err.message : String(err),
          });
        }
        break;
      case "plan_approval":
        try {
          await this.gateway.resolvePlanApproval(
            msg.requestId,
            msg.decision,
            msg.comment,
          );
        } catch (err) {
          this.post({
            type: "error",
            message: err instanceof Error ? err.message : String(err),
          });
        }
        break;
      case "clear":
      case "new_chat":
        await this.newChat();
        break;
      case "fork_chat": {
        const targetId = msg.chatId || this.chatId;
        if (!targetId) {
          await this.newChat();
          break;
        }
        if (this.abort) {
          // Use error so the webview clears pendingForkRef (status would leave it set).
          this.post({
            type: "error",
            message: "Stop the current run before forking.",
          });
          break;
        }
        try {
          const res = await this.gateway.forkChat(targetId);
          this.chatId = res.chat_id;
          await this.persistLocal(this.persistState());
          const chat = await this.gateway.getChat(res.chat_id, { tail: 400 });
          const forkTitle =
            (typeof res.chat?.title === "string" && res.chat.title) ||
            (typeof chat.title === "string" ? chat.title : undefined);
          await this.postChatRestore(res.chat_id, chat, "", forkTitle);
          await this.refreshChats();
        } catch (err) {
          this.post({
            type: "error",
            message: err instanceof Error ? err.message : String(err),
          });
        }
        break;
      }
      case "select_chat":
        this.chatId = msg.chatId;
        await this.persistLocal(this.persistState());
        try {
          const chat = await this.gateway.getChat(msg.chatId, { tail: 400 });
          await this.postChatRestore(msg.chatId, chat);
        } catch (err) {
          this.post({
            type: "error",
            message: err instanceof Error ? err.message : String(err),
          });
        }
        break;
      case "load_older_chat":
        try {
          await this.loadOlderChatEvents();
        } catch (err) {
          this.post({
            type: "error",
            message: err instanceof Error ? err.message : String(err),
          });
        }
        break;
      case "delete_chat":
        try {
          await this.gateway.deleteChat(msg.chatId);
          if (this.chatId === msg.chatId) {
            this.chatId = undefined;
            this.post({
              type: "restore",
              items: [],
              draft: "",
              mode: this.mode,
              autoApprove: this.autoApprove,
              interaction: this.interaction,
              caveman: this.caveman,
              goal: this.goalMode,
              sessionCostUsd: 0,
            });
          }
          await this.refreshChats();
        } catch (err) {
          this.post({
            type: "error",
            message: err instanceof Error ? err.message : String(err),
          });
        }
        break;
      case "search_chats":
        try {
          await this.sidecar.ensureStarted();
          await this.refreshChats(msg.query.trim() || undefined);
        } catch (err) {
          this.post({
            type: "error",
            message: err instanceof Error ? err.message : String(err),
          });
        }
        break;
      case "regenerate":
        if (!this.chatId) {
          this.post({
            type: "status",
            message: "Nothing to regenerate — send a message first.",
          });
          break;
        }
        if (this.abort) {
          this.post({
            type: "status",
            message: "Stop the current run before regenerating.",
          });
          break;
        }
        try {
          const res = await this.gateway.regenerate(this.chatId);
          if (!res.task) {
            this.post({
              type: "status",
              message: "No prior user message to regenerate.",
            });
            break;
          }
          // Sync webview to truncated history before re-running.
          const chat = await this.gateway.getChat(this.chatId, { tail: 400 });
          await this.postChatRestore(this.chatId, chat);
          await this.runTask(res.task, false, this.chatId);
        } catch (err) {
          this.post({
            type: "error",
            message: err instanceof Error ? err.message : String(err),
          });
        }
        break;
      case "set_mode":
        this.mode = msg.mode;
        if (this.mode === "read_only") {
          this.interaction = "interactive";
        }
        break;
      case "set_interaction":
        this.interaction =
          this.mode === "read_only" ? "interactive" : msg.interaction;
        break;
      case "set_goal":
        this.goalMode = Boolean(msg.goal);
        if (this.goalMode) {
          this.mode = "auto";
          void this.gateway.resumeActiveGoal().catch(() => undefined);
        } else {
          // Pause disk-backed goal immediately so Act/Plan cannot inherit it.
          void this.gateway.pauseActiveGoal().catch(() => undefined);
        }
        await this.persistLocal(this.persistState());
        break;
      case "insert_context":
        await this.insertContext(msg.kind);
        break;
      case "attach_uris":
        await this.attachUris(msg.uris);
        break;
      case "attach_local_files":
        try {
          await this.attachLocalFiles(msg.files);
        } finally {
          if (typeof msg.requestId === "string" && msg.requestId.length <= 100) {
            this.post({ type: "attachment_staged", requestId: msg.requestId });
          }
        }
        break;
      case "pick_attach_files": {
        const uris = await vscode.window.showOpenDialog({
          canSelectFiles: true,
          canSelectFolders: false,
          canSelectMany: true,
          openLabel: "Attach",
          title: "Attach workspace files to chat",
          defaultUri: workspaceRoot()
            ? vscode.Uri.file(workspaceRoot()!)
            : undefined,
        });
        if (uris?.length) {
          await this.attachUris(uris.map((u) => u.toString()));
        }
        break;
      }
      case "remove_image":
        this.pendingImages = this.pendingImages.filter((i) => i.id !== msg.id);
        this.postImagesPending();
        break;
      case "clear_images":
        this.pendingImages = [];
        this.postImagesPending();
        break;
      case "remove_file":
        this.pendingFiles = this.pendingFiles.filter((f) => f.id !== msg.id);
        this.postFilesPending();
        break;
      case "clear_files":
        this.pendingFiles = [];
        this.postFilesPending();
        break;
      case "open_file":
        await this.openPath(msg.path, msg.line);
        break;
      case "diff_snapshot":
        await this.diffSnapshot(msg.path, msg.snapshotId, msg.snapshotRel);
        break;
      case "restore_snapshot":
        try {
          const res = await this.gateway.restoreSnapshot(msg.snapshotId, msg.rel);
          this.post({
            type: "status",
            message: `Restored ${res.restored || msg.rel}`,
          });
          if (res.restored) {
            await this.openPath(res.restored);
          }
        } catch (err) {
          this.post({
            type: "error",
            message: err instanceof Error ? err.message : String(err),
          });
        }
        break;
      case "restore_checkpoint":
        try {
          const res = await this.gateway.restoreCheckpoint(
            msg.sha,
            msg.mode,
            this.chatId,
          );
          this.post({
            type: "status",
            message: res.ok
              ? `Restored checkpoint ${msg.sha.slice(0, 12)} (${msg.mode})`
              : `Restore failed: ${String(res.error || "unknown")}`,
          });
          if (res.ok && (msg.mode === "conversation" || msg.mode === "both") && this.chatId) {
            // Carry draft through: restore overwrites it.
            const saved = this.context.workspaceState.get<PersistedState>(STATE_KEY);
            const chat = await this.gateway.getChat(this.chatId, { tail: 400 });
            await this.postChatRestore(this.chatId, chat, saved?.draft || "");
          }
        } catch (err) {
          this.post({
            type: "error",
            message: err instanceof Error ? err.message : String(err),
          });
        }
        break;
      case "compact_chat":
        try {
          if (!this.chatId) {
            throw new Error("No active chat");
          }
          // Immediate ack so the Compact chip doesn't look dead while the
          // sidecar (possibly) waits on an LLM summary.
          this.post({ type: "compact_progress", phase: "start" });
          this.post({
            type: "status",
            message: "Compacting session…",
          });
          const res = await this.gateway.compactChat(this.chatId);
          const compacted = Boolean(res.compacted);
          this.post({
            type: "status",
            message: compacted
              ? `Compacted ${String(res.before)} → ${String(res.after)} messages` +
                (res.est_tokens_before != null && res.est_tokens_after != null
                  ? ` (~${String(res.est_tokens_before)} → ~${String(res.est_tokens_after)} tokens)`
                  : "")
              : `Compact skipped: ${String(res.reason || "")}`,
          });
          this.post({
            type: "compact_progress",
            phase: compacted ? "end" : "dropped",
          });
          if (compacted || res.meter_reset) {
            // Context % is last LLM prompt size — reset so Compact isn't stuck at 100%.
            this.post({
              type: "usage",
              promptTokens: 0,
              completionTokens: 0,
              totalTokens: 0,
              lastInputTokens: Number(res.est_tokens_after) || 0,
            });
          }
        } catch (err) {
          this.post({ type: "compact_progress", phase: "failed" });
          this.post({
            type: "error",
            message: err instanceof Error ? err.message : String(err),
          });
        }
        break;
      case "list_checkpoints":
        try {
          const rows = await this.gateway.listCheckpoints(20);
          this.post({
            type: "checkpoints",
            checkpoints: rows,
            open: msg.open !== false,
          });
        } catch (err) {
          this.post({
            type: "error",
            message: err instanceof Error ? err.message : String(err),
          });
        }
        break;
      case "list_hunks":
        try {
          const res = await this.gateway.listHunks();
          this.post({
            type: "hunks",
            hunks: res.hunks || [],
            open: msg.open !== false,
          });
        } catch (err) {
          this.post({
            type: "error",
            message: err instanceof Error ? err.message : String(err),
          });
        }
        break;
      case "accept_hunk":
        try {
          await this.gateway.acceptHunk(msg.hunkId, msg.path);
          const res = await this.gateway.listHunks();
          this.post({ type: "hunks", hunks: res.hunks || [], open: true });
          this.post({ type: "status", message: "Hunk accepted" });
        } catch (err) {
          this.post({
            type: "error",
            message: err instanceof Error ? err.message : String(err),
          });
        }
        break;
      case "reject_hunk":
        try {
          await this.gateway.rejectHunk(msg.hunkId);
          const res = await this.gateway.listHunks();
          this.post({ type: "hunks", hunks: res.hunks || [], open: true });
          this.post({ type: "status", message: "Hunk rejected" });
        } catch (err) {
          this.post({
            type: "error",
            message: err instanceof Error ? err.message : String(err),
          });
        }
        break;
      case "list_rewind":
        try {
          const res = await this.gateway.listRewindSnapshots();
          this.post({
            type: "rewind",
            snapshots: res.snapshots || [],
            open: msg.open !== false,
          });
        } catch (err) {
          this.post({
            type: "error",
            message: err instanceof Error ? err.message : String(err),
          });
        }
        break;
      case "rewind_to":
        try {
          const result = await this.gateway.rewindToPrompt(msg.promptIndex, this.chatId);
          const res = await this.gateway.listRewindSnapshots();
          this.post({ type: "rewind", snapshots: res.snapshots || [], open: true });
          const trunc = result.conversation_truncated as
            | { ok?: boolean; error?: string }
            | undefined;
          if (result.ok === false) {
            this.post({
              type: "error",
              message: `Rewind failed: ${String(result.error || result.reason || "unknown")}`,
            });
          } else {
            this.post({
              type: "status",
              message:
                trunc && trunc.ok === false
                  ? `Rewound files to prompt ${msg.promptIndex} (conversation truncate failed)`
                  : `Rewound to prompt ${msg.promptIndex}`,
            });
            if (this.chatId && trunc && trunc.ok !== false) {
              try {
                await this.pushReady();
              } catch {
                /* ignore refresh errors */
              }
            }
          }
        } catch (err) {
          this.post({
            type: "error",
            message: err instanceof Error ? err.message : String(err),
          });
        }
        break;
      case "restart_sidecar":
        await this.restartSidecar();
        break;
      case "load_settings":
        try {
          await this.sidecar.ensureStarted();
          const settings = await this.gateway.getSettings();
          // Explicit Settings open — allow one live credential probe.
          const providers = await this.gateway.getProviders({ probe: true });
          await this.postSettingsWithKeyFlags(settings, providers);
          const skills = await this.gateway.getSkills();
          this.post({ type: "skills_preview", ...skills });
        } catch (err) {
          if (isSidecarTransportError(err)) {
            this.sidecar.invalidate("load_settings transport failure");
          }
          this.post({
            type: "error",
            message: err instanceof Error ? err.message : String(err),
          });
        }
        break;
      case "load_skills":
        try {
          const skills = await this.gateway.getSkills();
          this.post({ type: "skills_preview", ...skills });
        } catch (err) {
          this.post({
            type: "error",
            message: err instanceof Error ? err.message : String(err),
          });
        }
        break;
      case "save_settings": {
        // Queue saves — never run overlapping putSettings + catalog refresh.
        this.saveSettingsChain = this.saveSettingsChain
          .catch(() => undefined)
          .then(async () => {
        try {
          await this.sidecar.ensureStarted();
          const incoming = { ...(msg.settings || {}) } as Record<string, unknown>;
          let previous: Record<string, unknown> = {};
          try {
            previous = (await this.gateway.getSettings()) as Record<string, unknown>;
          } catch (err) {
            if (isSidecarTransportError(err)) {
              this.sidecar.invalidate("getSettings during save");
              await this.sidecar.ensureStarted();
              previous = (await this.gateway.getSettings()) as Record<string, unknown>;
            } else {
              previous = {};
            }
          }
          const baseUrlProvided = Object.prototype.hasOwnProperty.call(incoming, "base_url");
          const baseUrl =
            typeof incoming.base_url === "string" ? incoming.base_url.trim() : "";
          const prevBaseUrl =
            typeof previous.base_url === "string" ? previous.base_url.trim() : "";
          // Bedrock / OpenAI-compatible: normalize pasted URLs. Also drops a
          // leftover Mantle host when Provider is OpenAI/Anthropic/Gemini so a
          // stale bedrock_mode=mantle cannot force provider back to Bedrock.
          const { reconcileProviderGatewaySettings } = await import(
            "./bedrockGateway"
          );
          reconcileProviderGatewaySettings(incoming, previous);
          const normalizedBase = baseUrlProvided
            ? typeof incoming.base_url === "string"
              ? incoming.base_url.trim()
              : baseUrl
            : prevBaseUrl;
          const baseUrlChanged = baseUrlProvided && normalizedBase !== prevBaseUrl;
          const revokeGatewayTrust = baseUrlProvided && !normalizedBase;
          // Autosave posts the full settings object (always includes base_url).
          // Only prompt when the URL itself changed — not on checkbox / wire_api
          // edits against an already-committed untrusted URL.
          if (
            baseUrlChanged &&
            normalizedBase &&
            !isTrustedBaseUrl(normalizedBase)
          ) {
            const choice = await vscode.window.showWarningMessage(
              `Custom base URL "${normalizedBase}" will receive provider API keys. Only continue if you trust this endpoint.`,
              { modal: true },
              "Trust and save",
              "Cancel",
            );
            if (choice !== "Trust and save") {
              this.post({ type: "status", message: "Settings save cancelled" });
              await this.postSettingsWithKeyFlags(
                previous,
                undefined,
                "cancelled",
                msg.revision,
              );
              return;
            }
            incoming.trust_custom_base_url = true;
            // Corporate / private-CA gateways usually fail default TLS verify.
            if (/^https:\/\//i.test(normalizedBase)) {
              incoming.ssl_verify = false;
            }
          } else if (revokeGatewayTrust) {
            incoming.trust_custom_base_url = false;
          } else {
            // Gateway trust is host-managed (modal / clear). Drop stale
            // trust_custom_base_url from full autosave payloads so a mismatched
            // committed URL cannot revoke the prior URL-bound approval.
            delete incoming.trust_custom_base_url;
            if (previous.trust_custom_base_url && !baseUrlChanged) {
              incoming.trust_custom_base_url = true;
            }
          }
          // Only confirm workspace MCP trust when newly enabling.
          if (incoming.mcp_trust_workspace === true && !previous.mcp_trust_workspace) {
            const choice = await vscode.window.showWarningMessage(
              "Trust workspace .clawagents/mcp.json? It can run local commands from this repo.",
              { modal: true },
              "Trust workspace MCP",
              "Cancel",
            );
            if (choice !== "Trust workspace MCP") {
              incoming.mcp_trust_workspace = false;
            }
          }
          const settings = await this.gateway.putSettings(incoming);
          // Trust approvals must never live in the repository-controlled
          // .clawagents/vscode_settings.json. Persist the effective grants in
          // workspace-scoped VS Code SecretStorage for sidecar restarts.
          await this.config.storeRuntimeTrust(settings, { revokeGatewayTrust });
          const skillKeys = [
            "skill_dirs",
            "skill_ignore_dirs",
            "skill_exclude",
            "skill_auto_discover",
            "skill_user_homes",
            "allow_external_skill_dirs",
          ] as const;
          const catalogKeys = [
            "provider",
            "model",
            "base_url",
            "bedrock_mode",
            "aws_region",
            "wire_api",
          ] as const;
          const changed = (keys: readonly string[]) =>
            keys.some((k) => JSON.stringify(previous[k] ?? null) !== JSON.stringify(settings[k] ?? null));
          const skillsChanged = changed(skillKeys);
          const catalogChanged = changed(catalogKeys);
          const mantleMode =
            String(settings.bedrock_mode || "").toLowerCase() === "mantle" ||
            /bedrock-mantle\./i.test(String(settings.base_url || ""));
          const ollamaMode =
            String(settings.provider || "").toLowerCase() === "ollama";
          // On provider/endpoint change: refresh catalog. Mantle + Ollama use
          // live probes; others stay cheap (probe=0).
          let providers: unknown[] | undefined;
          if (catalogChanged) {
            try {
              providers = await this.gateway.getProviders({
                probe: mantleMode || ollamaMode,
              });
            } catch {
              /* catalog refresh is best-effort */
            }
          }
          await this.postSettingsWithKeyFlags(settings, providers, "ok", msg.revision);
          this.post({ type: "status", message: "Settings saved" });
          if (skillsChanged) {
            try {
              const skills = await this.gateway.getSkills();
              this.post({ type: "skills_preview", ...skills });
            } catch {
              /* preview is best-effort after save */
            }
          }
        } catch (err) {
          if (isSidecarTransportError(err)) {
            this.sidecar.invalidate("save_settings transport failure");
          }
          this.post({
            type: "error",
            message: err instanceof Error ? err.message : String(err),
          });
        }
          });
        break;
      }
      case "pick_skill_dir": {
        const uris = await vscode.window.showOpenDialog({
          canSelectFiles: false,
          canSelectFolders: true,
          canSelectMany: false,
          openLabel: "Add skill folder",
          title: "Register skill folder",
        });
        const picked = uris?.[0]?.fsPath;
        if (picked) {
          this.post({ type: "skill_dir_picked", path: picked });
        }
        break;
      }
      case "set_api_key":
        try {
          const savedProvider = await this.config.promptSetApiKey();
          if (!savedProvider) {
            this.post({
              type: "verify_result",
              provider: "api key",
              ok: false,
              detail: "cancelled — nothing changed",
            });
            break;
          }
          // Restart so the new key reaches the sidecar's environment.
          this.sidecar.stop();
          await this.sidecar.ensureStarted();
          this.post({ type: "sidecar", state: "running" });
          await this.pushReady();

          if (savedProvider.toLowerCase().includes("tavily")) {
            this.post({
              type: "verify_result",
              provider: "tavily",
              ok: true,
              detail: "Tavily key saved; sidecar restarted — web_search is ready",
            });
            break;
          }

          // Map UI label → provider id for a live probe.
          const providerId =
            savedProvider.toLowerCase().includes("gemini")
              ? "gemini"
              : savedProvider.toLowerCase().includes("anthropic")
                ? "anthropic"
                : savedProvider.toLowerCase().includes("bedrock")
                  ? "bedrock"
                  : "openai";
          try {
            const res = await this.gateway.verifyKey(providerId);
            this.post({
              type: "verify_result",
              provider: providerId,
              ok: Boolean(res.ok),
              detail: res.detail || "key saved; sidecar restarted",
            });
          } catch (verifyErr) {
            this.post({
              type: "verify_result",
              provider: providerId,
              ok: true,
              detail: `key saved; sidecar restarted (live check skipped: ${
                verifyErr instanceof Error ? verifyErr.message : String(verifyErr)
              })`,
            });
          }
        } catch (err) {
          this.post({
            type: "sidecar",
            state: "error",
            detail: err instanceof Error ? err.message : String(err),
          });
          this.post({
            type: "verify_result",
            provider: "api key",
            ok: false,
            detail: err instanceof Error ? err.message : String(err),
          });
        }
        break;
      case "set_bedrock_key":
        try {
          await this.config.setApiKey("bedrock", msg.apiKey);
          this.sidecar.stop();
          await this.sidecar.ensureStarted();
          this.post({ type: "sidecar", state: "running" });
          await this.pushReady();
          this.post({
            type: "verify_result",
            provider: "bedrock",
            ok: true,
            detail: "Bedrock Access Gateway API key saved; sidecar restarted",
          });
        } catch (err) {
          this.post({
            type: "verify_result",
            provider: "bedrock",
            ok: false,
            detail: err instanceof Error ? err.message : String(err),
          });
        }
        break;
      case "set_provider_key":
        try {
          if (msg.provider === "tavily") {
            await this.config.setTavilyApiKey(msg.apiKey);
          } else {
            await this.config.setApiKey(msg.provider, msg.apiKey);
          }
          this.sidecar.stop();
          await this.sidecar.ensureStarted();
          this.post({ type: "sidecar", state: "running" });
          await this.pushReady();
          const labels: Record<string, string> = {
            openai: "OpenAI / compatible",
            anthropic: "Anthropic",
            gemini: "Gemini",
            bedrock: "Bedrock Access Gateway",
            tavily: "Tavily",
          };
          const keyFlags = await this.config.collectKeyFlags();
          this.post({
            type: "verify_result",
            provider: msg.provider,
            ok: true,
            detail: `${labels[msg.provider] || msg.provider} API key saved; sidecar restarted`,
            ...keyFlags,
          });
        } catch (err) {
          this.post({
            type: "verify_result",
            provider: msg.provider,
            ok: false,
            detail: err instanceof Error ? err.message : String(err),
          });
        }
        break;
      case "clear_provider_key":
        try {
          if (msg.provider === "tavily") {
            await this.config.clearTavilyApiKey();
          } else {
            await this.config.clearApiKey(msg.provider);
          }
          this.sidecar.stop();
          await this.sidecar.ensureStarted();
          this.post({ type: "sidecar", state: "running" });
          await this.pushReady();
          const labels: Record<string, string> = {
            openai: "OpenAI / compatible",
            anthropic: "Anthropic",
            gemini: "Gemini",
            bedrock: "Bedrock Access Gateway",
            tavily: "Tavily",
          };
          // After clear, flags still true if workspace .env / shell still has a key.
          const keyFlags = await this.config.collectKeyFlags();
          this.post({
            type: "verify_result",
            provider: msg.provider,
            ok: true,
            detail: `${labels[msg.provider] || msg.provider} key cleared; sidecar restarted`,
            ...keyFlags,
          });
        } catch (err) {
          this.post({
            type: "verify_result",
            provider: msg.provider,
            ok: false,
            detail: err instanceof Error ? err.message : String(err),
          });
        }
        break;
      case "test_bedrock_gateway": {
        const { probeCompatibleEndpoint } = await import("./bedrockGateway");
        const key =
          (msg.apiKey || "").trim() ||
          (await this.config.resolveProviderApiKey("bedrock")) ||
          "";
        const result = await probeCompatibleEndpoint(msg.baseUrl || "", key, {
          style: "bag",
          label: "Bedrock Access Gateway",
        });
        this.post({
          type: "verify_result",
          provider: "bedrock",
          ok: result.ok,
          detail: result.detail,
        });
        break;
      }
      case "test_compatible_endpoint": {
        const testedUrl = (msg.baseUrl || "").trim();
        // Serialize with settings saves so a late probe cannot overwrite the
        // catalog after the user has already switched providers/endpoints.
        this.saveSettingsChain = this.saveSettingsChain
          .catch(() => undefined)
          .then(async () => {
            const { probeCompatibleEndpoint } = await import("./bedrockGateway");
            const style = msg.style === "bag" ? "bag" : "openai";
            const provider =
              msg.provider || (style === "bag" ? "bedrock" : "openai");
            const keyProvider =
              provider === "bedrock"
                ? "bedrock"
                : provider === "gemini"
                  ? "gemini"
                  : provider === "anthropic"
                    ? "anthropic"
                    : "openai";
            const key =
              (msg.apiKey || "").trim() ||
              (await this.config.resolveProviderApiKey(keyProvider)) ||
              "";
            const result = await probeCompatibleEndpoint(testedUrl, key, {
              style,
              allowEmptyKey:
                style === "openai" &&
                /localhost|127\.0\.0\.1/.test(testedUrl),
              label:
                style === "bag"
                  ? "Bedrock Access Gateway"
                  : /bedrock-mantle\./i.test(testedUrl)
                    ? "Mantle / OneHUB"
                    : "OpenAI-compatible endpoint",
            });
            this.post({
              type: "verify_result",
              provider,
              ok: result.ok,
              detail: result.detail,
            });
            if (!result.ok) {
              return;
            }
            try {
              await this.sidecar.ensureStarted();
              const settings = await this.gateway.getSettings();
              const current = String(settings.base_url || "").trim();
              const norm = (u: string) => u.replace(/\/+$/, "").toLowerCase();
              if (norm(current) !== norm(testedUrl)) {
                // User switched away while the probe ran — keep their catalog.
                return;
              }
              const providers = await this.gateway.getProviders({ probe: true });
              await this.postSettingsWithKeyFlags(settings, providers);
            } catch {
              /* best-effort */
            }
          });
        await this.saveSettingsChain.catch(() => undefined);
        break;
      }
      case "clear_api_key":
        try {
          const cleared = await this.config.promptClearApiKey();
          if (!cleared) {
            this.post({
              type: "verify_result",
              provider: "api key",
              ok: false,
              detail: "cancelled — nothing changed",
            });
            break;
          }
          this.sidecar.stop();
          await this.sidecar.ensureStarted();
          this.post({ type: "sidecar", state: "running" });
          await this.pushReady();
          this.post({
            type: "verify_result",
            provider: "api key",
            ok: true,
            detail: `${cleared === "all" ? "All keys" : cleared} cleared; sidecar restarted`,
          });
        } catch (err) {
          this.post({
            type: "sidecar",
            state: "error",
            detail: err instanceof Error ? err.message : String(err),
          });
          this.post({
            type: "verify_result",
            provider: "api key",
            ok: false,
            detail: err instanceof Error ? err.message : String(err),
          });
        }
        break;
      case "verify_key":
        try {
          // Verify goes through the Python sidecar; start it if the panel
          // opened before bootstrap finished or after a failed restart.
          if (!this.sidecar.current) {
            this.post({
              type: "verify_result",
              provider: msg.provider,
              ok: false,
              detail: "Starting sidecar…",
            });
            await this.sidecar.ensureStarted();
            this.post({ type: "sidecar", state: "running" });
          }
          const res = await this.gateway.verifyKey(msg.provider);
          this.post({
            type: "verify_result",
            provider: msg.provider,
            ok: Boolean(res.ok),
            detail: res.detail,
          });
        } catch (err) {
          this.post({
            type: "verify_result",
            provider: msg.provider,
            ok: false,
            detail: err instanceof Error ? err.message : String(err),
          });
          this.post({
            type: "sidecar",
            state: "error",
            detail: err instanceof Error ? err.message : String(err),
          });
        }
        break;
      case "load_diagnostics":
        try {
          this.post({ type: "diagnostics", data: await this.gateway.getDiagnostics() });
        } catch (err) {
          this.post({
            type: "error",
            message: err instanceof Error ? err.message : String(err),
          });
        }
        break;
      case "graphify_action":
        await this.handleGraphifyAction(msg.action);
        break;
      case "load_stats":
        try {
          this.post({ type: "stats", data: await this.gateway.getStats() });
        } catch (err) {
          this.post({
            type: "error",
            message: err instanceof Error ? err.message : String(err),
          });
        }
        break;
      case "bug_report_capture_screenshot": {
        const shot = await captureBugScreenshot();
        if (!shot) {
          this.post({
            type: "bug_report_screenshot",
            ok: false,
            detail: "No screenshot captured",
          });
          break;
        }
        this.post({ type: "bug_report_screenshot", ok: true, screenshot: shot });
        break;
      }
      case "bug_report_submit": {
        const out = this.sidecar.output;
        out.appendLine("Sending bug report email…");
        const result = await sendBugReportEmail({
          python: this.config.pythonPath,
          extensionPath: this.context.extensionUri.fsPath,
          text: msg.text,
          screenshots: msg.screenshots,
          output: out,
        });
        this.post({
          type: "bug_report_result",
          ok: result.ok,
          detail: result.detail,
        });
        if (result.ok) {
          void vscode.window.showInformationMessage(
            result.usedFallback ? "Bug report copied — check your mail client." : "Bug report emailed.",
          );
        } else {
          void vscode.window.showErrorMessage(`Bug report failed: ${result.detail}`);
        }
        break;
      }
      case "dictation_toggle": {
        const target = msg.target === "bug_report" ? "bug_report" : "composer";
        const result = await hostDictation.toggle(
          this.config,
          this.sidecar.output,
          target,
          async () => {
            this.post({ type: "dictation_focus", target });
            await new Promise((r) => setTimeout(r, 220));
          },
          Boolean(msg.forcePick),
        );
        if (result.kind === "started") {
          this.post({
            type: "dictation_state",
            recording: true,
            target: result.target,
            detail:
              result.detail ||
              "Dictation on — speak, then Mic / Esc to stop",
          });
        } else if (result.kind === "stopped" || result.kind === "cancelled") {
          this.post({
            type: "dictation_state",
            recording: false,
            target: result.target,
          });
        } else {
          this.post({
            type: "dictation_state",
            recording: false,
            target: result.target,
          });
          this.post({
            type: "dictation_error",
            target: result.target,
            detail: result.detail,
          });
        }
        break;
      }
      case "persist":
        this.mode = msg.mode;
        if (msg.chatId) {
          this.chatId = msg.chatId;
        }
        if (msg.autoApprove) {
          this.autoApprove = { ...DEFAULT_AUTO_APPROVE, ...msg.autoApprove };
        }
        if (msg.interaction === "interactive" || msg.interaction === "auto") {
          this.interaction = msg.interaction;
        }
        if (typeof msg.caveman === "boolean") {
          this.caveman = msg.caveman;
        }
        if (typeof msg.goal === "boolean") {
          this.goalMode = msg.goal;
        }
        if (this.mode === "read_only") {
          this.interaction = "interactive";
        }
        await this.persistLocal(this.persistState(msg.draft));
        break;
      default:
        break;
    }
  }

  private async attachUris(uris: string[]): Promise<void> {
    const refs: string[] = [];
    const skipped: string[] = [];
    let imagesStaged = 0;
    let filesStaged = 0;
    for (const raw of uris) {
      const trimmed = (raw || "").trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }
      try {
        let uri: vscode.Uri | undefined;
        if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) {
          uri = vscode.Uri.parse(trimmed);
        } else if (trimmed.startsWith("/") || /^[A-Za-z]:[\\/]/.test(trimmed)) {
          uri = vscode.Uri.file(trimmed);
        } else {
          // Workspace-relative path text
          const root = workspaceRoot();
          if (root) {
            uri = vscode.Uri.file(path.join(root, trimmed));
          }
        }
        if (!uri || (uri.scheme !== "file" && uri.scheme !== "vscode-remote")) {
          skipped.push(trimmed);
          continue;
        }
        const rel = this.workspaceRelative(uri);
        // Images resolve to actual pixels (base64 content block) rather than a
        // text @path ref, but stay workspace-confined like every other attach.
        const mime = IMAGE_MIME[path.extname(uri.fsPath).toLowerCase()];
        if (mime && rel) {
          const staged = await this.stageImage(uri, mime);
          if (staged) {
            imagesStaged++;
          } else {
            skipped.push(rel);
          }
          continue;
        }
        // PDFs/DOCX resolve to document content the model can read directly,
        // same workspace-confined staging as images.
        const docMime = DOC_MIME[path.extname(uri.fsPath).toLowerCase()];
        if (docMime && rel) {
          const staged = await this.stageFile(uri, docMime);
          if (staged) {
            filesStaged++;
          } else {
            skipped.push(rel);
          }
          continue;
        }
        if (rel) {
          refs.push(formatFileRef(rel).trimEnd());
        } else {
          skipped.push(vscode.workspace.asRelativePath(uri, false) || trimmed);
        }
      } catch {
        skipped.push(trimmed);
      }
    }
    if (imagesStaged > 0) {
      this.postImagesPending();
      this.post({
        type: "status",
        message: `Attached ${imagesStaged} image${imagesStaged === 1 ? "" : "s"}`,
      });
    }
    if (filesStaged > 0) {
      this.postFilesPending();
      this.post({
        type: "status",
        message: `Attached ${filesStaged} document${filesStaged === 1 ? "" : "s"}`,
      });
    }
    const uniqueRefs = [...new Set(refs)];
    if (uniqueRefs.length) {
      this.post({ type: "prepend", text: `${uniqueRefs.join("\n")}\n` });
      this.post({
        type: "status",
        message:
          uniqueRefs.length === 1
            ? `Attached ${uniqueRefs[0].replace(/^@/, "")}`
            : `Attached ${uniqueRefs.length} files`,
      });
    } else if (imagesStaged === 0 && filesStaged === 0) {
      this.post({
        type: "status",
        message:
          "Drop workspace files onto the draft (hold Shift), or use +Attach.",
      });
    }
    if (skipped.length && !uniqueRefs.length && imagesStaged === 0 && filesStaged === 0) {
      this.post({
        type: "error",
        message: `Not in workspace: ${skipped.slice(0, 3).join(", ")}`,
      });
    }
  }

  /** Stage bytes selected, pasted, or dropped in the locally rendered webview.
   *  This is intentionally separate from URI attachment: in a Remote SSH /
   *  Codespaces window the extension host cannot read a path on the user's
   *  desktop, while the webview can read the browser File and transfer it. */
  private async attachLocalFiles(
    files: Array<{ name: string; mediaType: string; data: string }>,
  ): Promise<void> {
    if (!Array.isArray(files)) {
      return;
    }
    let imagesStaged = 0;
    let filesStaged = 0;
    const rejected: string[] = [];

    if (files.length > 1) {
      rejected.push(`batch contained ${files.length} files (send one at a time)`);
    }

    for (const item of files.slice(0, 1)) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const name = safeLocalAttachmentName(item.name);
      if (
        this.pendingImages.length >= MAX_PENDING_IMAGES &&
        this.pendingFiles.length >= MAX_PENDING_FILES
      ) {
        rejected.push(`${name} (attachment limits reached)`);
        continue;
      }
      const data = decodeLocalAttachment(item.data);
      if (!data) {
        rejected.push(`${name} (invalid or over 10MB)`);
        continue;
      }

      // Browser MIME/name metadata is client-controlled. Sniff the supported
      // image formats so a mislabeled paste cannot reach the model as pixels.
      const imageType = detectImageMediaType(data.bytes);
      if (imageType) {
        if (this.pendingImages.length >= MAX_PENDING_IMAGES) {
          rejected.push(`${name} (image limit ${MAX_PENDING_IMAGES})`);
          continue;
        }
        this.pendingImages.push({
          id: crypto.randomBytes(6).toString("hex"),
          name,
          data: data.base64,
          mediaType: imageType,
        });
        imagesStaged++;
        continue;
      }

      const namedDocumentType = DOC_MIME[path.extname(name).toLowerCase()];
      const documentType = detectDocumentMediaType(data.bytes);
      if (documentType && documentType === namedDocumentType) {
        if (this.pendingFiles.length >= MAX_PENDING_FILES) {
          rejected.push(`${name} (document limit ${MAX_PENDING_FILES})`);
          continue;
        }
        this.pendingFiles.push({
          id: crypto.randomBytes(6).toString("hex"),
          name,
          data: data.base64,
          mediaType: documentType,
        });
        filesStaged++;
        continue;
      }

      rejected.push(`${name} (unsupported local file type)`);
    }

    if (imagesStaged > 0) {
      this.postImagesPending();
    }
    if (filesStaged > 0) {
      this.postFilesPending();
    }
    if (imagesStaged > 0 || filesStaged > 0) {
      const parts = [
        imagesStaged > 0
          ? `${imagesStaged} image${imagesStaged === 1 ? "" : "s"}`
          : "",
        filesStaged > 0
          ? `${filesStaged} document${filesStaged === 1 ? "" : "s"}`
          : "",
      ].filter(Boolean);
      this.post({ type: "status", message: `Attached ${parts.join(" and ")} from this device` });
    }
    if (rejected.length > 0) {
      this.post({
        type: "error",
        message: `Could not attach: ${rejected.slice(0, 3).join(", ")}`,
      });
    }
  }

  /** Read an image file into the pending-attachment buffer (host-side only).
   *  Returns true if staged. Enforces count and size caps. */
  private async stageImage(uri: vscode.Uri, mediaType: string): Promise<boolean> {
    if (this.pendingImages.length >= MAX_PENDING_IMAGES) {
      this.post({
        type: "status",
        message: `Image limit reached (${MAX_PENDING_IMAGES}); attach ignored.`,
      });
      return false;
    }
    let bytes: Uint8Array;
    try {
      bytes = await vscode.workspace.fs.readFile(uri);
    } catch {
      return false;
    }
    if (bytes.byteLength > MAX_IMAGE_BYTES) {
      this.post({
        type: "error",
        message: `Image too large (${Math.round(bytes.byteLength / 1024 / 1024)}MB > 10MB): ${path.basename(uri.fsPath)}`,
      });
      return false;
    }
    this.pendingImages.push({
      id: crypto.randomBytes(6).toString("hex"),
      name: path.basename(uri.fsPath),
      data: Buffer.from(bytes).toString("base64"),
      mediaType,
    });
    return true;
  }

  /** Push chip metadata (name/id only — never bytes) to the webview. */
  private postImagesPending(): void {
    this.post({
      type: "images_pending",
      images: this.pendingImages.map((i) => ({ id: i.id, name: i.name })),
    });
  }

  /** Read a document (PDF/DOCX) into the pending-attachment buffer
   *  (host-side only). Returns true if staged. Enforces count and size caps. */
  private async stageFile(uri: vscode.Uri, mediaType: string): Promise<boolean> {
    if (this.pendingFiles.length >= MAX_PENDING_FILES) {
      this.post({
        type: "status",
        message: `File limit reached (${MAX_PENDING_FILES}); attach ignored.`,
      });
      return false;
    }
    let bytes: Uint8Array;
    try {
      bytes = await vscode.workspace.fs.readFile(uri);
    } catch {
      return false;
    }
    if (bytes.byteLength > MAX_FILE_ATTACH_BYTES) {
      this.post({
        type: "error",
        message: `File too large (${Math.round(bytes.byteLength / 1024 / 1024)}MB > 10MB): ${path.basename(uri.fsPath)}`,
      });
      return false;
    }
    this.pendingFiles.push({
      id: crypto.randomBytes(6).toString("hex"),
      name: path.basename(uri.fsPath),
      data: Buffer.from(bytes).toString("base64"),
      mediaType,
    });
    return true;
  }

  /** Push file-chip metadata (name/id only — never bytes) to the webview. */
  private postFilesPending(): void {
    this.post({
      type: "files_pending",
      files: this.pendingFiles.map((f) => ({ id: f.id, name: f.name })),
    });
  }

  private workspaceRelative(uri: vscode.Uri): string | undefined {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (!folders.length) {
      return path.basename(uri.fsPath);
    }
    const resolved = path.resolve(uri.fsPath);
    for (const folder of folders) {
      const root = path.resolve(folder.uri.fsPath);
      if (resolved === root || resolved.startsWith(root + path.sep)) {
        return path.relative(root, resolved).split(path.sep).join("/");
      }
    }
    return undefined;
  }

  private async insertContext(
    kind: "file" | "selection" | "problems" | "editors" | "terminal" | "git",
  ): Promise<void> {
    let text = "";
    try {
      if (kind === "file") {
        text = wrapCurrentFileRef() || "";
      } else if (kind === "selection") {
        text = wrapSelectionBlock() || "";
      } else if (kind === "problems") {
        text = `${await buildProblemsContext()}\n\n`;
      } else if (kind === "editors") {
        text = `${buildEditorContext()}\n\n`;
      } else if (kind === "terminal") {
        text = `${await buildTerminalContext()}\n\n`;
      } else if (kind === "git") {
        text = `${await buildGitContext()}\n\n`;
      }
    } catch (err) {
      this.post({
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    if (text.trim()) {
      this.post({ type: "prepend", text });
      const labels: Record<string, string> = {
        file: "+File",
        selection: "+Sel",
        problems: "+Err",
        terminal: "+Term",
        git: "+Git",
        editors: "+Editors",
      };
      this.post({ type: "status", message: `Inserted ${labels[kind] || kind}` });
    } else {
      const hint =
        kind === "file" || kind === "selection"
          ? "Open a file in the editor first, then click again."
          : "Nothing to insert.";
      this.post({ type: "status", message: hint });
    }
  }

  private async openPath(
    filePath: string,
    line?: number,
    opts?: { quiet?: boolean },
  ): Promise<void> {
    const quiet = Boolean(opts?.quiet);
    const fail = (message: string) => {
      if (quiet) {
        this.sidecar.output.appendLine(`autoOpen: ${message}`);
        return;
      }
      this.post({ type: "error", message });
    };
    try {
      const folders = vscode.workspace.workspaceFolders ?? [];
      if (!folders.length) {
        fail("Open a workspace folder before opening paths from chat.");
        return;
      }
      let uri: vscode.Uri;
      if (path.isAbsolute(filePath)) {
        uri = vscode.Uri.file(filePath);
      } else {
        const root = workspaceRoot();
        uri = vscode.Uri.file(root ? path.join(root, filePath) : filePath);
      }
      const resolved = path.resolve(uri.fsPath);
      const inWorkspace = folders.some((f) => {
        const root = path.resolve(f.uri.fsPath);
        return resolved === root || resolved.startsWith(root + path.sep);
      });
      if (!inWorkspace) {
        fail(`Refusing to open path outside the workspace: ${filePath}`);
        return;
      }
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc, {
        preview: true,
        // Preserve focus for auto-open convenience; user-initiated opens still
        // focus the editor (quiet=false).
        preserveFocus: quiet,
      });
      if (line && line > 0) {
        const pos = new vscode.Position(line - 1, 0);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(new vscode.Range(pos, pos));
      }
    } catch (err) {
      fail(
        `Could not open ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private scheduleAutoOpenChangedFile(filePath: string): void {
    this.autoOpen.schedule(filePath);
  }

  dispose(): void {
    this.autoOpen.dispose();
  }

  private async diffSnapshot(
    filePath: string,
    snapshotId?: string,
    snapshotRel?: string,
  ): Promise<void> {
    try {
      let snapId = snapshotId;
      let rel = snapshotRel;
      if (!snapId || !rel) {
        const hit = await this.gateway.latestSnapshot(filePath);
        snapId = hit.snapshot_id;
        rel = hit.rel;
      }
      const root = workspaceRoot();
      if (!root) {
        throw new Error("No workspace");
      }
      if (!snapId || !isSafeId(snapId)) {
        throw new Error("Invalid snapshot id");
      }
      if (!rel || rel.includes("..") || path.isAbsolute(rel)) {
        throw new Error("Invalid snapshot path");
      }
      const left = pathUnderRoot(root, ".clawagents", "snapshots", snapId, rel);
      if (!left) {
        throw new Error("Snapshot path escapes workspace");
      }
      const right = path.isAbsolute(filePath)
        ? path.resolve(filePath)
        : path.resolve(root, filePath);
      if (right !== root && !right.startsWith(root + path.sep)) {
        throw new Error("Refusing to diff a file outside the workspace");
      }
      if (!fs.existsSync(left)) {
        throw new Error(`Snapshot missing: ${left}`);
      }
      // Copy snapshot to temp for VS Code diff title clarity
      const tmp = path.join(os.tmpdir(), `claw-snap-${snapId}-${path.basename(rel)}`);
      fs.copyFileSync(left, tmp);
      await vscode.commands.executeCommand(
        "vscode.diff",
        vscode.Uri.file(tmp),
        vscode.Uri.file(right),
        `Checkpoint ${snapId} ↔ ${path.basename(right)}`,
      );
    } catch (err) {
      this.post({
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async runTask(
    text: string,
    includeContext: boolean,
    chatId?: string,
    modelOverride?: string,
  ): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }
    if (this.abort) {
      this.queue.push(trimmed);
      this.post({ type: "status", message: `Queued (${this.queue.length})` });
      return;
    }

    if (chatId) {
      this.chatId = chatId;
    }

    let task = trimmed;
    if (includeContext) {
      const ctx = buildEditorContext();
      if (ctx) {
        task = `${trimmed}\n\n---\nEditor context:\n${ctx}`;
      }
    }

    // Reserve the run slot before await points so concurrent drainQueueIfIdle
    // / interject cannot start a second turn in parallel.
    this.abort = new AbortController();
    const signal = this.abort.signal;

    this.post({ type: "user_echo", text: trimmed });
    this.post({ type: "sidecar", state: "starting" });

    try {
      await this.sidecar.ensureStarted();
      this.post({ type: "sidecar", state: "running" });
    } catch (err) {
      this.abort = undefined;
      this.post({
        type: "sidecar",
        state: "error",
        detail: err instanceof Error ? err.message : String(err),
      });
      this.post({
        type: "error",
        message: `Failed to start Python sidecar: ${err instanceof Error ? err.message : String(err)}`,
      });
      this.drainQueueIfIdle(includeContext);
      return;
    }
    try {
      const settings = await this.gateway
        .getSettings()
        .catch(() => ({}) as Record<string, unknown>);
      const model =
        (modelOverride && modelOverride !== "default" ? modelOverride : undefined) ||
        (typeof settings.model === "string" && settings.model
          ? settings.model
          : this.config.model || undefined);
      // Attach any staged images/files to THIS turn, then clear them so they
      // don't leak into a later message.
      const images = this.pendingImages.map((i) => ({
        data: i.data,
        media_type: i.mediaType,
      }));
      if (this.pendingImages.length > 0) {
        this.pendingImages = [];
        this.postImagesPending();
      }
      const files = this.pendingFiles.map((f) => ({
        data: f.data,
        media_type: f.mediaType,
        name: f.name,
      }));
      if (this.pendingFiles.length > 0) {
        this.pendingFiles = [];
        this.postFilesPending();
      }
      const newId = await this.gateway.streamChat(
        task,
        this.chatId,
        this.mode,
        {
          signal,
          onEvent: (ev) => {
            if (ev.type === "stranded_interject" && ev.prompts?.length) {
              const prompts = ev.prompts.map((p) => String(p).trim()).filter(Boolean);
              if (prompts.length) {
                // Front of queue — send-now semantics for stranded redirects.
                this.queue = [...prompts, ...this.queue];
                this.post({
                  type: "status",
                  message: `Queued stranded redirect${prompts.length > 1 ? "s" : ""} (${this.queue.length})`,
                });
              }
              // Do not post stranded_interject to the webview — it was silently
              // dropped there. Host owns the queue; finally / drainQueueIfIdle
              // starts the next turn.
              return;
            }
            if (ev.type === "file_changed" && ev.path) {
              this.post(ev);
              if (
                vscode.workspace
                  .getConfiguration("clawagents")
                  .get<boolean>("autoOpenChangedFiles", false)
              ) {
                this.scheduleAutoOpenChangedFile(ev.path);
              }
              return;
            }
            this.post(ev);
          },
        },
        model,
        this.autoApprove,
        this.mode === "read_only" ? "interactive" : this.interaction,
        this.caveman,
        this.goalMode,
        images,
        files,
      );
      if (newId) {
        this.chatId = newId;
        await this.persistLocal(this.persistState());
        await this.refreshChats();
      }
    } catch (err) {
      if (!signal.aborted) {
        this.post({
          type: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    } finally {
      this.abort = undefined;
      // cancelTask owns queue drain while Stop is in flight.
      if (this.cancelling) {
        return;
      }
      this.drainQueueIfIdle(includeContext);
    }
  }

  /** Start the next queued turn when no run is active (fixes interject race). */
  private drainQueueIfIdle(includeContext = true): void {
    if (this.abort || this.cancelling) {
      return;
    }
    const next = this.queue.shift();
    if (next) {
      void this.runTask(next, includeContext, this.chatId);
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const dist = path.join(this.context.extensionPath, "webview", "dist");
    const nonce = getNonce();
    let scriptSrc = "";
    let styleSrc: string | undefined;
    const assetsDir = path.join(dist, "assets");
    if (fs.existsSync(assetsDir)) {
      const files = fs.readdirSync(assetsDir);
      const js = files.find((f) => f.endsWith(".js"));
      const css = files.find((f) => f.endsWith(".css"));
      // Bust webview cache: Vite emits stable index.js/index.css names, and
      // retainContextWhenHidden keeps the previous document until reload.
      const bust = (file: string) => {
        const full = path.join(assetsDir, file);
        const ver = this.context.extension.packageJSON?.version || "0";
        const mtime = fs.statSync(full).mtimeMs | 0;
        return webview
          .asWebviewUri(vscode.Uri.file(full))
          .with({ query: `v=${ver}.${mtime}` })
          .toString();
      };
      if (js) {
        scriptSrc = bust(js);
      }
      if (css) {
        styleSrc = bust(css);
      }
    }
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      // webview.cspSource is required for <script src="…">; nonce alone is not enough
      // for module scripts and leaves the CLAWAGENTS tab spinning forever.
      `script-src 'nonce-${nonce}' ${webview.cspSource}`,
      `img-src ${webview.cspSource} data:`,
      `font-src ${webview.cspSource}`,
      `connect-src 'none'`,
    ].join("; ");
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>ClawAgents</title>
  ${styleSrc ? `<link rel="stylesheet" href="${styleSrc}" />` : ""}
</head>
<body>
  <div id="root"></div>
  <script type="module" nonce="${nonce}" src="${scriptSrc}"></script>
</body>
</html>`;
  }
}

function stripEditorContextForDisplay(text: string): string {
  const mark = "\n\n---\nEditor context:\n";
  const idx = text.indexOf(mark);
  return idx >= 0 ? text.slice(0, idx).replace(/\s+$/, "") : text;
}

function eventsToItems(events: Array<Record<string, unknown>>): unknown[] {
  const items: unknown[] = [];
  for (const ev of events) {
    const kind = ev.kind;
    if (kind === "user") {
      items.push({
        kind: "user",
        text: stripEditorContextForDisplay(String(ev.text || "")),
      });
    } else if (kind === "assistant") {
      items.push({ kind: "assistant", text: String(ev.text || "") });
    } else if (kind === "done") {
      items.push({
        kind: "status",
        text: `Done · ${ev.status || "done"}${ev.iterations != null ? ` · ${ev.iterations} iters` : ""}`,
      });
    }
  }
  return items;
}

function getNonce(): string {
  return crypto.randomBytes(16).toString("base64url");
}
