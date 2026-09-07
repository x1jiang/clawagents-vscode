import { useState } from "react";
import type { ChangedFile } from "./changedFiles";
import { post } from "./vscodeApi";

/** Compact per-turn file actions, isolated from the main transcript renderer. */
export function ChangedFilesSummary({ files }: { files: ChangedFile[] }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <section className="changed-files-summary" aria-label={`Edited ${files.length} files`}>
      <button
        type="button"
        className="changed-files-title"
        onClick={() => setExpanded((current) => !current)}
        aria-expanded={expanded}
        title={expanded ? "Collapse edited files" : "Expand edited files"}
      >
        <strong>Edited {files.length} file{files.length === 1 ? "" : "s"}</strong>
        <span>{expanded ? "Open, diff, or restore" : "Click to show files"}</span>
        <span className="changed-files-caret" aria-hidden="true">{expanded ? "▾" : "▸"}</span>
      </button>
      {expanded && (
        <div className="changed-files-list">
          {files.map((file) => {
            const snapshot = file.snapshotId && file.snapshotRel
              ? { id: file.snapshotId, rel: file.snapshotRel }
              : undefined;
            return (
              <div className="changed-file-row" key={file.path}>
                <button
                  type="button"
                  className="changed-file-link"
                  title={`Open ${file.path}`}
                  onClick={() => post({ type: "open_file", path: file.path })}
                >
                  {file.path}
                </button>
                <div className="changed-file-actions">
                  <button
                    type="button"
                    className="ghost tiny"
                    onClick={() => post({
                      type: "diff_snapshot",
                      path: file.path,
                      snapshotId: file.snapshotId,
                      snapshotRel: file.snapshotRel,
                    })}
                  >
                    Diff
                  </button>
                  {snapshot && (
                    <button
                      type="button"
                      className="ghost tiny"
                      onClick={() => {
                        const ok = window.confirm(
                          `Restore ${file.path} to its state before this edit?\n\nCurrent changes to this file will be overwritten.`,
                        );
                        if (!ok) return;
                        post({
                          type: "restore_snapshot",
                          snapshotId: snapshot.id,
                          rel: snapshot.rel,
                        });
                      }}
                    >
                      Restore
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
