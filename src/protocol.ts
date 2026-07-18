/** Typed messages between the extension host and the webview. */

export type AgentMode = "ask" | "read_only" | "auto" | "full_access";

/** How the agent talks to you during a turn. */
export type InteractionStyle = "interactive" | "auto";

export type AutoApprove = {
  edit: boolean;
  execute: boolean;
  web: boolean;
  /** browser_* tools (requires Settings → Browser tools). */
  browser: boolean;
};

export type ChatSummary = {
  id: string;
  title: string;
  mode?: AgentMode;
  updated_at?: number;
  message_count?: number;
  session_cost_usd?: number;
  session_prompt_tokens?: number;
  session_completion_tokens?: number;
  session_total_tokens?: number;
};

export type HostToWebview =
  | {
      type: "ready";
      workspace?: string;
      model?: string;
      mode: AgentMode;
      interaction?: InteractionStyle;
      caveman?: boolean;
      goal?: boolean;
      hasApiKey: boolean;
      hasTavilyKey?: boolean;
      hasBedrockKey?: boolean;
      hasAwsCreds?: boolean;
      hasOpenAIKey?: boolean;
      hasAnthropicKey?: boolean;
      hasGeminiKey?: boolean;
      sidecar: "stopped" | "running";
      chatId?: string;
      chats?: ChatSummary[];
      settings?: Record<string, unknown>;
      providers?: unknown[];
      diagnostics?: unknown;
      stats?: unknown;
      mcp?: unknown[];
      /** Prefer Settings / clawagents.includeContextByDefault for the Context checkbox. */
      includeContextByDefault?: boolean;
    }
  | { type: "status"; message: string }
  | { type: "view_hidden" }
  | { type: "user_echo"; text: string }
  | { type: "assistant_delta"; delta: string }
  | { type: "assistant_message"; text: string }
  | { type: "tool_started"; id: string; name: string; args?: unknown; filePath?: string }
  | {
      type: "tool_completed";
      id: string;
      name: string;
      success: boolean;
      output?: string;
      filePath?: string;
    }
  | {
      type: "permission_required";
      requestId: string;
      tool: string;
      filePath?: string;
      command?: string;
      reason?: string;
    }
  | { type: "ask_user_required"; requestId: string; question: string }
  | {
      type: "file_changed";
      path: string;
      snapshotId?: string;
      snapshotRel?: string;
    }
  | {
      type: "usage";
      promptTokens?: number;
      completionTokens?: number;
      totalTokens?: number;
      runCostUsd?: number;
      sessionCostUsd?: number;
      lastInputTokens?: number;
    }
  | {
      type: "compact_progress";
      phase: string;
      message?: string;
    }
  | {
      type: "checkpoint";
      sha: string;
      tool?: string;
      phase?: string;
      label?: string;
      messageCount?: number;
      ts?: number;
    }
  | {
      type: "done";
      status: string;
      result?: string;
      iterations?: number;
      usage?: unknown;
      sessionCostUsd?: number;
      runCostUsd?: number;
    }
  | { type: "error"; message: string }
  | { type: "cancelled" }
  | { type: "prepend"; text: string }
  | {
      type: "restore";
      items: unknown[];
      draft?: string;
      mode: AgentMode;
      chatId?: string;
      autoApprove?: AutoApprove;
      interaction?: InteractionStyle;
      caveman?: boolean;
      goal?: boolean;
      sessionCostUsd?: number;
    }
  | { type: "chats"; chats: ChatSummary[]; chatId?: string }
  | { type: "settings"; settings: Record<string, unknown>; providers?: unknown[] }
  | {
      type: "skills_preview";
      folders: Array<{ path: string; origin: string }>;
      skills: Array<{
        name: string;
        description: string;
        when_to_use?: string;
        paths?: string[];
        path: string;
        source_dir: string;
        excluded?: boolean;
      }>;
      excluded: string[];
      ignored_dirs: string[];
      auto_discover: boolean;
      unavailable?: Record<string, string>;
      /** Skill name → quarantine reason from the sidecar's load-time content scan. */
      quarantined?: Record<string, string>;
      warnings?: string[];
    }
  | { type: "skill_dir_picked"; path: string }
  // Image attachments pending for the next send (chip metadata only — the
  // base64 bytes stay in the extension host and never touch the webview).
  | { type: "images_pending"; images: Array<{ id: string; name: string }> }
  // File attachments (PDF/DOCX) pending for the next send — same contract.
  | { type: "files_pending"; files: Array<{ id: string; name: string }> }
  | { type: "attachment_staged"; requestId: string }
  | { type: "verify_result"; provider: string; ok: boolean; detail?: string }
  | { type: "diagnostics"; data: unknown }
  | { type: "stats"; data: unknown }
  | {
      type: "bug_report_result";
      ok: boolean;
      detail: string;
    }
  | {
      type: "bug_report_screenshot";
      ok: boolean;
      screenshot?: { name: string; mediaType: string; data: string };
      detail?: string;
    }
  | {
      type: "dictation_state";
      recording: boolean;
      target: "composer" | "bug_report";
      detail?: string;
    }
  | {
      /** Re-focus composer/bug-report after mic QuickPick steals focus. */
      type: "dictation_focus";
      target: "composer" | "bug_report";
    }
  | {
      type: "dictation_result";
      target: "composer" | "bug_report";
      text: string;
    }
  | {
      type: "dictation_error";
      target: "composer" | "bug_report";
      detail: string;
    }
  | { type: "sidecar"; state: "stopped" | "starting" | "running" | "error"; detail?: string }
  | {
      type: "checkpoints";
      checkpoints: Array<Record<string, unknown>>;
      /** When false, refresh the chip only — don't open the panel. Default true. */
      open?: boolean;
    }
  | {
      type: "hunks";
      hunks: Array<Record<string, unknown>>;
      open?: boolean;
    }
  | {
      type: "rewind";
      snapshots: Array<Record<string, unknown>>;
      open?: boolean;
    }
  | {
      type: "stranded_interject";
      prompts: string[];
    };

export type WebviewToHost =
  | { type: "ready" }
  | {
      type: "send";
      text: string;
      mode: AgentMode;
      includeContext: boolean;
      chatId?: string;
      autoApprove?: AutoApprove;
      model?: string;
      interaction?: InteractionStyle;
      caveman?: boolean;
      goal?: boolean;
    }
  | { type: "cancel" }
  | {
      type: "permission";
      requestId: string;
      decision: "allow_once" | "allow_always" | "deny";
    }
  | { type: "ask_user_reply"; requestId: string; answer?: string; skip?: boolean }
  | { type: "clear" }
  | { type: "new_chat" }
  | { type: "select_chat"; chatId: string }
  | { type: "delete_chat"; chatId: string }
  | { type: "search_chats"; query: string }
  | { type: "regenerate" }
  | { type: "set_mode"; mode: AgentMode }
  | { type: "set_interaction"; interaction: InteractionStyle }
  | { type: "set_goal"; goal: boolean }
  | { type: "insert_context"; kind: "file" | "selection" | "problems" | "editors" | "terminal" | "git" }
  | { type: "attach_uris"; uris: string[] }
  | {
      type: "attach_local_files";
      requestId: string;
      files: Array<{ name: string; mediaType: string; data: string }>;
    }
  | { type: "pick_attach_files" }
  | { type: "remove_image"; id: string }
  | { type: "clear_images" }
  | { type: "remove_file"; id: string }
  | { type: "clear_files" }
  | { type: "open_file"; path: string; line?: number }
  | { type: "diff_snapshot"; path: string; snapshotId?: string; snapshotRel?: string }
  | { type: "restore_snapshot"; snapshotId: string; rel: string }
  | { type: "restore_checkpoint"; sha: string; mode: "files" | "conversation" | "both" }
  | { type: "compact_chat" }
  | { type: "list_checkpoints"; open?: boolean }
  | { type: "list_hunks"; open?: boolean }
  | { type: "accept_hunk"; hunkId?: string; path?: string }
  | { type: "reject_hunk"; hunkId: string }
  | { type: "list_rewind"; open?: boolean }
  | { type: "rewind_to"; promptIndex: number }
  | { type: "interject"; text: string }
  | { type: "restart_sidecar" }
  | { type: "load_settings" }
  | { type: "save_settings"; settings: Record<string, unknown> }
  | { type: "load_skills" }
  | { type: "pick_skill_dir" }
  | { type: "verify_key"; provider: string }
  | { type: "set_api_key" }
  | { type: "set_bedrock_key"; apiKey: string }
  | {
      type: "set_provider_key";
      provider: "openai" | "anthropic" | "gemini" | "bedrock" | "tavily";
      apiKey: string;
    }
  | {
      type: "clear_provider_key";
      provider: "openai" | "anthropic" | "gemini" | "bedrock" | "tavily";
    }
  | { type: "test_bedrock_gateway"; baseUrl: string; apiKey?: string }
  | {
      type: "test_compatible_endpoint";
      baseUrl: string;
      apiKey?: string;
      style?: "openai" | "bag";
      provider?: string;
    }
  | { type: "clear_api_key" }
  | { type: "load_diagnostics" }
  | { type: "load_stats" }
  | {
      type: "persist";
      items: unknown[];
      draft: string;
      mode: AgentMode;
      chatId?: string;
      autoApprove?: AutoApprove;
      interaction?: InteractionStyle;
      caveman?: boolean;
      goal?: boolean;
    }
  | { type: "queue_send"; text: string }
  | { type: "bug_report_capture_screenshot" }
  | {
      type: "bug_report_submit";
      text: string;
      screenshots: Array<{ name: string; mediaType: string; data: string }>;
    }
  | {
      type: "dictation_toggle";
      target?: "composer" | "bug_report";
      /** Re-show mic QuickPick (e.g. Alt/⌥+Mic). Default: reuse session mic. */
      forcePick?: boolean;
    };

const NO_PAYLOAD_MESSAGES = new Set([
  "ready", "cancel", "clear", "new_chat", "regenerate", "pick_attach_files",
  "clear_images", "clear_files", "compact_chat", "restart_sidecar", "load_settings",
  "load_skills", "pick_skill_dir", "set_api_key", "clear_api_key", "load_diagnostics",
  "load_stats", "bug_report_capture_screenshot",
]);
const AGENT_MODES = new Set(["ask", "read_only", "auto", "full_access"]);
const PROVIDERS = new Set(["openai", "anthropic", "gemini", "bedrock", "tavily"]);
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, max = 1_000_000): value is string {
  return typeof value === "string" && value.length <= max;
}

function optionalText(value: unknown, max = 1_000_000): boolean {
  return value === undefined || text(value, max);
}

function opaqueId(value: unknown): value is string {
  return typeof value === "string" && OPAQUE_ID.test(value) && !value.includes("..");
}

function autoApprove(value: unknown): boolean {
  if (value === undefined) return true;
  if (!record(value)) return false;
  return ["edit", "execute", "web", "browser"].every(
    (key) => value[key] === undefined || typeof value[key] === "boolean",
  );
}

/** Decode the untrusted webview message before it reaches extension authority. */
export function parseWebviewToHost(value: unknown): WebviewToHost | undefined {
  if (!record(value) || typeof value.type !== "string") return undefined;
  const type = value.type;
  if (NO_PAYLOAD_MESSAGES.has(type)) return value as WebviewToHost;
  switch (type) {
    case "send":
      return text(value.text) && AGENT_MODES.has(String(value.mode))
        && typeof value.includeContext === "boolean" && optionalText(value.chatId, 128)
        && autoApprove(value.autoApprove) && optionalText(value.model, 256)
        && (value.interaction === undefined || value.interaction === "interactive" || value.interaction === "auto")
        && (value.caveman === undefined || typeof value.caveman === "boolean")
        && (value.goal === undefined || typeof value.goal === "boolean")
        ? value as WebviewToHost : undefined;
    case "queue_send":
      return text(value.text) ? value as WebviewToHost : undefined;
    case "bug_report_submit":
      return text(value.text, 100_000)
        && Array.isArray(value.screenshots)
        && value.screenshots.length <= 6
        && value.screenshots.every(
          (file) =>
            record(file)
            && text(file.name, 512)
            && text(file.mediaType, 128)
            && text(file.data, 14_000_000),
        )
        ? value as WebviewToHost
        : undefined;
    case "dictation_toggle":
      return (value.target === undefined
        || value.target === "composer"
        || value.target === "bug_report")
        && (value.forcePick === undefined || typeof value.forcePick === "boolean")
        ? value as WebviewToHost
        : undefined;
    case "permission":
      return opaqueId(value.requestId) && ["allow_once", "allow_always", "deny"].includes(String(value.decision))
        ? value as WebviewToHost : undefined;
    case "ask_user_reply":
      return opaqueId(value.requestId) && optionalText(value.answer)
        && (value.skip === undefined || typeof value.skip === "boolean")
        ? value as WebviewToHost : undefined;
    case "select_chat": case "delete_chat":
      return opaqueId(value.chatId) ? value as WebviewToHost : undefined;
    case "search_chats":
      return text(value.query, 10_000) ? value as WebviewToHost : undefined;
    case "set_mode":
      return AGENT_MODES.has(String(value.mode)) ? value as WebviewToHost : undefined;
    case "set_interaction":
      return value.interaction === "interactive" || value.interaction === "auto"
        ? value as WebviewToHost : undefined;
    case "set_goal":
      return typeof value.goal === "boolean" ? value as WebviewToHost : undefined;
    case "insert_context":
      return ["file", "selection", "problems", "editors", "terminal", "git"].includes(String(value.kind))
        ? value as WebviewToHost : undefined;
    case "attach_uris":
      return Array.isArray(value.uris) && value.uris.length <= 12 && value.uris.every((uri) => text(uri, 16_384))
        ? value as WebviewToHost : undefined;
    case "attach_local_files":
      return opaqueId(value.requestId) && Array.isArray(value.files) && value.files.length <= 12
        && value.files.every((file) => record(file) && text(file.name, 512)
          && text(file.mediaType, 128) && text(file.data, 14_000_000))
        ? value as WebviewToHost : undefined;
    case "remove_image": case "remove_file":
      return opaqueId(value.id) ? value as WebviewToHost : undefined;
    case "open_file":
      return text(value.path, 32_768)
        && (value.line === undefined || (Number.isInteger(value.line) && Number(value.line) > 0))
        ? value as WebviewToHost : undefined;
    case "diff_snapshot":
      return text(value.path, 32_768) && optionalText(value.snapshotId, 128) && optionalText(value.snapshotRel, 32_768)
        ? value as WebviewToHost : undefined;
    case "restore_snapshot":
      return opaqueId(value.snapshotId) && text(value.rel, 32_768) ? value as WebviewToHost : undefined;
    case "restore_checkpoint":
      return text(value.sha, 256) && ["files", "conversation", "both"].includes(String(value.mode))
        ? value as WebviewToHost : undefined;
    case "list_checkpoints":
      return value.open === undefined || typeof value.open === "boolean" ? value as WebviewToHost : undefined;
    case "list_hunks":
      return value.open === undefined || typeof value.open === "boolean" ? value as WebviewToHost : undefined;
    case "accept_hunk":
      return optionalText(value.hunkId, 256)
        && (value.path === undefined || (text(value.path, 32_768) && !String(value.path).includes("..") && !String(value.path).startsWith("/")))
        ? value as WebviewToHost : undefined;
    case "reject_hunk":
      return text(value.hunkId, 256) ? value as WebviewToHost : undefined;
    case "list_rewind":
      return value.open === undefined || typeof value.open === "boolean" ? value as WebviewToHost : undefined;
    case "rewind_to":
      return typeof value.promptIndex === "number" && Number.isFinite(value.promptIndex) && value.promptIndex >= 0
        ? value as WebviewToHost : undefined;
    case "interject":
      return text(value.text) && optionalText(value.chatId, 128)
        ? value as WebviewToHost : undefined;
    case "save_settings":
      return record(value.settings) ? value as WebviewToHost : undefined;
    case "verify_key":
      return text(value.provider, 64) ? value as WebviewToHost : undefined;
    case "set_bedrock_key":
      return text(value.apiKey, 65_536) ? value as WebviewToHost : undefined;
    case "set_provider_key":
      return PROVIDERS.has(String(value.provider)) && text(value.apiKey, 65_536)
        ? value as WebviewToHost : undefined;
    case "clear_provider_key":
      return PROVIDERS.has(String(value.provider)) ? value as WebviewToHost : undefined;
    case "test_bedrock_gateway":
      return text(value.baseUrl, 16_384) && optionalText(value.apiKey, 65_536)
        ? value as WebviewToHost : undefined;
    case "test_compatible_endpoint":
      return text(value.baseUrl, 16_384) && optionalText(value.apiKey, 65_536)
        && (value.style === undefined || value.style === "openai" || value.style === "bag")
        && optionalText(value.provider, 64) ? value as WebviewToHost : undefined;
    case "persist":
      return Array.isArray(value.items) && value.items.length <= 100_000 && text(value.draft)
        && AGENT_MODES.has(String(value.mode)) && optionalText(value.chatId, 128)
        && autoApprove(value.autoApprove)
        && (value.interaction === undefined || value.interaction === "interactive" || value.interaction === "auto")
        && (value.caveman === undefined || typeof value.caveman === "boolean")
        && (value.goal === undefined || typeof value.goal === "boolean")
        ? value as WebviewToHost : undefined;
    default:
      return undefined;
  }
}
