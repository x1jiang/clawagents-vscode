import { useEffect, useMemo, useState } from "react";
import {
  elapsedMs,
  formatToolDuration,
  presentTool,
  summarizeToolRun,
  type ToolCallItem,
  type ToolCategory,
} from "./toolPresentation";

type ToolRunGroupProps = {
  calls: ToolCallItem[];
  /** Becomes true as soon as assistant output follows this tool run. */
  autoCollapse: boolean;
  onOpenFile: (path: string) => void;
};

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function looksLikeDiff(text: string): boolean {
  return /^@@ |^\+\+\+ |^--- |^diff --git /m.test(text);
}

function ToolGlyph({ category }: { category: ToolCategory }) {
  const common = {
    width: 15,
    height: 15,
    viewBox: "0 0 24 24",
    fill: "none",
    "aria-hidden": true,
  } as const;
  switch (category) {
    case "search":
    case "context":
      return (
        <svg {...common}>
          <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" />
          <path d="m16.5 16.5 4 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      );
    case "read":
      return (
        <svg {...common}>
          <path d="M4 5.5A3.5 3.5 0 0 1 7.5 2H11v17H7.5A3.5 3.5 0 0 0 4 22V5.5Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
          <path d="M20 5.5A3.5 3.5 0 0 0 16.5 2H13v17h3.5A3.5 3.5 0 0 1 20 22V5.5Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
        </svg>
      );
    case "inspect":
      return (
        <svg {...common}>
          <path d="M3 6.5h7l2 2h9v10.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6.5Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
          <path d="M3 10h18" stroke="currentColor" strokeWidth="1.8" />
        </svg>
      );
    case "command":
      return (
        <svg {...common}>
          <rect x="2.5" y="4" width="19" height="16" rx="3" stroke="currentColor" strokeWidth="1.8" />
          <path d="m6.5 9 3 3-3 3M12 15h5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "edit":
      return (
        <svg {...common}>
          <path d="M4 20h4l11-11-4-4L4 16v4Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
          <path d="m13.5 6.5 4 4" stroke="currentColor" strokeWidth="1.8" />
        </svg>
      );
    case "skill":
      return (
        <svg {...common}>
          <path d="m12 3 2.2 4.5L19 9l-3.5 3.4.8 4.8L12 15l-4.3 2.2.8-4.8L5 9l4.8-1.5L12 3Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
        </svg>
      );
    case "web":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.8" />
          <path d="M3 12h18M12 3c2.5 2.5 3.8 5.5 3.8 9S14.5 18.5 12 21c-2.5-2.5-3.8-5.5-3.8-9S9.5 5.5 12 3Z" stroke="currentColor" strokeWidth="1.8" />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <path d="M8 4h8v4h4v8h-4v4H8v-4H4V8h4V4Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
        </svg>
      );
  }
}

function StatusGlyph({ call }: { call: ToolCallItem }) {
  if (call.status === "running") return <span className="tool-spinner" aria-label="Running" />;
  if (call.success === false) return <span className="tool-status-glyph failed" aria-label="Failed">×</span>;
  return <span className="tool-status-glyph succeeded" aria-label="Completed">✓</span>;
}

function ToolCallDetails({
  call,
  now,
  onOpenFile,
}: {
  call: ToolCallItem;
  now: number;
  onOpenFile: (path: string) => void;
}) {
  const [open, setOpen] = useState(call.success === false);
  const presentation = presentTool(call);
  const duration = formatToolDuration(elapsedMs(call, now));

  useEffect(() => {
    if (call.success === false) setOpen(true);
  }, [call.success]);

  return (
    <details
      className={`tool-call tool-call-${presentation.category}${call.success === false ? " has-error" : ""}`}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="tool-call-summary">
        <span className="tool-call-icon"><ToolGlyph category={presentation.category} /></span>
        <span className="tool-call-copy">
          <span className="tool-call-title">{presentation.title}</span>
          {presentation.detail && <span className="tool-call-detail">{presentation.detail}</span>}
        </span>
        {duration && <span className="tool-duration">{duration}</span>}
        <StatusGlyph call={call} />
        <span className="tool-chevron" aria-hidden="true">⌄</span>
      </summary>
      <div className="tool-call-body">
        <div className="tool-call-meta">
          <code>{call.name}</code>
          <span>{call.status === "running" ? "Running" : call.success === false ? "Failed" : "Completed"}</span>
          {duration && <span>{duration}</span>}
          {call.filePath && (
            <button type="button" className="tool-open-file" onClick={() => onOpenFile(call.filePath!)}>
              Open file
            </button>
          )}
        </div>
        {call.args != null && (
          <section className="tool-data-section">
            <h4>Arguments</h4>
            <pre className="tool-body">{safeJson(call.args)}</pre>
          </section>
        )}
        {call.output ? (
          <section className="tool-data-section">
            <h4>{call.success === false ? "Error" : "Output"}</h4>
            <pre className={`tool-body ${looksLikeDiff(call.output) ? "diff" : ""}`}>{call.output}</pre>
          </section>
        ) : call.status === "done" && call.success === false ? (
          <pre className="tool-body muted">No error details returned.</pre>
        ) : null}
      </div>
    </details>
  );
}

export function ToolRunGroup({ calls, autoCollapse, onOpenFile }: ToolRunGroupProps) {
  const active = calls.some((call) => call.status === "running");
  const [expanded, setExpanded] = useState(!autoCollapse);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (active) setExpanded(true);
    else if (autoCollapse) setExpanded(false);
  }, [active, autoCollapse]);

  useEffect(() => {
    if (!active) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 200);
    return () => window.clearInterval(timer);
  }, [active]);

  const totalDuration = useMemo(() => {
    const durations = calls
      .map((call) => elapsedMs(call, now))
      .filter((value): value is number => value !== undefined);
    return durations.length ? durations.reduce((sum, value) => sum + value, 0) : undefined;
  }, [calls, now]);
  const failed = calls.filter((call) => call.success === false).length;
  const summary = summarizeToolRun(calls, active);
  const duration = formatToolDuration(totalDuration);

  return (
    <details
      className={`tool-run${active ? " is-running" : ""}${failed ? " has-error" : ""}`}
      open={expanded}
      onToggle={(event) => {
        if (!active) setExpanded(event.currentTarget.open);
      }}
    >
      <summary className="tool-run-summary">
        <span className="tool-run-leading" aria-hidden="true">
          {active ? <span className="tool-spinner" /> : failed ? "!" : "✓"}
        </span>
        <span className="tool-run-title">{summary}</span>
        <span className="tool-run-meta">
          {calls.length} tool{calls.length === 1 ? "" : "s"}
          {duration ? ` · ${duration}` : ""}
          {failed ? ` · ${failed} failed` : ""}
        </span>
        <span className="tool-run-chevron" aria-hidden="true">⌄</span>
      </summary>
      <div className="tool-run-list">
        {calls.map((call, index) => (
          <ToolCallDetails
            key={`${call.id}-${index}`}
            call={call}
            now={now}
            onOpenFile={onOpenFile}
          />
        ))}
      </div>
    </details>
  );
}
