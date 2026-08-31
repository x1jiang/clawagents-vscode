/** Webview ↔ host messaging. Types are owned by src/protocol.ts (single source). */

export type {
  AgentMode,
  InteractionStyle,
  AutoApprove,
  ChatSummary,
  HostToWebview,
  JobSummary,
  ModelRoute,
  WebviewToHost,
} from "../../src/protocol";
export { PINNED_CONTEXT_MAX_CHARS, PLAN_FEEDBACK_MAX_CHARS } from "../../src/protocol";

import type { HostToWebview, WebviewToHost } from "../../src/protocol";

interface VsCodeApi {
  postMessage(message: WebviewToHost): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

let api: VsCodeApi | undefined;

/**
 * Vite/browser preview does not inject VS Code's webview bridge. Keep a tiny
 * in-memory substitute so the UI can render for local visual checks without
 * altering the production webview path.
 */
function previewApi(): VsCodeApi {
  let state: unknown;
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
        });
      } else if (message.type === "open_side_chat") {
        emit({
          type: "side_chat_open",
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
