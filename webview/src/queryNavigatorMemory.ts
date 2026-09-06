import type { QueryIndexEntry } from "./vscodeApi";

export type QueryNavigatorSnapshot = {
  entries: QueryIndexEntry[];
  activeEventIndex?: number;
};

type VisibleQueryItem = {
  kind: string;
  text?: string;
  timestamp?: string;
  eventIndex?: number;
};

/** Build a reliable fallback index from the persisted transcript page. */
export function queryEntriesFromVisibleItems(
  items: readonly VisibleQueryItem[],
): QueryIndexEntry[] {
  const entries: QueryIndexEntry[] = [];
  for (const item of items) {
    const eventIndex = item.eventIndex;
    if (
      item.kind !== "user" ||
      typeof eventIndex !== "number" ||
      !Number.isInteger(eventIndex) ||
      eventIndex < 0
    ) {
      continue;
    }
    entries.push({
      eventIndex,
      text: item.text?.trim() || "(empty message)",
      timestamp: item.timestamp,
    });
  }
  return entries;
}

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
    // A restored transcript containing user messages is stronger evidence than
    // a transient empty response (for example, a persistence race or an older
    // sidecar). Never let that response blank an already-visible navigator.
    if (entries.length === 0 && previous?.entries.length) {
      return {
        entries: previous.entries,
        activeEventIndex: previous.activeEventIndex,
      };
    }
    const activeEventIndex = previous?.activeEventIndex !== undefined &&
      entries.some((entry) => entry.eventIndex === previous.activeEventIndex)
      ? previous.activeEventIndex
      : undefined;
    const snapshot = { entries, activeEventIndex };
    this.snapshots.set(chatId, snapshot);
    return snapshot;
  }

  /**
   * Merge the currently restored transcript page into a thread's cached index.
   * A later host refresh still replaces this with the complete persisted index.
   */
  rememberVisibleEntries(
    chatId: string | undefined,
    visibleEntries: QueryIndexEntry[],
  ): QueryNavigatorSnapshot {
    if (!chatId) return { entries: [] };
    const previous = this.snapshots.get(chatId);
    const byEventIndex = new Map(
      (previous?.entries || []).map((entry) => [entry.eventIndex, entry]),
    );
    for (const entry of visibleEntries) byEventIndex.set(entry.eventIndex, entry);
    const entries = [...byEventIndex.values()].sort((a, b) => a.eventIndex - b.eventIndex);
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
