import { useEffect, useMemo, useState } from "react";
import type { ConversationTiming } from "../../src/protocol";
import { post } from "./vscodeApi";
import { formatConversationDuration as duration, projectConversationTiming } from "./conversationTiming";

export function ConversationTimeStats({ timing, chatId, open }: {
  timing?: ConversationTiming;
  chatId?: string;
  open: boolean;
}) {
  const [now, setNow] = useState(() => performance.now());
  const receivedAt = useMemo(() => performance.now(), [timing]);
  const active = Boolean(timing?.active_runs);
  useEffect(() => {
    if (!open || !chatId) return;
    post({ type: "get_conversation_timing", chatId });
    if (!active) return;
    const clock = window.setInterval(() => setNow(performance.now()), 1000);
    // Also reconciles completion after Stop aborts the event stream.
    const refresh = window.setInterval(() => post({ type: "get_conversation_timing", chatId }), 3000);
    return () => { window.clearInterval(clock); window.clearInterval(refresh); };
  }, [open, chatId, active]);
  const values = timing ? projectConversationTiming(timing, Math.max(0, now - receivedAt)) : undefined;
  const date = (milliseconds?: number) => milliseconds == null ? "—" : new Date(milliseconds).toLocaleString();
  return (
    <section className="conversation-time-stats" aria-label="Conversation time">
      <strong>Conversation time</strong>
      <dl>
        <div><dt title="Sum of tracked run wall time, including model responses, tools, and waits during execution. Excludes gaps between runs. Not CPU/GPU compute time.">Agent time (total)</dt>
        <dd>{values ? duration(values.cumulativeMs) : "—"}</dd></div>
        <div><dt>{active ? "Current run" : "Last run"}</dt><dd>{duration(values?.lastRunMs)}</dd></div>
        <div><dt title="From conversation creation to its latest activity, including idle gaps.">Conversation span</dt><dd>{duration(values?.spanMs)}</dd></div>
        <div><dt>Tracked runs</dt><dd>{timing?.run_count ?? 0}</dd></div>
        <div className="conversation-time-date"><dt>Created</dt><dd>{date(timing?.created_at == null ? undefined : timing.created_at * 1000)}</dd></div>
        <div className="conversation-time-date"><dt>Last activity</dt><dd>{date(values?.lastActivity)}</dd></div>
      </dl>
      <small>{timing?.tracked_since
        ? `Execution timing since ${date(timing.tracked_since * 1000)}. Includes tools and waits within runs.`
        : "Execution timing starts with the next run; earlier runs are not included."}</small>
    </section>
  );
}
