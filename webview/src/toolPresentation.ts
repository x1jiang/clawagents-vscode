export type ToolCategory =
  | "read"
  | "search"
  | "inspect"
  | "command"
  | "edit"
  | "skill"
  | "context"
  | "web"
  | "generic";

export type ToolCallItem = {
  kind: "tool";
  id: string;
  name: string;
  args?: unknown;
  success?: boolean;
  output?: string;
  filePath?: string;
  status: "running" | "done";
  /** Browser time when the start event arrived. Live calls only. */
  startedAt?: number;
  /** Elapsed wall time between start and completion events. */
  durationMs?: number;
};

export type ToolPresentation = {
  category: ToolCategory;
  title: string;
  detail?: string;
};

const MAX_SUBJECT_LENGTH = 88;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string" || !value.trim().startsWith("{")) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function textField(record: Record<string, unknown> | undefined, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

function arrayLength(record: Record<string, unknown> | undefined, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record?.[key];
    if (Array.isArray(value)) return value.length;
  }
  return undefined;
}

function compact(value: string, max = MAX_SUBJECT_LENGTH): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

function basename(value: string): string {
  const normalized = value.replace(/[\\/]+$/, "");
  return normalized.split(/[\\/]/).pop() || value;
}

function displayPath(value: string): string {
  const normalized = value.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length <= 3) return compact(normalized || value);
  return `…/${parts.slice(-3).join("/")}`;
}

function toolLeafName(name: string): string {
  const namespaced = name.split("__").filter(Boolean);
  return (namespaced[namespaced.length - 1] || name).toLowerCase();
}

function humanizeToolName(name: string): string {
  return toolLeafName(name)
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function quote(value: string): string {
  return `“${compact(value, 64)}”`;
}

/**
 * Convert a raw tool event into a stable, user-facing English description.
 *
 * Specific formatters only consume common semantic fields. Anything unknown
 * falls through to a generic formatter, so registering a new backend tool is
 * never required for the transcript to remain useful.
 */
export function presentTool(call: ToolCallItem): ToolPresentation {
  const args = asRecord(call.args);
  const name = toolLeafName(call.name);
  const running = call.status === "running";
  const path = call.filePath || textField(args, ["path", "file_path", "target_path", "directory", "cwd"]);
  const query = textField(args, ["query", "pattern", "search", "text", "needle"]);
  const command = textField(args, ["command", "cmd", "script"]);

  if (name === "ctx_search" || name === "context_search") {
    return {
      category: "context",
      title: query
        ? `${running ? "Searching" : "Searched"} context for ${quote(query)}`
        : `${running ? "Searching" : "Searched"} context`,
      detail: path ? `Scope: ${displayPath(path)}` : undefined,
    };
  }

  if (name === "ctx_batch_execute" || name === "context_batch_execute") {
    const count = arrayLength(args, ["operations", "commands", "calls", "requests", "items"]);
    return {
      category: "context",
      title: running ? "Running context batch" : "Ran context batch",
      detail: count === undefined ? undefined : `${count} operation${count === 1 ? "" : "s"}`,
    };
  }

  if (name === "use_skill" || name === "load_skill") {
    const skill = textField(args, ["name", "skill", "skill_name"]);
    return {
      category: "skill",
      title: skill
        ? `${running ? "Loading" : "Loaded"} ${quote(skill)} skill`
        : `${running ? "Loading" : "Loaded"} a skill`,
    };
  }

  if (/^(read|read_file|open_file|get_file|view_file)$/.test(name)) {
    const target = path ? basename(path) : undefined;
    const start = textField(args, ["line", "start_line", "offset"]);
    const end = textField(args, ["end_line", "limit"]);
    return {
      category: "read",
      title: target
        ? `${running ? "Reading" : "Read"} ${target}`
        : running ? "Reading a file" : "Read a file",
      detail: path
        ? `${displayPath(path)}${start ? ` · lines ${start}${end ? `–${end}` : ""}` : ""}`
        : undefined,
    };
  }

  if (/^(ls|list|list_files|list_directory|find_files)$/.test(name)) {
    return {
      category: "inspect",
      title: path
        ? `${running ? "Inspecting" : "Inspected"} ${displayPath(path)}`
        : running ? "Inspecting files" : "Inspected files",
    };
  }

  if (name === "rg" || /^(search|search_files|grep|ripgrep|find_text)$/.test(name)) {
    return {
      category: "search",
      title: query
        ? `${running ? "Searching" : "Searched"} for ${quote(query)}`
        : running ? "Searching code" : "Searched code",
      detail: path ? `In ${displayPath(path)}` : undefined,
    };
  }

  if (/^(apply_patch|write_file|edit_file|replace|replace_file|create_file)$/.test(name)) {
    const target = path ? basename(path) : undefined;
    return {
      category: "edit",
      title: target
        ? `${running ? "Editing" : "Edited"} ${target}`
        : running ? "Editing files" : "Edited files",
      detail: path ? displayPath(path) : undefined,
    };
  }

  if (
    /^(execute|exec|exec_command|shell|bash|run_command)$/.test(name) ||
    name === "ctx_execute" ||
    name === "ctx_execute_file"
  ) {
    return {
      category: name.startsWith("ctx_") ? "context" : "command",
      title: command
        ? `${running ? "Running" : "Ran"} ${compact(command, 72)}`
        : running ? "Running a command" : "Ran a command",
      detail: path ? `In ${displayPath(path)}` : undefined,
    };
  }

  if (
    name.startsWith("browser_") ||
    /^(fetch|http|get_url|open_url|search_query|web_search)$/.test(name)
  ) {
    const url = textField(args, ["url", "href"]);
    return {
      category: "web",
      title: query
        ? `${running ? "Searching" : "Searched"} the web for ${quote(query)}`
        : running ? "Browsing the web" : "Browsed the web",
      detail: url ? compact(url) : undefined,
    };
  }

  const subject = path || query || command || textField(args, ["url", "name", "id"]);
  return {
    category: "generic",
    title: `${running ? "Running" : "Ran"} ${humanizeToolName(call.name) || "tool"}`,
    detail: subject ? compact(subject) : undefined,
  };
}

function activityPhrase(category: ToolCategory, count: number, running: boolean): string {
  const plural = count !== 1;
  if (running) {
    switch (category) {
      case "read": return `reading ${plural ? "files" : "a file"}`;
      case "search": return "searching code";
      case "inspect": return `inspecting ${plural ? "directories" : "a directory"}`;
      case "command": return `running ${plural ? "commands" : "a command"}`;
      case "edit": return `editing ${plural ? "files" : "a file"}`;
      case "skill": return `loading ${plural ? "skills" : "a skill"}`;
      case "context": return "querying context";
      case "web": return "browsing the web";
      case "generic": return `using ${plural ? "tools" : "a tool"}`;
    }
  }
  switch (category) {
    case "read": return `read ${plural ? "files" : "a file"}`;
    case "search": return "searched code";
    case "inspect": return `inspected ${plural ? "directories" : "a directory"}`;
    case "command": return `ran ${plural ? "commands" : "a command"}`;
    case "edit": return `edited ${plural ? "files" : "a file"}`;
    case "skill": return `loaded ${plural ? "skills" : "a skill"}`;
    case "context": return "queried context";
    case "web": return "browsed the web";
    case "generic": return `used ${plural ? "tools" : "a tool"}`;
  }
}

function englishList(parts: string[]): string {
  if (parts.length <= 1) return parts[0] || "used tools";
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}

export function summarizeToolRun(calls: ToolCallItem[], running: boolean): string {
  if (calls.length === 1) return presentTool(calls[0]).title;
  const counts = new Map<ToolCategory, number>();
  for (const call of calls) {
    const category = presentTool(call).category;
    counts.set(category, (counts.get(category) || 0) + 1);
  }
  const phrases = [...counts].map(([category, count]) => activityPhrase(category, count, running));
  const visible = phrases.length <= 3
    ? phrases
    : [...phrases.slice(0, 2), `used ${calls.length - [...counts].slice(0, 2).reduce((sum, [, count]) => sum + count, 0)} more tools`];
  const sentence = englishList(visible);
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

export function elapsedMs(call: ToolCallItem, now = Date.now()): number | undefined {
  if (typeof call.durationMs === "number") return Math.max(0, call.durationMs);
  if (typeof call.startedAt === "number") return Math.max(0, now - call.startedAt);
  return undefined;
}

export function formatToolDuration(milliseconds: number | undefined): string | undefined {
  if (milliseconds === undefined || !Number.isFinite(milliseconds)) return undefined;
  if (milliseconds < 1_000) return `${Math.max(1, Math.round(milliseconds))}ms`;
  if (milliseconds < 10_000) return `${(milliseconds / 1_000).toFixed(1)}s`;
  if (milliseconds < 60_000) return `${Math.round(milliseconds / 1_000)}s`;
  const minutes = Math.floor(milliseconds / 60_000);
  const seconds = Math.round((milliseconds % 60_000) / 1_000);
  return `${minutes}m ${seconds}s`;
}
