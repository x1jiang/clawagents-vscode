import { useEffect, useState } from "react";
import type { HarnessOptimizeStatus } from "../../src/protocol";
import { post } from "./vscodeApi";

export function HarnessOptimizerPanel({ status }: { status: HarnessOptimizeStatus | null }) {
  const [task, setTask] = useState("");
  const [k, setK] = useState<number>(1);
  const [mode, setMode] = useState<"parallel" | "sequential">("parallel");
  const [adaptiveProbe, setAdaptiveProbe] = useState(true);
  const [maxUsdText, setMaxUsdText] = useState("");
  const [busyAction, setBusyAction] = useState<"apply" | "rollback" | null>(null);

  const isRunning = status?.state === "running";

  useEffect(() => {
    setBusyAction(null);
  }, [status]);

  useEffect(() => {
    if (!isRunning) return undefined;
    const timer = window.setInterval(() => {
      post({ type: "load_harness_optimize" });
    }, 2500);
    return () => window.clearInterval(timer);
  }, [isRunning]);

  const handleStart = () => {
    const trimmed = task.trim();
    if (!trimmed) return;
    const parsedMax = maxUsdText.trim() ? Number(maxUsdText.trim()) : undefined;
    const validMax =
      parsedMax !== undefined && Number.isFinite(parsedMax) && parsedMax > 0 && parsedMax <= 1000
        ? parsedMax
        : undefined;
    post({
      type: "start_harness_optimize",
      task: trimmed,
      k,
      mode,
      adaptiveProbe,
      maxUsd: validMax,
    });
  };

  const ledger = status?.ledger ?? null;
  const rolloutsExecuted =
    typeof ledger?.rollouts_executed === "number"
      ? ledger.rollouts_executed
      : typeof ledger?.rollouts === "number"
        ? ledger.rollouts
        : null;
  const rolloutsSaved =
    typeof ledger?.rollouts_saved === "number" ? ledger.rollouts_saved : 0;
  const totalUsd =
    typeof ledger?.total_usd === "number" ? ledger.total_usd : null;

  const reasoning =
    typeof status?.selection?.reasoning === "string"
      ? status.selection.reasoning
      : "";
  const diffs = status?.unified_diffs ?? {};
  const diffEntries = Object.entries(diffs);
  const canApply =
    status?.state === "completed" && diffEntries.length > 0 && !status?.applied;
  const canRollback = Boolean(status?.applied && status.applied.backup_dir);
  const stages = Array.isArray(status?.stages) ? status.stages : [];

  return (
    <div className="harness-optimizer-panel">
      <div className="skill-usage-actions">
        <h4 className="skill-subheading">Harness² optimizer (Propose–Probe–Compose)</h4>
        {status?.state && status.state !== "idle" && (
          <span className={`harness-state-pill state-${status.state}`}>
            {status.state}
          </span>
        )}
        <button
          type="button"
          className="ghost"
          onClick={() => post({ type: "load_harness_optimize" })}
        >
          Refresh
        </button>
      </div>
      <p className="muted tiny">
        Optimize workspace <code>AGENTS.md</code>, <code>skills/</code>, and{" "}
        <code>.clawagents/hooks.json</code> on a representative task using blind trajectory
        selection and adaptive probe short-circuiting. Changes preview here before applying.
      </p>

      <label>
        Representative benchmark task
        <textarea
          rows={2}
          placeholder="e.g. Run pytest on a failing module, diagnose root cause, and verify with ruff"
          value={task}
          disabled={isRunning}
          onChange={(e) => setTask(e.target.value)}
        />
      </label>

      <div className="harness-controls-row">
        <label className="harness-inline-field">
          <span>Depth (k)</span>
          <select
            value={k}
            disabled={isRunning}
            onChange={(e) => setK(Number(e.target.value) || 1)}
          >
            <option value={1}>k=1 (4 rollouts)</option>
            <option value={2}>k=2 (8 rollouts)</option>
          </select>
        </label>
        <label className="harness-inline-field">
          <span>Schedule</span>
          <select
            value={mode}
            disabled={isRunning}
            onChange={(e) =>
              setMode(e.target.value === "sequential" ? "sequential" : "parallel")
            }
          >
            <option value="parallel">Parallel</option>
            <option value="sequential">Sequential</option>
          </select>
        </label>
        <label className="harness-inline-field">
          <span>Max USD (optional)</span>
          <input
            type="number"
            min="0.05"
            max="1000"
            step="0.25"
            placeholder="No cap"
            value={maxUsdText}
            disabled={isRunning}
            onChange={(e) => setMaxUsdText(e.target.value)}
          />
        </label>
      </div>

      <label className="check">
        <input
          type="checkbox"
          checked={adaptiveProbe}
          disabled={isRunning}
          onChange={(e) => setAdaptiveProbe(e.target.checked)}
        />
        Adaptive probe deduplication (skip redundant or clean-confidence rollouts)
      </label>

      <div className="skill-usage-actions" style={{ marginTop: 8 }}>
        {!isRunning ? (
          <button
            type="button"
            disabled={!task.trim()}
            onClick={handleStart}
          >
            Run PPC optimization
          </button>
        ) : (
          <button
            type="button"
            className="ghost"
            onClick={() => post({ type: "cancel_harness_optimize" })}
          >
            Cancel run
          </button>
        )}
        {canApply && (
          <button
            type="button"
            disabled={busyAction !== null}
            onClick={() => {
              setBusyAction("apply");
              window.setTimeout(() => setBusyAction(null), 3000);
              post({ type: "apply_harness_optimize" });
            }}
          >
            Apply to workspace ({diffEntries.length}{" "}
            {diffEntries.length === 1 ? "file" : "files"})
          </button>
        )}
        {canRollback && (
          <button
            type="button"
            className="ghost"
            disabled={busyAction !== null}
            onClick={() => {
              setBusyAction("rollback");
              window.setTimeout(() => setBusyAction(null), 3000);
              post({ type: "rollback_harness_optimize" });
            }}
          >
            Revert to backup
          </button>
        )}
      </div>

      {status?.error && (
        <p className="harness-error-note" role="alert">
          {status.error}
        </p>
      )}

      {stages.length > 0 && (
        <div className="harness-stages-strip" aria-live="polite">
          {stages.slice(-8).map((st, idx) => {
            const label = String(st.stage || st.label || st.event || `step ${idx + 1}`);
            const evName = String(st.event || "");
            const detail = st.skipped ? "skipped" : evName.replace(/_/g, " ");
            return (
              <span key={`${idx}-${label}`} className="harness-stage-chip">
                <strong>{label}</strong>
                {detail && detail !== label ? ` · ${detail}` : ""}
              </span>
            );
          })}
        </div>
      )}

      {(rolloutsExecuted !== null || (status?.stages?.length ?? 0) > 0) && (
        <div className="harness-ledger-bar">
          {rolloutsExecuted !== null && (
            <span>
              Rollouts: <strong>{rolloutsExecuted}</strong>
            </span>
          )}
          {rolloutsSaved > 0 && (
            <span>
              Saved: <strong>{rolloutsSaved}</strong>
            </span>
          )}
          {totalUsd !== null && totalUsd > 0 && (
            <span>
              Est. cost: <strong>${totalUsd.toFixed(4)}</strong>
            </span>
          )}
          {status?.chosen && (
            <span>
              Winner: <strong>{status.chosen}</strong>
            </span>
          )}
        </div>
      )}

      {reasoning && (
        <p className="muted tiny" style={{ marginTop: 6 }}>
          <strong>Blind selector:</strong> {reasoning}
        </p>
      )}

      {status?.applied && (
        <p className="muted tiny" style={{ marginTop: 6 }}>
          Applied ✓ Backed up prior harness under{" "}
          <code>{String(status.applied.backup_dir || ".clawagents/harness_runs")}</code>.
        </p>
      )}

      {status?.rolled_back && !status?.applied && (
        <p className="muted tiny" style={{ marginTop: 6 }}>
          Reverted ✓ Restored previous workspace harness from backup.
        </p>
      )}

      {diffEntries.length > 0 && (
        <div className="harness-diffs">
          {diffEntries.map(([relPath, patch]) => (
            <details key={relPath} className="harness-diff-item">
              <summary>
                <code>{relPath}</code>
              </summary>
              <pre className="harness-diff-pre">{patch}</pre>
            </details>
          ))}
        </div>
      )}
    </div>
  );
}
