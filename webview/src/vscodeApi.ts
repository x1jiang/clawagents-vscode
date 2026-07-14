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
      includeContextByDefault?: boolean;
    }
  | { type: "status"; message: string }
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
  | { type: "images_pending"; images: Array<{ id: string; name: string }> }
  | { type: "verify_result"; provider: string; ok: boolean; detail?: string }
  | { type: "diagnostics"; data: unknown }
  | { type: "stats"; data: unknown }
  | { type: "sidecar"; state: "stopped" | "starting" | "running" | "error"; detail?: string }
  | {
      type: "checkpoints";
      checkpoints: Array<Record<string, unknown>>;
      open?: boolean;
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
  | {
      type: "insert_context";
      kind: "file" | "selection" | "problems" | "editors" | "terminal" | "git";
    }
  | { type: "attach_uris"; uris: string[] }
  | { type: "pick_attach_files" }
  | { type: "remove_image"; id: string }
  | { type: "clear_images" }
  | { type: "open_file"; path: string; line?: number }
  | { type: "diff_snapshot"; path: string; snapshotId?: string; snapshotRel?: string }
  | { type: "restore_snapshot"; snapshotId: string; rel: string }
  | { type: "restore_checkpoint"; sha: string; mode: "files" | "conversation" | "both" }
  | { type: "compact_chat" }
  | { type: "list_checkpoints"; open?: boolean }
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
    }
  | { type: "queue_send"; text: string };

interface VsCodeApi {
  postMessage(message: WebviewToHost): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

let api: VsCodeApi | undefined;

export function getVsCodeApi(): VsCodeApi {
  if (!api) {
    api = acquireVsCodeApi();
  }
  return api;
}

export function post(message: WebviewToHost): void {
  getVsCodeApi().postMessage(message);
}
