/** A file-change event as it appears in the transcript. */
export type ChangedFile = {
  path: string;
  snapshotId?: string;
  snapshotRel?: string;
};

type TranscriptEntry = {
  kind: string;
  text?: string;
  path?: string;
  snapshotId?: string;
  snapshotRel?: string;
};

/**
 * Collect the files edited in the turn that finishes at `terminalIndex`.
 * A later edit to the same path updates its snapshot but retains its first
 * position in the list, keeping the summary stable while a run streams.
 */
export function collectTurnChangedFiles(
  items: readonly TranscriptEntry[],
  terminalIndex: number,
): ChangedFile[] {
  let start = Math.min(terminalIndex, items.length);
  while (start > 0 && items[start - 1]?.kind !== "user") start--;

  // Persisted file summaries are deliberately appended once the turn has
  // finished, so include trailing file entries up to the next user message.
  let end = Math.min(terminalIndex, items.length);
  while (end < items.length && items[end]?.kind !== "user") end++;

  const changed = new Map<string, ChangedFile>();
  for (const item of items.slice(start, end)) {
    if (item.kind !== "file" || !item.path) continue;
    changed.set(item.path, {
      path: item.path,
      snapshotId: item.snapshotId,
      snapshotRel: item.snapshotRel,
    });
  }
  return [...changed.values()];
}

/**
 * Collect edits from the active turn only while it has no terminal event.
 * This lets the transcript show one live summary instead of one row per write.
 */
export function collectPendingTurnChangedFiles(
  items: readonly TranscriptEntry[],
): ChangedFile[] {
  let start = items.length;
  while (start > 0 && items[start - 1]?.kind !== "user") start--;
  if (start === 0 || items[start - 1]?.kind !== "user") return [];
  if (items.slice(start).some((item) => isTurnTerminal(item.kind, item.text))) return [];
  return collectTurnChangedFiles(items, items.length);
}

export function isTurnTerminal(kind: string, text?: string): boolean {
  return kind === "error" || (kind === "status" && (
    text === "Done" || text?.startsWith("Done ·") || text === "Cancelled"
  ));
}
