type RestoredToolItem = {
  kind: "tool";
  id: string;
  name: string;
  args?: unknown;
  success?: boolean;
  output?: string;
  filePath?: string;
  status: "running" | "done";
  startedAt?: number;
  completedAt?: number;
  durationMs?: number;
};

function stripEditorContextForDisplay(text: string): string {
  const mark = "\n\n---\nEditor context:\n";
  const idx = text.indexOf(mark);
  return idx >= 0 ? text.slice(0, idx).replace(/\s+$/, "") : text;
}

function eventTimestamp(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value * 1000).toISOString();
  }
  return undefined;
}

function eventMilliseconds(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value * 1000;
  if (typeof value !== "string") return undefined;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : undefined;
}

function completionStatus(value: unknown): string {
  const status = String(value || "").trim();
  if (!status || /^(done|complete|completed)$/i.test(status)) return "Done";
  return `Done · ${status}`;
}

function formatUsd(amount: number): string {
  if (amount > 0 && amount < 0.01) return "<$0.01";
  if (amount < 100) return `$${amount.toFixed(2)}`;
  return `$${amount.toFixed(0)}`;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function toolFilePath(event: Record<string, unknown>, args?: unknown): string | undefined {
  const values = record(args);
  const candidate =
    event.filePath ?? event.file_path ?? values?.path ?? values?.file_path ?? values?.target_path;
  return typeof candidate === "string" && candidate ? candidate : undefined;
}

function findRunningTool(
  items: Array<Record<string, unknown>>,
  id: string,
  name: string,
): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item.kind !== "tool" || item.status !== "running") continue;
    if ((id && item.id === id) || (!id && item.name === name)) return index;
  }
  return -1;
}

/** Convert persisted UI events into the transcript model used by the Webview. */
export function eventsToItems(
  events: Array<Record<string, unknown>>,
  eventsOffset = 0,
): unknown[] {
  const items: Array<Record<string, unknown>> = [];
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const kind = event.kind;
    if (kind === "user") {
      items.push({
        kind: "user",
        text: stripEditorContextForDisplay(String(event.text || "")),
        timestamp: eventTimestamp(event.ts),
        eventIndex: eventsOffset + index,
      });
    } else if (kind === "assistant") {
      items.push({
        kind: "assistant",
        text: String(event.text || ""),
        timestamp: eventTimestamp(event.ts),
      });
    } else if (kind === "model_change") {
      items.push({ kind: "model_change", text: String(event.text || "") });
    } else if (kind === "tool_started") {
      const args = event.args;
      const startedAt =
        eventMilliseconds(event.perceived_started_at) ?? eventMilliseconds(event.ts);
      const tool: RestoredToolItem = {
        kind: "tool",
        id: String(event.id || event.call_id || event.name || "tool"),
        name: String(event.name || event.tool_name || "tool"),
        args,
        filePath: toolFilePath(event, args),
        status: "running",
        startedAt,
      };
      items.push(tool);
    } else if (kind === "tool_completed") {
      const id = String(event.id || event.call_id || "");
      const name = String(event.name || event.tool_name || "tool");
      const completedAt = eventMilliseconds(event.ts);
      const matchedIndex = findRunningTool(items, id, name);
      if (matchedIndex >= 0) {
        const started = items[matchedIndex] as RestoredToolItem;
        items[matchedIndex] = {
          ...started,
          status: "done",
          success: event.success !== false,
          output: String(event.output || ""),
          filePath: toolFilePath(event, started.args) || started.filePath,
          completedAt,
          durationMs:
            started.startedAt !== undefined && completedAt !== undefined
              ? Math.max(0, completedAt - started.startedAt)
              : undefined,
        };
      } else {
        items.push({
          kind: "tool",
          id: id || name,
          name,
          status: "done",
          success: event.success !== false,
          output: String(event.output || ""),
          filePath: toolFilePath(event),
          completedAt,
        } satisfies RestoredToolItem);
      }
    } else if (kind === "done") {
      const usage = record(event.usage);
      const runCost = usage?.run_cost_usd;
      items.push({
        kind: "status",
        text: `${completionStatus(event.status)}${
          event.iterations != null ? ` · ${event.iterations} iters` : ""
        }${
          typeof runCost === "number" && Number.isFinite(runCost)
            ? ` · run ~${formatUsd(runCost)}`
            : ""
        }`,
      });
    }
  }
  return items;
}
