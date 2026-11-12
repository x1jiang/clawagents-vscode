import type { HostToWebview } from "./protocol";

/** Longest a streamed token waits before it is forwarded (~30 updates/s). */
export const DELTA_FLUSH_INTERVAL_MS = 33;

type Timer = ReturnType<typeof setTimeout>;

export type BatcherClock = {
  setTimeout(fn: () => void, ms: number): Timer;
  clearTimeout(timer: Timer): void;
};

/**
 * Coalesces streamed `assistant_delta` messages before they reach the webview.
 *
 * Models emit a delta per token — often well over a hundred a second. Each one
 * posted to the webview is a state update that re-renders the transcript and
 * re-parses the streaming message's markdown, so a long answer cost O(n²) work
 * and visibly stuttered. Deltas for the same conversation are merged and sent
 * at most once per interval instead.
 *
 * Ordering is preserved: any other message flushes the pending deltas first,
 * so a tool card or the final message can never overtake text that preceded it.
 */
export class DeltaBatcher {
  private pending: Array<Extract<HostToWebview, { type: "assistant_delta" }>> = [];
  private timer: Timer | undefined;

  constructor(
    private readonly send: (msg: HostToWebview) => void,
    private readonly intervalMs = DELTA_FLUSH_INTERVAL_MS,
    private readonly clock: BatcherClock = { setTimeout, clearTimeout },
  ) {}

  post(msg: HostToWebview): void {
    if (msg.type !== "assistant_delta") {
      this.flush();
      this.send(msg);
      return;
    }
    const last = this.pending[this.pending.length - 1];
    if (last && last.chatId === msg.chatId) {
      this.pending[this.pending.length - 1] = { ...last, delta: last.delta + msg.delta };
    } else {
      this.pending.push(msg);
    }
    if (this.timer === undefined) {
      this.timer = this.clock.setTimeout(() => {
        this.timer = undefined;
        this.flush();
      }, this.intervalMs);
    }
  }

  /** Send everything held back, in order. */
  flush(): void {
    if (this.timer !== undefined) {
      this.clock.clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.pending.length === 0) {
      return;
    }
    const batch = this.pending;
    this.pending = [];
    for (const msg of batch) {
      this.send(msg);
    }
  }

  /** Drop anything pending and stop the timer (the view is going away). */
  dispose(): void {
    if (this.timer !== undefined) {
      this.clock.clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.pending = [];
  }
}
