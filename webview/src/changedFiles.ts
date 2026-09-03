/** A file-change event as it appears in the transcript. */
export type ChangedFile = {
  path: string;
  snapshotId?: string;
  snapshotRel?: string;
};

type TranscriptEntry = {
  kind: string;
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
  let start = terminalIndex;
  while (start > 0 && items[start - 1]?.kind !== "user") start--;

  const changed = new Map<string, ChangedFile>();
  for (const item of items.slice(start, terminalIndex)) {
    if (item.kind !== "file" || !item.path) continue;
    changed.set(item.path, {
      path: item.path,
      snapshotId: item.snapshotId,
      snapshotRel: item.snapshotRel,
    });
  }
  return [...changed.values()];
}

export function isTurnTerminal(kind: string, text?: string): boolean {
  return kind === "error" || (kind === "status" && (
    text === "Done" || text?.startsWith("Done ·") || text === "Cancelled"
  ));
}
