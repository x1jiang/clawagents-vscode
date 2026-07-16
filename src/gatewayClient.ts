import * as http from "http";
import type { SidecarHandle } from "./sidecar";
import type { AgentMode, AutoApprove, HostToWebview, InteractionStyle } from "./protocol";

export type StreamHandlers = {
  onEvent: (msg: HostToWebview) => void;
  signal?: AbortSignal;
};

function requestJson<T>(
  handle: SidecarHandle,
  method: string,
  pathName: string,
  body?: unknown,
  timeoutMs = 8_000,
): Promise<T> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: handle.port,
        path: pathName,
        method,
        headers: {
          Authorization: `Bearer ${handle.token}`,
          ...(payload
            ? {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(payload),
              }
            : { "Content-Length": 0 }),
        },
        timeout: timeoutMs,
      },
      (res) => {
        let data = "";
        res.on("data", (c) => {
          data += c.toString();
        });
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`${method} ${pathName} HTTP ${res.statusCode}: ${data}`));
            return;
          }
          try {
            resolve((data ? JSON.parse(data) : {}) as T);
          } catch {
            resolve({} as T);
          }
        });
      },
    );
    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`${method} ${pathName} timed out after ${timeoutMs}ms`));
    });
    req.on("error", reject);
    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

function parseSseChunk(
  buffer: string,
): { events: Array<{ event: string; data: string }>; rest: string } {
  const events: Array<{ event: string; data: string }> = [];
  const parts = buffer.split("\n\n");
  const rest = parts.pop() ?? "";
  for (const part of parts) {
    if (!part.trim()) {
      continue;
    }
    let event = "message";
    const dataLines: string[] = [];
    for (const line of part.split("\n")) {
      if (line.startsWith("event:")) {
        event = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trim());
      }
    }
    events.push({ event, data: dataLines.join("\n") });
  }
  return { events, rest };
}

function extractFilePath(data: Record<string, unknown>): string | undefined {
  const args =
    typeof data.args === "object" && data.args
      ? (data.args as Record<string, unknown>)
      : data;
  const raw =
    args.path ?? args.file_path ?? args.target_path ?? data.file_path ?? data.path;
  return typeof raw === "string" ? raw : undefined;
}

function mapAgentEvent(kind: string, data: Record<string, unknown>): HostToWebview | null {
  switch (kind) {
    case "assistant_delta":
      return { type: "assistant_delta", delta: String(data.delta ?? data.text ?? "") };
    case "assistant_message":
      return {
        type: "assistant_message",
        text: String(data.content ?? data.text ?? data.message ?? ""),
      };
    case "tool_started":
    case "tool_call":
      return {
        type: "tool_started",
        id: String(data.call_id ?? data.id ?? data.name ?? Math.random().toString(36).slice(2)),
        name: String(data.name ?? data.tool_name ?? "tool"),
        args: data.args ?? data.input ?? data.rawInput,
        filePath: extractFilePath(data),
      };
    case "tool_completed":
    case "tool_result":
    case "tool_skipped": {
      // Prefer non-empty text: failed tools often have output="" and the
      // real message only in `error` (bash validator / empty command).
      const rawOut = data.output ?? data.preview ?? data.content;
      const err = data.error ?? data.reason;
      const outText =
        (typeof rawOut === "string" && rawOut.trim() ? rawOut : "") ||
        (typeof err === "string" && err.trim() ? err : "") ||
        "";
      const skipped = kind === "tool_skipped";
      return {
        type: "tool_completed",
        id: String(data.call_id ?? data.id ?? data.name ?? ""),
        name: String(data.name ?? data.tool_name ?? "tool"),
        // Trust the success flag; do not treat a present `error` field as
        // failure when success is explicitly true.
        success: skipped ? false : data.success !== false,
        output: outText.slice(0, 8000),
        filePath: extractFilePath(data),
      };
    }
    case "permission_required":
      return {
        type: "permission_required",
        requestId: String(data.request_id ?? data.requestId ?? ""),
        tool: String(data.tool ?? data.name ?? "tool"),
        filePath: data.file_path ? String(data.file_path) : undefined,
        command: data.command ? String(data.command) : undefined,
        reason: data.reason ? String(data.reason) : undefined,
      };
    case "ask_user_required":
      return {
        type: "ask_user_required",
        requestId: String(data.request_id ?? data.requestId ?? ""),
        question: String(data.question ?? data.prompt ?? ""),
      };
    case "usage":
      return {
        type: "usage",
        promptTokens: num(data.prompt_tokens ?? data.promptTokens ?? data.input_tokens),
        completionTokens: num(
          data.completion_tokens ?? data.completionTokens ?? data.output_tokens,
        ),
        totalTokens: num(data.total_tokens ?? data.totalTokens ?? data.tokens_used),
        runCostUsd: num(data.run_cost_usd ?? data.runCostUsd),
        sessionCostUsd: num(data.session_cost_usd ?? data.sessionCostUsd),
        lastInputTokens: num(
          data.last_input_tokens ?? data.prompt_tokens ?? data.input_tokens,
        ),
      };
    case "compact_progress":
      return {
        type: "compact_progress",
        phase: String(data.phase ?? ""),
        message: data.message ? String(data.message) : undefined,
      };
    case "context":
      return {
        type: "status",
        message: String(data.message ?? "context"),
      };
    case "checkpoint":
      return {
        type: "checkpoint",
        sha: String(data.sha ?? ""),
        tool: data.tool ? String(data.tool) : undefined,
        phase: data.phase ? String(data.phase) : undefined,
        label: data.label ? String(data.label) : undefined,
        messageCount: num(data.message_count ?? data.messageCount),
        ts: num(data.ts) ?? Math.floor(Date.now() / 1000),
      };
    case "approval_required":
      return {
        type: "permission_required",
        requestId: String(data.call_id ?? data.id ?? data.request_id ?? ""),
        tool: String(data.tool_name ?? data.name ?? data.tool ?? "tool"),
        reason: "Library require_approval",
      };
    case "warn":
      return { type: "status", message: `⚠ ${String(data.message ?? "warning")}` };
    case "error":
      return { type: "error", message: String(data.message ?? data.error ?? "Unknown error") };
    default:
      return null;
  }
}

function num(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

export class GatewayClient {
  constructor(private readonly getHandle: () => SidecarHandle | undefined) {}

  private requireHandle(): SidecarHandle {
    const h = this.getHandle();
    if (!h) {
      throw new Error("Sidecar is not running");
    }
    return h;
  }

  fetchHealth() {
    return requestJson<{ model?: string; workspace?: string; provider?: string }>(
      this.requireHandle(),
      "GET",
      "/health",
    ).catch(() => undefined);
  }

  listChats(q?: string) {
    const path = q ? `/chats?q=${encodeURIComponent(q)}` : "/chats";
    return requestJson<Array<Record<string, unknown>>>(this.requireHandle(), "GET", path);
  }

  createChat(mode: AgentMode = "auto") {
    return requestJson<Record<string, unknown>>(this.requireHandle(), "POST", "/chats", {
      mode,
    });
  }

  getChat(chatId: string) {
    return requestJson<Record<string, unknown>>(
      this.requireHandle(),
      "GET",
      `/chats/${encodeURIComponent(chatId)}`,
    );
  }

  deleteChat(chatId: string) {
    return requestJson<{ ok: boolean }>(
      this.requireHandle(),
      "DELETE",
      `/chats/${encodeURIComponent(chatId)}`,
    );
  }

  regenerate(chatId: string) {
    return requestJson<{ ok: boolean; task?: string; chat_id?: string }>(
      this.requireHandle(),
      "POST",
      `/chats/${encodeURIComponent(chatId)}/regenerate`,
    );
  }

  getProviders() {
    return requestJson<unknown[]>(this.requireHandle(), "GET", "/providers");
  }

  getSettings() {
    return requestJson<Record<string, unknown>>(this.requireHandle(), "GET", "/settings");
  }

  getSkills() {
    return requestJson<{
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
      /** name → why the skill can't run here (missing binary/env/OS). */
      unavailable?: Record<string, string>;
      /** name → why the skill was blocked by the content scanner. */
      quarantined?: Record<string, string>;
      /** Loader diagnostics (spec violations, oversized/skipped files). */
      warnings?: string[];
    }>(this.requireHandle(), "GET", "/skills");
  }

  putSettings(settings: Record<string, unknown>) {
    return requestJson<Record<string, unknown>>(
      this.requireHandle(),
      "PUT",
      "/settings",
      settings,
    );
  }

  verifyKey(provider: string) {
    return requestJson<{ ok: boolean; detail?: string }>(
      this.requireHandle(),
      "POST",
      "/settings/verify-key",
      { provider },
    );
  }

  getDiagnostics() {
    return requestJson<unknown>(this.requireHandle(), "GET", "/diagnostics");
  }

  getStats() {
    return requestJson<unknown>(this.requireHandle(), "GET", "/stats");
  }

  getMcp() {
    return requestJson<unknown[]>(this.requireHandle(), "GET", "/mcp");
  }

  restoreSnapshot(snapshotId: string, rel: string) {
    return requestJson<{ ok: boolean; restored?: string }>(
      this.requireHandle(),
      "POST",
      "/snapshots/restore",
      { snapshot_id: snapshotId, rel },
    );
  }

  latestSnapshot(path: string) {
    return requestJson<{ snapshot_id: string; rel: string; path: string }>(
      this.requireHandle(),
      "GET",
      `/snapshots/latest?path=${encodeURIComponent(path)}`,
    );
  }

  listCheckpoints(limit = 30) {
    return requestJson<Array<Record<string, unknown>>>(
      this.requireHandle(),
      "GET",
      `/checkpoints?limit=${limit}`,
    );
  }

  restoreCheckpoint(sha: string, mode: "files" | "conversation" | "both" = "files", chatId?: string) {
    return requestJson<Record<string, unknown>>(this.requireHandle(), "POST", "/checkpoints/restore", {
      sha,
      mode,
      chat_id: chatId,
    });
  }

  checkpointDiff(lhs: string, rhs?: string) {
    const q = new URLSearchParams({ lhs });
    if (rhs) q.set("rhs", rhs);
    return requestJson<{ ok: boolean; files?: Array<{ status: string; path: string }> }>(
      this.requireHandle(),
      "GET",
      `/checkpoints/diff?${q.toString()}`,
    );
  }

  listModes() {
    return requestJson<Array<{ id: string; name: string }>>(this.requireHandle(), "GET", "/modes");
  }

  compactChat(chatId: string) {
    return requestJson<Record<string, unknown>>(
      this.requireHandle(),
      "POST",
      `/chats/${encodeURIComponent(chatId)}/compact`,
      {},
    );
  }

  pauseActiveGoal() {
    return requestJson<Record<string, unknown>>(this.requireHandle(), "POST", "/goal/pause", {});
  }

  resumeActiveGoal() {
    return requestJson<Record<string, unknown>>(this.requireHandle(), "POST", "/goal/resume", {});
  }

  async streamChat(
    task: string,
    chatId: string | undefined,
    mode: AgentMode,
    handlers: StreamHandlers,
    model?: string,
    autoApprove?: AutoApprove,
    interaction?: InteractionStyle,
    caveman?: boolean,
    goal?: boolean,
    images?: Array<{ data: string; media_type: string }>,
    files?: Array<{ data: string; media_type: string; name: string }>,
  ): Promise<string | undefined> {
    const handle = this.requireHandle();
    const body = JSON.stringify({
      task,
      chat_id: chatId,
      session_id: chatId,
      lane: "main",
      mode,
      model: model || undefined,
      auto_approve: autoApprove,
      interaction: interaction || "interactive",
      caveman: Boolean(caveman),
      goal: Boolean(goal),
      images: images && images.length > 0 ? images : undefined,
      files: files && files.length > 0 ? files : undefined,
    });

    let resolvedChatId = chatId;
    // Whether the stream delivered a terminal event (done/error/cancelled).
    // Without one the webview would wait on "Running…" forever if the
    // sidecar dies mid-stream.
    let sawTerminal = false;
    const emit = (msg: HostToWebview) => {
      if (msg.type === "done" || msg.type === "error" || msg.type === "cancelled") {
        sawTerminal = true;
      }
      handlers.onEvent(msg);
    };

    await new Promise<void>((resolve, reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: handle.port,
          path: "/chat/stream",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${handle.token}`,
            "Content-Length": Buffer.byteLength(body),
            Accept: "text/event-stream",
          },
          // Socket idle timeout (resets on every byte). The sidecar sends a
          // keep-alive comment every 15s, so 60s of true silence means it is
          // hung/deadlocked — surface an error instead of spinning forever.
          timeout: 60_000,
        },
        (res) => {
          if (res.statusCode && res.statusCode >= 400) {
            let errBody = "";
            res.on("data", (c) => {
              errBody += c.toString();
            });
            res.on("end", () => {
              reject(new Error(`chat/stream HTTP ${res.statusCode}: ${errBody}`));
            });
            return;
          }

          let buffer = "";
          res.on("data", (chunk: Buffer) => {
            buffer += chunk.toString("utf8");
            const parsed = parseSseChunk(buffer);
            buffer = parsed.rest;
            for (const ev of parsed.events) {
              let data: Record<string, unknown> = {};
              try {
                data = ev.data ? (JSON.parse(ev.data) as Record<string, unknown>) : {};
              } catch {
                data = { raw: ev.data };
              }

              if (data.chat_id) {
                resolvedChatId = String(data.chat_id);
              }

              if (ev.event === "agent") {
                const kind = String(data.kind ?? "");
                const payload =
                  typeof data.data === "object" && data.data
                    ? (data.data as Record<string, unknown>)
                    : data;
                const mapped = mapAgentEvent(kind, payload);
                if (mapped) {
                  emit(mapped);
                }
              } else if (ev.event === "permission_required") {
                emit({
                  type: "permission_required",
                  requestId: String(data.request_id ?? ""),
                  tool: String(data.tool ?? "tool"),
                  filePath: data.file_path ? String(data.file_path) : undefined,
                  command: data.command ? String(data.command) : undefined,
                  reason: data.reason ? String(data.reason) : undefined,
                });
              } else if (ev.event === "ask_user_required") {
                emit({
                  type: "ask_user_required",
                  requestId: String(data.request_id ?? ""),
                  question: String(data.question ?? ""),
                });
              } else if (ev.event === "file_changed") {
                emit({
                  type: "file_changed",
                  path: String(data.path ?? ""),
                  snapshotId: data.snapshot_id ? String(data.snapshot_id) : undefined,
                  snapshotRel: data.snapshot_rel ? String(data.snapshot_rel) : undefined,
                });
              } else if (ev.event === "usage") {
                const usageObj = data as Record<string, unknown>;
                emit({
                  type: "usage",
                  promptTokens: num(data.prompt_tokens),
                  completionTokens: num(data.completion_tokens),
                  totalTokens: num(data.total_tokens),
                  lastInputTokens: num(
                    data.last_input_tokens ?? data.prompt_tokens ?? data.input_tokens,
                  ),
                  runCostUsd: num(usageObj.run_cost_usd),
                  sessionCostUsd: num(usageObj.session_cost_usd),
                });
              } else if (ev.event === "done") {
                const usageObj =
                  data.usage && typeof data.usage === "object"
                    ? (data.usage as Record<string, unknown>)
                    : {};
                emit({
                  type: "done",
                  status: String(data.status ?? "done"),
                  result: data.result != null ? String(data.result) : undefined,
                  iterations:
                    typeof data.iterations === "number" ? data.iterations : undefined,
                  usage: data.usage,
                  runCostUsd: num(usageObj.run_cost_usd),
                  sessionCostUsd: num(usageObj.session_cost_usd),
                });
              } else if (ev.event === "error") {
                emit({
                  type: "error",
                  message: String(data.error ?? data.message ?? "Stream error"),
                });
              } else if (ev.event === "started" || ev.event === "queued") {
                emit({
                  type: "status",
                  message: ev.event === "queued" ? "Queued…" : "Running…",
                });
              } else if (ev.event === "stranded_interject") {
                const prompts = Array.isArray(data.prompts)
                  ? data.prompts.map((p: unknown) => String(p)).filter(Boolean)
                  : [];
                emit({
                  type: "stranded_interject",
                  prompts,
                });
              }
            }
          });
          res.on("end", () => {
            if (!sawTerminal) {
              emit({
                type: "error",
                message:
                  "Stream ended without completion — the sidecar may have crashed or restarted. Check Output → ClawAgents Sidecar.",
              });
            }
            resolve();
          });
          res.on("error", reject);
        },
      );

      req.on("timeout", () => {
        emit({
          type: "error",
          message:
            "No data from the sidecar for 60s (keep-alives stopped) — it looks hung. Try Restart Sidecar.",
        });
        req.destroy();
        resolve();
      });
      req.on("error", reject);
      if (handlers.signal) {
        const onAbort = () => {
          req.destroy();
          emit({ type: "cancelled" });
          resolve();
        };
        if (handlers.signal.aborted) {
          onAbort();
          return;
        }
        handlers.signal.addEventListener("abort", onAbort, { once: true });
      }
      req.write(body);
      req.end();
    });

    return resolvedChatId;
  }

  async resolvePermission(
    requestId: string,
    decision: "allow_once" | "allow_always" | "deny",
  ): Promise<void> {
    await requestJson(this.requireHandle(), "POST", `/permissions/${encodeURIComponent(requestId)}`, {
      decision,
    });
  }

  async resolveAskUser(
    requestId: string,
    opts: { answer?: string; skip?: boolean },
  ): Promise<void> {
    await requestJson(this.requireHandle(), "POST", `/ask_user/${encodeURIComponent(requestId)}`, {
      answer: opts.answer,
      skip: Boolean(opts.skip),
    });
  }

  async cancel(): Promise<{ ok: boolean; stranded_prompts?: string[] }> {
    const handle = this.getHandle();
    if (!handle) {
      return { ok: false };
    }
    try {
      return await requestJson<{ ok: boolean; stranded_prompts?: string[] }>(
        handle,
        "POST",
        "/cancel",
      );
    } catch {
      return { ok: false };
    }
  }

  async interject(text: string, chatId?: string): Promise<{ ok: boolean; applied?: number }> {
    return requestJson(this.requireHandle(), "POST", "/interject", {
      text,
      ...(chatId ? { chat_id: chatId } : {}),
    });
  }

  listHunks(path?: string) {
    const q = path ? `?path=${encodeURIComponent(path)}` : "";
    return requestJson<{ ok: boolean; hunks?: Array<Record<string, unknown>>; error?: string }>(
      this.requireHandle(),
      "GET",
      `/hunks${q}`,
    );
  }

  acceptHunk(hunkId?: string, path?: string) {
    return requestJson<Record<string, unknown>>(this.requireHandle(), "POST", "/hunks/accept", {
      hunk_id: hunkId,
      path,
    });
  }

  rejectHunk(hunkId: string) {
    return requestJson<Record<string, unknown>>(this.requireHandle(), "POST", "/hunks/reject", {
      hunk_id: hunkId,
    });
  }

  listRewindSnapshots() {
    return requestJson<{
      ok: boolean;
      snapshots?: Array<Record<string, unknown>>;
      error?: string;
    }>(this.requireHandle(), "GET", "/rewind");
  }

  rewindToPrompt(promptIndex: number, chatId?: string) {
    return requestJson<Record<string, unknown>>(this.requireHandle(), "POST", "/rewind", {
      prompt_index: promptIndex,
      ...(chatId ? { chat_id: chatId } : {}),
    });
  }
}
