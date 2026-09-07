import { useEffect, useMemo, useRef, useState } from "react";
import {
  redactDiagnosticText,
  redactDiagnosticValue,
} from "./diagnosticsRedaction";

type SidecarState = "stopped" | "starting" | "running" | "error";

type DiagnosticCheck = {
  name: string;
  ok: boolean;
  detail: string;
};

type DiagnosticsPanelProps = {
  diagnostics: unknown;
  stats: unknown;
  workspace?: string;
  sidecar: SidecarState;
  sidecarDetail?: string;
  onBack: () => void;
  onRefresh: () => void;
  onRestart: () => void;
};

const CHECK_LABELS: Record<string, string> = {
  python: "Python runtime",
  workspace: "Workspace",
  clawagents: "ClawAgents package",
  fastapi: "FastAPI",
  uvicorn: "Uvicorn",
  pydantic: "Pydantic",
  api_key: "Model access",
  model: "Model",
  custom_base_url: "API endpoint",
  wire_api: "Wire API",
  ssl_verify: "TLS verification",
  mcp_config: "MCP configuration",
  context_mode: "Context Mode",
  graphify: "Graphify",
  rtk: "RTK",
  agents_md: "Workspace instructions",
  token_estimator: "Token estimator",
};

const OPTIONAL_CHECKS = new Set([
  "mcp_config",
  "context_mode",
  "rtk",
  "agents_md",
  "token_estimator",
]);

const REQUIRED_CHECKS = new Set(["workspace", "clawagents", "api_key"]);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function checksFrom(value: unknown): DiagnosticCheck[] {
  const checks = asRecord(value)?.checks;
  if (!Array.isArray(checks)) return [];
  return checks.flatMap((item) => {
    const record = asRecord(item);
    if (!record || typeof record.name !== "string" || typeof record.ok !== "boolean") {
      return [];
    }
    return [{
      name: record.name,
      ok: record.ok,
      detail: typeof record.detail === "string" ? record.detail : "",
    }];
  });
}

function workspaceName(path?: string): string {
  const trimmed = path?.replace(/[\\/]+$/, "");
  if (!trimmed) return "Current workspace";
  return trimmed.split(/[\\/]/).filter(Boolean).pop() || "Current workspace";
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function checkTone(check: DiagnosticCheck): "ok" | "warn" | "neutral" {
  if (check.ok) return "ok";
  if (OPTIONAL_CHECKS.has(check.name)) return "neutral";
  return "warn";
}

function checkStatus(check: DiagnosticCheck): string {
  if (check.ok) return "Ready";
  if (REQUIRED_CHECKS.has(check.name)) return "Needs attention";
  if (OPTIONAL_CHECKS.has(check.name)) {
    if (check.detail.trim().toLowerCase() === "none") return "Not configured";
    if (check.name === "token_estimator") return "Approximate";
    return "Unavailable";
  }
  return "Check recommended";
}

function primaryDetail(check: DiagnosticCheck | undefined, reportedWorkspace?: string): string {
  if (!check) return "Not reported";
  if (check.name === "workspace") {
    return check.ok ? workspaceName(reportedWorkspace || check.detail) : "Workspace is unavailable";
  }
  if (check.name === "api_key") {
    return check.ok ? "Provider credentials available" : "Configure a provider in Settings";
  }
  if (check.name === "python" && check.detail) return `Version ${check.detail}`;
  return check.detail || checkStatus(check);
}

async function copyReport(text: string): Promise<boolean> {
  if (!navigator.clipboard?.writeText) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function DiagnosticsPanel({
  diagnostics,
  stats,
  workspace,
  sidecar,
  sidecarDetail,
  onBack,
  onRefresh,
  onRestart,
}: DiagnosticsPanelProps) {
  const checks = useMemo(() => checksFrom(diagnostics), [diagnostics]);
  const diagnosticsRecord = asRecord(diagnostics);
  const workspaceCheck = checks.find((check) => check.name === "workspace");
  const reportedWorkspace = workspaceCheck?.detail || workspace;
  const redactionPaths = [reportedWorkspace, workspace].filter(
    (value): value is string => Boolean(value),
  );
  const redactedSidecarDetail = sidecarDetail
    ? redactDiagnosticText(sidecarDetail, redactionPaths)
    : undefined;
  const redactedPayload = useMemo(() => redactDiagnosticValue({
    sidecar,
    diagnostics,
    local_stats: stats,
  }, redactionPaths), [diagnostics, redactionPaths.join("\n"), sidecar, stats]);
  const rawDetails = safeJson(redactedPayload);
  const overallOk = diagnosticsRecord?.ok === true && sidecar === "running";
  const hasProblem = diagnosticsRecord?.ok === false || sidecar === "error" || sidecar === "stopped";
  const summaryTone = overallOk ? "ok" : hasProblem ? "warn" : "neutral";
  const summaryTitle = overallOk
    ? "System is ready"
    : hasProblem
      ? "Action may be required"
      : sidecar === "starting"
        ? "Starting background service…"
        : "Checking system…";
  const summaryText = overallOk
    ? "Core services and model access are available. Optional integrations may still be disabled."
    : redactedSidecarDetail || "Review the checks below for details and suggested next steps.";
  const [refreshing, setRefreshing] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const copyTimer = useRef<ReturnType<typeof setTimeout>>();
  const [checkedAt, setCheckedAt] = useState<Date>();

  useEffect(() => {
    if (diagnostics !== undefined) {
      setCheckedAt(new Date());
      setRefreshing(false);
    }
  }, [diagnostics]);

  useEffect(() => () => {
    if (copyTimer.current) clearTimeout(copyTimer.current);
  }, []);

  const primaryChecks: Array<{
    key: string;
    label: string;
    tone: "ok" | "warn" | "neutral";
    status: string;
    detail: string;
  }> = [
    {
      key: "sidecar",
      label: "Background service",
      tone: sidecar === "running" ? "ok" : sidecar === "starting" ? "neutral" : "warn",
      status: sidecar === "running" ? "Running" : sidecar === "starting" ? "Starting" : "Unavailable",
      detail: redactedSidecarDetail || "Local agent service",
    },
    ...["python", "workspace", "api_key", "model"].map((name) => {
      const check = checks.find((item) => item.name === name);
      return {
        key: name,
        label: CHECK_LABELS[name],
        tone: check ? checkTone(check) : "neutral" as const,
        status: check ? checkStatus(check) : "Not reported",
        detail: primaryDetail(check, reportedWorkspace),
      };
    }),
  ];

  const handleCopy = async () => {
    const report = safeJson({
      generated_at: new Date().toISOString(),
      ...asRecord(redactedPayload),
    });
    setCopyState(await copyReport(report) ? "copied" : "failed");
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopyState("idle"), 2_500);
  };

  return (
    <div className="panel diagnostics-panel">
      <div className="diagnostics-heading-row">
        <button type="button" className="linkish diagnostics-back" onClick={onBack}>
          ← Settings
        </button>
        {checkedAt && (
          <span className="diagnostics-checked-at">
            Checked {checkedAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
          </span>
        )}
      </div>

      <section className={`diagnostics-summary ${summaryTone}`} aria-live="polite">
        <span className="diagnostics-summary-icon" aria-hidden="true">
          {overallOk ? "✓" : hasProblem ? "!" : "…"}
        </span>
        <div>
          <h2>{summaryTitle}</h2>
          <p>{summaryText}</p>
        </div>
      </section>

      <div className="diagnostics-grid">
        {primaryChecks.map((check) => (
          <section className="diagnostics-card" key={check.key}>
            <div className="diagnostics-card-label">{check.label}</div>
            <div className={`diagnostics-card-status ${check.tone}`}>
              <span className="diagnostics-dot" aria-hidden="true" />
              {check.status}
            </div>
            <div className="diagnostics-card-detail" title={check.detail}>{check.detail}</div>
          </section>
        ))}
      </div>

      <div className="diagnostics-actions">
        <button
          type="button"
          className="primary"
          disabled={refreshing || sidecar === "starting"}
          onClick={() => {
            setRefreshing(true);
            onRefresh();
          }}
        >
          {refreshing ? "Checking…" : "Run checks"}
        </button>
        <button
          type="button"
          className="ghost"
          disabled={sidecar === "starting"}
          onClick={onRestart}
        >
          {sidecar === "starting" ? "Restarting…" : "Restart background service"}
        </button>
        <button type="button" className="ghost" onClick={() => void handleCopy()}>
          {copyState === "copied" ? "Copied" : copyState === "failed" ? "Copy failed" : "Copy report"}
        </button>
      </div>

      <details className="diagnostics-details">
        <summary>
          <span>All checks</span>
          <span className="diagnostics-details-count">{checks.length}</span>
        </summary>
        <div className="diagnostics-check-list">
          {checks.length ? checks.map((check) => {
            const tone = checkTone(check);
            const detail = redactDiagnosticText(check.detail, redactionPaths);
            return (
              <div className="diagnostics-check-row" key={check.name}>
                <span className={`diagnostics-dot ${tone}`} aria-hidden="true" />
                <span className="diagnostics-check-name">
                  {CHECK_LABELS[check.name] || check.name.replaceAll("_", " ")}
                </span>
                <span className={`diagnostics-check-result ${tone}`}>{checkStatus(check)}</span>
                {detail && <span className="diagnostics-check-detail">{detail}</span>}
              </div>
            );
          }) : <p className="diagnostics-empty">No check results are available yet.</p>}
        </div>
      </details>

      <details className="diagnostics-details diagnostics-raw">
        <summary>Advanced diagnostic data</summary>
        <p>Workspace paths are redacted. API-key checks contain presence flags only, never key values.</p>
        <pre className="tool-body">{rawDetails}</pre>
      </details>
    </div>
  );
}
