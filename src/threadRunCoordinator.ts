/**
 * Per-conversation foreground run ownership.
 *
 * The extension host may stream several conversations at once, while each
 * individual conversation remains strictly serial.  Keeping that policy in a
 * small state object avoids spreading Map/Set invariants across the webview
 * provider's transport, navigation, and UI-routing code.
 */

export type ActiveThreadRun = Readonly<{
  chatId: string;
  controller: AbortController;
}>;

export class ThreadRunCoordinator<TTurn> {
  private readonly active = new Map<string, ActiveThreadRun>();
  private readonly queues = new Map<string, TTurn[]>();
  private readonly cancelling = new Set<string>();

  get hasActiveRuns(): boolean {
    return this.active.size > 0;
  }

  activeChatIds(): string[] {
    return [...this.active.keys()];
  }

  isActive(chatId: string | undefined): boolean {
    return Boolean(chatId && this.active.has(chatId));
  }

  /** Reserve one run slot for a conversation. */
  start(chatId: string): ActiveThreadRun | undefined {
    if (this.active.has(chatId) || this.cancelling.has(chatId)) {
      return undefined;
    }
    const run: ActiveThreadRun = {
      chatId,
      controller: new AbortController(),
    };
    this.active.set(chatId, run);
    return run;
  }

  /** Release only if `run` still owns the slot (protects against late finally). */
  finish(run: ActiveThreadRun): boolean {
    if (this.active.get(run.chatId) !== run) {
      return false;
    }
    this.active.delete(run.chatId);
    return true;
  }

  abort(chatId: string): boolean {
    const run = this.active.get(chatId);
    if (!run) {
      return false;
    }
    run.controller.abort();
    this.active.delete(chatId);
    return true;
  }

  beginCancel(chatId: string): void {
    this.cancelling.add(chatId);
  }

  endCancel(chatId: string): void {
    this.cancelling.delete(chatId);
  }

  isCancelling(chatId: string): boolean {
    return this.cancelling.has(chatId);
  }

  enqueue(chatId: string, turn: TTurn, front = false): number {
    const queue = this.queues.get(chatId) ?? [];
    if (front) {
      queue.unshift(turn);
    } else {
      queue.push(turn);
    }
    this.queues.set(chatId, queue);
    return queue.length;
  }

  dequeue(chatId: string): TTurn | undefined {
    const queue = this.queues.get(chatId);
    const turn = queue?.shift();
    if (queue?.length === 0) {
      this.queues.delete(chatId);
    }
    return turn;
  }

  queued(chatId: string): readonly TTurn[] {
    return this.queues.get(chatId) ?? [];
  }

  clearQueue(chatId: string): TTurn[] {
    const queue = this.queues.get(chatId) ?? [];
    this.queues.delete(chatId);
    return queue;
  }
}
