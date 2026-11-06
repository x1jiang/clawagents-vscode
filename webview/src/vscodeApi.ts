/** Webview ↔ host messaging. Types are owned by src/protocol.ts (single source). */

export type {
  AgentMode,
  InteractionStyle,
  AutoApprove,
  ChatSummary,
  ChatGroup,
  HostToWebview,
  JobSummary,
  ModelRoute,
  QueryIndexEntry,
  WebviewToHost,
} from "../../src/protocol";
export { PINNED_CONTEXT_MAX_CHARS, PLAN_FEEDBACK_MAX_CHARS } from "../../src/protocol";

import type { HostToWebview, WebviewToHost } from "../../src/protocol";
import { HumanTiming } from "../../src/humanTiming";

interface VsCodeApi {
  postMessage(message: WebviewToHost): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

let api: VsCodeApi | undefined;

export function hasVsCodeHost(): boolean {
  return typeof acquireVsCodeApi === "function";
}

/**
 * Vite/browser preview does not inject VS Code's webview bridge. Keep a tiny
 * in-memory substitute so the UI can render for local visual checks without
 * altering the production webview path.
 */
function previewApi(): VsCodeApi {
  let state: unknown;
  let humanTimingEnabled = true;
  const humanTiming = new HumanTiming();
  const emit = (message: HostToWebview) => {
    window.setTimeout(() => {
      window.dispatchEvent(new MessageEvent("message", { data: message }));
    }, 0);
  };
  return {
    postMessage: (message) => {
      // A preview has no host to answer these messages. Logging makes the
      // intended host request inspectable without producing a blank UI.
      console.debug("[ClawAgents webview preview]", message);
      if (message.type === "ready") {
        emit({
          type: "ready",
          workspace: "/preview/clawagents-vscode",
          model: "gpt-5.6-terra",
          mode: "auto",
          hasApiKey: true,
          hasOpenAIKey: true,
          sidecar: "running",
          chatId: "preview-main",
          chats: [{ id: "preview-main", title: "Implement side chat" }],
          settings: { provider: "openai", model: "gpt-5.6-terra" },
          providers: [],
          diagnostics: {
            ok: true,
            checks: [
              { name: "python", ok: true, detail: "3.13.14" },
              { name: "workspace", ok: true, detail: "/preview/clawagents-vscode" },
              { name: "clawagents", ok: true, detail: "6.20.1" },
              { name: "api_key", ok: true, detail: "OpenAI configured" },
              { name: "model", ok: true, detail: "gpt-5.6-terra" },
              { name: "mcp_config", ok: false, detail: "none" },
            ],
          },
          stats: {
            turns: 4,
            tokens: 1280,
            errors: 0,
            telemetry_enabled: false,
          },
        });
      } else if (message.type === "set_human_timing") {
        humanTimingEnabled = message.enabled;
        if (!humanTimingEnabled) humanTiming.stop();
        emit({ type: "human_timing_enabled", enabled: humanTimingEnabled });
      } else if (message.type === "human_view_focus" && !message.focused && humanTimingEnabled) {
        humanTiming.suspendInput();
        humanTiming.suspendReading();
      } else if (message.type === "human_reading" && humanTimingEnabled) {
        if (message.active) {
          humanTiming.suspendInput();
          humanTiming.pulse(message.chatId, "reading");
        } else humanTiming.suspendReading();
      } else if (message.type === "human_input" && humanTimingEnabled) {
        if (message.active) {
          humanTiming.suspendReading();
          humanTiming.pulse(message.chatId || "preview-main", "input");
        }
        else humanTiming.stop("input");
      } else if (message.type === "get_human_timing" && humanTimingEnabled) {
        emit({ type: "human_timing", chatId: message.chatId, totals: humanTiming.snapshot(message.chatId) });
      } else if (message.type === "open_side_chat") {
        emit({
          type: "side_chat_open",
          parentChatId: message.chatId || "preview-main",
          chatId: "preview-side",
          title: "Implement side chat (fork)",
          mode: "auto",
          items: [
            { kind: "user", text: "Can we keep the main conversation open?" },
            { kind: "assistant", text: "Yes — this fork stays in a temporary side panel." },
          ],
        });
      } else if (message.type === "send") {
        const chatId = message.chatId || "preview-main";
        const isSideChat = chatId === "preview-side";
        emit({ type: "thread_run_state", chatId, running: true });
        emit({ type: "user_echo", text: message.text, chatId });
        const delay = isSideChat ? 200 : 900;
        window.setTimeout(() => emit({
          type: "assistant_message",
          text: isSideChat
            ? "This is a browser-preview response from the forked thread."
            : "This is a browser-preview response from the main conversation.",
          chatId,
        }), delay);
        window.setTimeout(() => emit({
          type: "done",
          status: "completed",
          chatId,
        }), delay + 20);
        window.setTimeout(() => emit({
          type: "thread_run_state",
          chatId,
          running: false,
        }), delay + 25);
      }
    },
    getState: () => state,
    setState: (next) => {
      state = next;
    },
  };
}

export function getVsCodeApi(): VsCodeApi {
  if (!api) {
    api = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : previewApi();
  }
  return api;
}

export function post(message: WebviewToHost): void {
  getVsCodeApi().postMessage(message);
}
