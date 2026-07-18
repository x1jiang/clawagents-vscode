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

export function getVsCodeApi(): VsCodeApi {
  if (!api) {
    api = acquireVsCodeApi();
  }
  return api;
}

export function post(message: WebviewToHost): void {
  getVsCodeApi().postMessage(message);
}
