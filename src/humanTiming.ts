export type HumanActivity = "input" | "file";

export type HumanTimingTotals = {
  inputMs: number;
  fileMs: number;
};

export type HumanTimingState = {
  totals: Array<[string, HumanTimingTotals]>;
  files: Array<[string, string[]]>;
};

export interface HumanTimingPolicy {
  idleLimitMs(activity: HumanActivity): number;
  resumeGraceMs(activity: HumanActivity): number;
  fileOwner(owners: ReadonlySet<string>, selectedChat: string | undefined): string | undefined;
}

export const defaultHumanTimingPolicy: HumanTimingPolicy = {
  idleLimitMs: (activity) => activity === "input" ? 120_000 : 180_000,
  resumeGraceMs: () => 60_000,
  fileOwner(owners, selectedChat) {
    if (selectedChat && owners.has(selectedChat)) return selectedChat;
    if (owners.size === 1) return owners.values().next().value;
    return undefined;
  },
};

type Segment = {
  chatId: string;
  kind: HumanActivity;
  accountedAt: number;
  idleAt: number;
};

const totalKey = { input: "inputMs", file: "fileMs" } as const;

type Pause = {
  chatId: string;
  key: string;
  startedAt: number;
  expiresAt: number;
};

type Interval = { start: number; end: number };

/** One active segment per window. Keep credited intervals only while a pause
 * may be filled, so either activity can resume without double counting. */
export class HumanTiming {
  private segment?: Segment;
  private readonly pauses: Partial<Record<HumanActivity, Pause>> = {};
  private occupied: Interval[] = [];
  private readonly totals: Map<string, HumanTimingTotals>;
  private readonly files: Map<string, Set<string>>;

  constructor(
    state?: HumanTimingState,
    private readonly policy = defaultHumanTimingPolicy,
    private readonly now = () => performance.now(),
  ) {
    this.totals = new Map(state?.totals);
    this.files = new Map(state?.files.map(([file, chats]) => [file, new Set(chats)]));
  }

  pulse(chatId: string, kind: HumanActivity): void {
    this.resume(chatId, kind, chatId);
  }

  suspendInput(): void {
    this.suspend("input");
  }

  suspendFile(file: string): void {
    this.suspend("file", file);
  }

  private suspend(kind: HumanActivity, key?: string): void {
    const now = this.now();
    this.advance(now);
    const segment = this.segment;
    if (segment?.kind !== kind) return;
    this.pauses[kind] = {
      key: key ?? segment.chatId,
      chatId: segment.chatId,
      startedAt: now,
      expiresAt: Math.min(segment.idleAt, now + this.policy.resumeGraceMs(kind)),
    };
    this.segment = undefined;
  }

  resumeFile(chatId: string, file: string): void {
    this.resume(chatId, "file", file);
  }

  private resume(chatId: string, kind: HumanActivity, key: string): void {
    const now = this.now();
    this.advance(now);
    const pause = this.pauses[kind];
    delete this.pauses[kind];
    if (pause?.key === key && pause.chatId === chatId) {
      this.fillGap(chatId, kind, pause.startedAt, now);
    }
    this.pruneIntervals(now);
    this.segment = { chatId, kind, accountedAt: now, idleAt: now + this.policy.idleLimitMs(kind) };
  }

  private fillGap(chatId: string, kind: HumanActivity, start: number, end: number): void {
    let cursor = start;
    // Iterate over the old union. Crediting a gap can replace the interval list.
    for (const interval of this.occupied) {
      if (interval.end <= cursor) continue;
      if (interval.start >= end) break;
      this.credit(chatId, kind, cursor, interval.start);
      cursor = interval.end;
    }
    this.credit(chatId, kind, cursor, end);
  }

  private credit(chatId: string, kind: HumanActivity, start: number, end: number): void {
    if (end <= start) return;
    this.addElapsed(chatId, kind, end - start);
    if (!this.pauses.input && !this.pauses.file) return;
    const merged: Interval[] = [];
    let inserted = false;
    for (const interval of this.occupied) {
      if (interval.end < start) {
        merged.push(interval);
      } else if (interval.start > end) {
        if (!inserted) merged.push({ start, end });
        inserted = true;
        merged.push(interval);
      } else {
        start = Math.min(start, interval.start);
        end = Math.max(end, interval.end);
      }
    }
    if (!inserted) merged.push({ start, end });
    this.occupied = merged;
  }

  private pruneIntervals(now: number): void {
    for (const kind of ["input", "file"] as const) {
      const pause = this.pauses[kind];
      if (pause && now > pause.expiresAt) delete this.pauses[kind];
    }
    const earliest = Math.min(this.pauses.input?.startedAt ?? Infinity, this.pauses.file?.startedAt ?? Infinity);
    if (this.occupied.length && this.occupied[0].end <= earliest) {
      this.occupied = this.occupied.filter((interval) => interval.end > earliest);
    }
  }

  hasActiveInput(): boolean {
    return this.segment?.kind === "input" && this.now() < this.segment.idleAt;
  }

  stop(kind?: HumanActivity): void {
    const now = this.now();
    this.advance(now);
    if (!kind || this.segment?.kind === kind) this.segment = undefined;
    if (!kind || kind === "input") delete this.pauses.input;
    if (!kind || kind === "file") delete this.pauses.file;
    this.pruneIntervals(now);
  }

  private pending(segment: Segment, now: number): number {
    return Math.max(0, Math.min(now, segment.idleAt) - segment.accountedAt);
  }

  private advance(now: number): void {
    this.pruneIntervals(now);
    const segment = this.segment;
    if (!segment) return;
    const elapsed = this.pending(segment, now);
    if (elapsed > 0) {
      this.credit(segment.chatId, segment.kind, segment.accountedAt, segment.accountedAt + elapsed);
      segment.accountedAt += elapsed;
    }
    if (now >= segment.idleAt) this.segment = undefined;
  }

  private snapshotSaved(chatId: string): HumanTimingTotals {
    return this.totals.get(chatId) ?? { inputMs: 0, fileMs: 0 };
  }

  snapshot(chatId: string): HumanTimingTotals {
    const totals = { ...this.snapshotSaved(chatId) };
    const segment = this.segment;
    if (segment?.chatId === chatId) totals[totalKey[segment.kind]] += this.pending(segment, this.now());
    return totals;
  }

  addInput(chatId: string, milliseconds: number): void {
    this.addElapsed(chatId, "input", milliseconds);
  }

  private addElapsed(chatId: string, kind: HumanActivity, milliseconds: number): void {
    if (milliseconds <= 0) return;
    const totals = this.snapshotSaved(chatId);
    totals[totalKey[kind]] += milliseconds;
    this.totals.set(chatId, totals);
  }

  takeUnassignedInput(): number {
    this.stop("input");
    const elapsed = this.totals.get("")?.inputMs ?? 0;
    this.totals.delete("");
    return elapsed;
  }

  rememberFile(chatId: string, file: string): boolean {
    let owners = this.files.get(file);
    if (!owners) {
      owners = new Set();
      this.files.set(file, owners);
    }
    if (owners.has(chatId)) return false;
    owners.add(chatId);
    return true;
  }

  fileOwner(file: string, selectedChat?: string): string | undefined {
    const owners = this.files.get(file);
    return owners && this.policy.fileOwner(owners, selectedChat);
  }

  forgetChat(chatId: string): void {
    if (this.segment?.chatId === chatId) this.segment = undefined;
    for (const kind of ["input", "file"] as const) {
      if (this.pauses[kind]?.chatId === chatId) delete this.pauses[kind];
    }
    this.pruneIntervals(this.now());
    this.totals.delete(chatId);
    for (const [file, owners] of this.files) {
      owners.delete(chatId);
      if (!owners.size) this.files.delete(file);
    }
  }

  checkpoint(): { state: HumanTimingState; active: boolean } {
    this.advance(this.now());
    return {
      state: {
        totals: [...this.totals].filter(([id]) => id).map(([id, totals]) => [id, { ...totals }]),
        files: [...this.files].map(([file, owners]) => [file, [...owners]]),
      },
      active: Boolean(this.segment),
    };
  }
}
