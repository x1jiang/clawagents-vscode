import type { QueryIndexEntry } from "./vscodeApi";

export type QueryNavigatorSnapshot = {
  entries: QueryIndexEntry[];
  activeEventIndex?: number;
};

/**
 * Per-thread UI memory for the transcript navigator.
 *
 * The host remains the source of truth and refreshes entries after restore.
 * This cache prevents a thread switch from blanking already-known navigation
 * while that asynchronous refresh is pending or unavailable.
 */
export class QueryNavigatorMemory {
  private readonly snapshots = new Map<string, QueryNavigatorSnapshot>();

  read(chatId: string | undefined): QueryNavigatorSnapshot {
    if (!chatId) return { entries: [] };
    const snapshot = this.snapshots.get(chatId);
    return snapshot
      ? { entries: snapshot.entries, activeEventIndex: snapshot.activeEventIndex }
      : { entries: [] };
  }

  rememberEntries(chatId: string, entries: QueryIndexEntry[]): QueryNavigatorSnapshot {
    const previous = this.snapshots.get(chatId);
    const activeEventIndex = previous?.activeEventIndex !== undefined &&
      entries.some((entry) => entry.eventIndex === previous.activeEventIndex)
      ? previous.activeEventIndex
      : undefined;
    const snapshot = { entries, activeEventIndex };
    this.snapshots.set(chatId, snapshot);
    return snapshot;
  }

  rememberActive(chatId: string | undefined, activeEventIndex: number | undefined): void {
    if (!chatId) return;
    const previous = this.snapshots.get(chatId) || { entries: [] };
    this.snapshots.set(chatId, { ...previous, activeEventIndex });
  }
}
