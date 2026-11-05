import { useEffect, useState } from "react";
import type { HumanTimingTotals } from "../../src/humanTiming";
import { formatConversationDuration as duration } from "./conversationTiming";
import { post, type HostToWebview } from "./vscodeApi";

export function HumanTimeStats({ chatId }: { chatId: string }) {
  const [totals, setTotals] = useState<HumanTimingTotals>();
  useEffect(() => {
    const receive = ({ data }: MessageEvent<HostToWebview>) => {
      if (data?.type === "human_timing" && data.chatId === chatId) setTotals(data.totals);
    };
    const refresh = () => {
      if (!document.hidden) post({ type: "get_human_timing", chatId });
    };
    window.addEventListener("message", receive);
    refresh();
    const interval = window.setInterval(refresh, 1000);
    return () => {
      window.removeEventListener("message", receive);
      window.clearInterval(interval);
    };
  }, [chatId]);

  return (
    <section className="conversation-time-stats" aria-label="Human time estimate">
      <strong title="Estimates message preparation and file viewing. Continuing the same draft or file within a minute can fill a gap, excluding time already counted.">
        Human time (estimated)
      </strong>
      <dl>
        <div><dt>Total</dt><dd>{duration(totals && totals.inputMs + totals.fileMs)}</dd></div>
        <div><dt>Message preparation</dt><dd>{duration(totals?.inputMs)}</dd></div>
        <div><dt>File viewing</dt><dd>{duration(totals?.fileMs)}</dd></div>
      </dl>
    </section>
  );
}
