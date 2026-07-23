/** Webview ↔ host messaging. Types are owned by src/protocol.ts (single source). */

export type {
  AgentMode,
  InteractionStyle,
  AutoApprove,
  ChatSummary,
  HostToWebview,
  WebviewToHost,
} from "../../src/protocol";

import type { WebviewToHost } from "../../src/protocol";

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
  return {
    postMessage: (message) => {
      // A preview has no host to answer these messages. Logging makes the
      // intended host request inspectable without producing a blank UI.
      console.debug("[ClawAgents webview preview]", message);
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
