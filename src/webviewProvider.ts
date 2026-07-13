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
import { GatewayClient } from "./gatewayClient";
import type {
  AgentMode,
  AutoApprove,
  ChatSummary,
  HostToWebview,
  InteractionStyle,
  WebviewToHost,
} from "./protocol";
import { SidecarManager } from "./sidecar";

export const SIDEBAR_ID = "clawagents.sidebar";
export const SIDEBAR_ACTIVITY_ID = "clawagents.sidebarActivity";
const STATE_KEY = "clawagents.chatState.v2";

const DEFAULT_AUTO_APPROVE: AutoApprove = {
  edit: false,
  execute: false,
  web: false,
  browser: false,
};

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
  private mode: AgentMode;
  private interaction: InteractionStyle = "interactive";
  private caveman = false;
  private autoApprove: AutoApprove = DEFAULT_AUTO_APPROVE;
  private queue: string[] = [];
  private readonly gateway: GatewayClient;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly sidecar: SidecarManager,
    private readonly config: ExtensionConfig,
  ) {
    this.gateway = new GatewayClient(() => this.sidecar.current);
    this.mode = this.config.defaultMode;
    // Chats live under the workspace's .clawagents dir, so the pointer to
    // the active chat must be workspace-scoped too.
    const saved = context.workspaceState.get<PersistedState>(STATE_KEY);
    if (saved) {
      this.mode = saved.mode || this.mode;
      this.chatId = saved.chatId;
      if (saved.autoApprove) {
        this.autoApprove = { ...DEFAULT_AUTO_APPROVE, ...saved.autoApprove };
      }
      if (saved.interaction === "interactive" || saved.interaction === "auto") {
        this.interaction = saved.interaction;
      }
      if (typeof saved.caveman === "boolean") {
        this.caveman = saved.caveman;
      }
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
    webviewView.webview.onDidReceiveMessage((msg: WebviewToHost) => {
      void this.handleMessage(msg);
    });
  }

  post(msg: HostToWebview): void {
    void this.view?.webview.postMessage(msg);
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
    this.abort?.abort();
    this.abort = undefined;
    try {
      await this.gateway.cancel();
    } catch {
      /* ignore */
    }
    this.post({ type: "cancelled" });
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
    if (!this.chatId) {
      return;
    }
    try {
      const chat = await this.gateway.getChat(this.chatId);
      const events = (chat.events as Array<Record<string, unknown>>) || [];
      const items = eventsToItems(events);
      this.post({
        type: "restore",
        items,
        draft: "",
        mode: this.mode,
        chatId: this.chatId,
        autoApprove: this.autoApprove,
        interaction: this.interaction,
        caveman: this.caveman,
        sessionCostUsd: sessionCostFromChat(chat),
      });
    } catch {
      /* ignore */
    }
  }

  private async pushReady(): Promise<void> {
    let health: { model?: string; workspace?: string; provider?: string } | undefined;
    try {
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
      providers = await this.gateway.getProviders();
      diagnostics = await this.gateway.getDiagnostics();
      stats = await this.gateway.getStats();
      mcp = await this.gateway.getMcp();
      await warnUntrustedBaseUrl(settings);
    } catch {
      /* partial — sidecar may still be starting or down */
    }
    this.post({
      type: "ready",
      workspace: workspaceRoot(),
      model: health?.model || this.config.model || String(settings.model || "default"),
      mode: this.mode,
      interaction: this.interaction,
      caveman: this.caveman,
      hasApiKey: await this.config.hasAnyApiKey(),
      hasTavilyKey: await this.config.hasTavilyKey(),
      hasBedrockKey: Boolean((await this.config.getApiKeyEnv()).BEDROCK_API_KEY),
      hasAwsCreds: this.config.hasAwsCredentials(),
      hasOpenAIKey: Boolean((await this.config.getApiKeyEnv()).OPENAI_API_KEY),
      hasGeminiKey: Boolean(
        (await this.config.getApiKeyEnv()).GEMINI_API_KEY ||
          (await this.config.getApiKeyEnv()).GOOGLE_API_KEY,
      ),
      sidecar: this.sidecar.current ? "running" : "stopped",
      chatId: this.chatId,
      chats,
      settings,
      providers,
      diagnostics,
      stats,
      mcp,
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
        if (this.mode === "read_only") {
          this.interaction = "interactive";
        }
        await this.runTask(msg.text, msg.includeContext, msg.chatId, msg.model);
        break;
      case "queue_send":
        this.queue.push(msg.text);
        this.post({ type: "status", message: `Queued (${this.queue.length})` });
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
      case "clear":
      case "new_chat":
        await this.newChat();
        break;
      case "select_chat":
        this.chatId = msg.chatId;
        await this.persistLocal(this.persistState());
        try {
          const chat = await this.gateway.getChat(msg.chatId);
          const events = (chat.events as Array<Record<string, unknown>>) || [];
          this.post({
            type: "restore",
            items: eventsToItems(events),
            draft: "",
            mode: (chat.mode as AgentMode) || this.mode,
            chatId: msg.chatId,
            autoApprove: this.autoApprove,
            interaction: this.interaction,
            caveman: this.caveman,
            sessionCostUsd: sessionCostFromChat(chat),
          });
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
          const chat = await this.gateway.getChat(this.chatId);
          const events = (chat.events as Array<Record<string, unknown>>) || [];
          this.post({
            type: "restore",
            items: eventsToItems(events),
            draft: "",
            mode: (chat.mode as AgentMode) || this.mode,
            chatId: this.chatId,
            autoApprove: this.autoApprove,
            interaction: this.interaction,
            caveman: this.caveman,
            sessionCostUsd: sessionCostFromChat(chat),
          });
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
      case "insert_context":
        await this.insertContext(msg.kind);
        break;
      case "attach_uris":
        await this.attachUris(msg.uris);
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
            const chat = await this.gateway.getChat(this.chatId);
            const events = (chat.events as Array<Record<string, unknown>>) || [];
            this.post({
              type: "restore",
              items: eventsToItems(events),
              mode: (chat.mode as AgentMode) || this.mode,
              chatId: this.chatId,
            });
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
          const res = await this.gateway.compactChat(this.chatId);
          this.post({
            type: "status",
            message: res.compacted
              ? `Compacted ${String(res.before)} → ${String(res.after)} messages`
              : `Compact skipped: ${String(res.reason || "")}`,
          });
        } catch (err) {
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
      case "restart_sidecar":
        await this.restartSidecar();
        break;
      case "load_settings":
        try {
          const settings = await this.gateway.getSettings();
          const providers = await this.gateway.getProviders();
          this.post({ type: "settings", settings, providers });
          const skills = await this.gateway.getSkills();
          this.post({ type: "skills_preview", ...skills });
        } catch (err) {
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
      case "save_settings":
        try {
          const incoming = { ...(msg.settings || {}) } as Record<string, unknown>;
          let previous: Record<string, unknown> = {};
          try {
            previous = (await this.gateway.getSettings()) as Record<string, unknown>;
          } catch {
            previous = {};
          }
          const baseUrlProvided = Object.prototype.hasOwnProperty.call(incoming, "base_url");
          const baseUrl =
            typeof incoming.base_url === "string" ? incoming.base_url.trim() : "";
          const prevBaseUrl =
            typeof previous.base_url === "string" ? previous.base_url.trim() : "";
          // Bedrock Access Gateway / OpenAI-compatible: normalize pasted URLs.
          if (baseUrlProvided && baseUrl) {
            const provider = String(incoming.provider || previous.provider || "");
            if (provider === "bedrock") {
              const { normalizeBagBaseUrl } = await import("./bedrockGateway");
              incoming.base_url = normalizeBagBaseUrl(baseUrl);
            } else if (provider === "openai" || provider === "ollama") {
              const { normalizeOpenAICompatibleBaseUrl, normalizeBagBaseUrl } =
                await import("./bedrockGateway");
              incoming.base_url = baseUrl.includes("/api/v1")
                ? normalizeBagBaseUrl(baseUrl)
                : normalizeOpenAICompatibleBaseUrl(baseUrl);
            }
          }
          const normalizedBase = baseUrlProvided
            ? typeof incoming.base_url === "string"
              ? incoming.base_url.trim()
              : baseUrl
            : prevBaseUrl;
          const baseUrlChanged = baseUrlProvided && normalizedBase !== prevBaseUrl;
          // Only prompt when a new/changed custom URL isn't already trusted.
          // Partial patches (e.g. effort-only) must not clear trust / base_url.
          if (
            baseUrlProvided &&
            normalizedBase &&
            !isTrustedBaseUrl(normalizedBase) &&
            (baseUrlChanged || !previous.trust_custom_base_url)
          ) {
            const choice = await vscode.window.showWarningMessage(
              `Custom base URL "${normalizedBase}" will receive provider API keys. Only continue if you trust this endpoint.`,
              { modal: true },
              "Trust and save",
              "Cancel",
            );
            if (choice !== "Trust and save") {
              this.post({ type: "status", message: "Settings save cancelled" });
              this.post({
                type: "settings",
                settings: previous,
              });
              break;
            }
            incoming.trust_custom_base_url = true;
            // Corporate / private-CA gateways usually fail default TLS verify.
            if (/^https:\/\//i.test(normalizedBase)) {
              incoming.ssl_verify = false;
            }
          } else if (baseUrlProvided && !normalizedBase) {
            incoming.trust_custom_base_url = false;
          } else if (previous.trust_custom_base_url && !baseUrlChanged) {
            // Preserve trust across partial saves that omit base_url.
            if (!Object.prototype.hasOwnProperty.call(incoming, "trust_custom_base_url")) {
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
          this.post({ type: "settings", settings });
          this.post({ type: "status", message: "Settings saved" });
          try {
            const skills = await this.gateway.getSkills();
            this.post({ type: "skills_preview", ...skills });
          } catch {
            /* preview is best-effort after save */
          }
        } catch (err) {
          this.post({
            type: "error",
            message: err instanceof Error ? err.message : String(err),
          });
        }
        break;
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
          await this.config.setApiKey(msg.provider, msg.apiKey);
          this.sidecar.stop();
          await this.sidecar.ensureStarted();
          this.post({ type: "sidecar", state: "running" });
          await this.pushReady();
          const labels: Record<string, string> = {
            openai: "OpenAI / compatible",
            anthropic: "Anthropic",
            gemini: "Gemini",
            bedrock: "Bedrock Access Gateway",
          };
          this.post({
            type: "verify_result",
            provider: msg.provider,
            ok: true,
            detail: `${labels[msg.provider] || msg.provider} API key saved; sidecar restarted`,
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
          (await this.config.getApiKeyEnv()).BEDROCK_API_KEY ||
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
        const { probeCompatibleEndpoint } = await import("./bedrockGateway");
        const style = msg.style === "bag" ? "bag" : "openai";
        const env = await this.config.getApiKeyEnv();
        const provider = msg.provider || (style === "bag" ? "bedrock" : "openai");
        const key =
          (msg.apiKey || "").trim() ||
          (provider === "bedrock"
            ? env.BEDROCK_API_KEY
            : provider === "gemini"
              ? env.GEMINI_API_KEY || env.GOOGLE_API_KEY
              : env.OPENAI_API_KEY) ||
          "";
        const result = await probeCompatibleEndpoint(msg.baseUrl || "", key, {
          style,
          allowEmptyKey: style === "openai" && /localhost|127\.0\.0\.1/.test(msg.baseUrl || ""),
          label:
            style === "bag"
              ? "Bedrock Access Gateway"
              : "OpenAI-compatible endpoint",
        });
        this.post({
          type: "verify_result",
          provider,
          ok: result.ok,
          detail: result.detail,
        });
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
        if (rel) {
          refs.push(formatFileRef(rel).trimEnd());
        } else {
          skipped.push(vscode.workspace.asRelativePath(uri, false) || trimmed);
        }
      } catch {
        skipped.push(trimmed);
      }
    }
    if (refs.length) {
      this.post({ type: "prepend", text: `${refs.join("\n")}\n` });
      this.post({
        type: "status",
        message:
          refs.length === 1
            ? `Attached ${refs[0].replace(/^@/, "")}`
            : `Attached ${refs.length} files`,
      });
    } else {
      this.post({
        type: "status",
        message:
          "Drop workspace files onto the draft (hold Shift), or use +Attach.",
      });
    }
    if (skipped.length && !refs.length) {
      this.post({
        type: "error",
        message: `Not in workspace: ${skipped.slice(0, 3).join(", ")}`,
      });
    }
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

  private async openPath(filePath: string, line?: number): Promise<void> {
    try {
      const folders = vscode.workspace.workspaceFolders ?? [];
      if (!folders.length) {
        this.post({
          type: "error",
          message: "Open a workspace folder before opening paths from chat.",
        });
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
        this.post({
          type: "error",
          message: `Refusing to open path outside the workspace: ${filePath}`,
        });
        return;
      }
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc, { preview: true });
      if (line && line > 0) {
        const pos = new vscode.Position(line - 1, 0);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(new vscode.Range(pos, pos));
      }
    } catch (err) {
      this.post({
        type: "error",
        message: `Could not open ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
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

    this.post({ type: "user_echo", text: trimmed });
    this.post({ type: "sidecar", state: "starting" });

    try {
      await this.sidecar.ensureStarted();
      this.post({ type: "sidecar", state: "running" });
    } catch (err) {
      this.post({
        type: "sidecar",
        state: "error",
        detail: err instanceof Error ? err.message : String(err),
      });
      this.post({
        type: "error",
        message: `Failed to start Python sidecar: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }

    this.abort = new AbortController();
    const signal = this.abort.signal;
    try {
      const settings = await this.gateway
        .getSettings()
        .catch(() => ({}) as Record<string, unknown>);
      const model =
        (modelOverride && modelOverride !== "default" ? modelOverride : undefined) ||
        (typeof settings.model === "string" && settings.model
          ? settings.model
          : this.config.model || undefined);
      const newId = await this.gateway.streamChat(
        task,
        this.chatId,
        this.mode,
        {
          signal,
          onEvent: (ev) => this.post(ev),
        },
        model,
        this.autoApprove,
        this.mode === "read_only" ? "interactive" : this.interaction,
        this.caveman,
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
      const next = this.queue.shift();
      if (next) {
        void this.runTask(next, includeContext, this.chatId);
      }
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

function eventsToItems(events: Array<Record<string, unknown>>): unknown[] {
  const items: unknown[] = [];
  for (const ev of events) {
    const kind = ev.kind;
    if (kind === "user") {
      items.push({ kind: "user", text: String(ev.text || "") });
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
