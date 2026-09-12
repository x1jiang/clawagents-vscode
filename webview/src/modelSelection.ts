import { normalizeModelId } from "./pricing";

/** Model-specific reasoning controls shared by Settings and the thread picker. */
export function modelSupportsEffort(model: string): boolean {
  const m = normalizeModelId(model);
  return /^(grok|gemini-3\.8|claude-fable-5-1|claude-opus-5|claude-sonnet-5|o1|o3|o4|gpt-5\.5|gpt-5\.6|gpt-6-astra)/.test(m)
    || m === "gpt-5" || m.startsWith("gpt-5-");
}

const EFFORT_OPTIONS = [
  { value: "low", label: "Light" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra High" },
  { value: "none", label: "None" },
];

export function effortOptionsForModel(model: string) {
  const m = normalizeModelId(model);
  if (m.startsWith("gemini-3.8")) return EFFORT_OPTIONS.filter(o => ["low", "medium", "high"].includes(o.value));
  if (m.startsWith("grok")) return EFFORT_OPTIONS.filter(o => o.value !== "none");
  if (/^(gpt-6-astra|claude-fable-5-1|claude-opus-5|claude-sonnet-5)/.test(m)) {
    return [...EFFORT_OPTIONS.filter((option) => option.value !== "none"),
      { value: "max", label: "Max" }];
  }
  return EFFORT_OPTIONS;
}

export function compatibleEffortForModel(model: string, effort: string): string {
  if (!effort || !modelSupportsEffort(model)) return "";
  const options = effortOptionsForModel(model).map(o => o.value);
  if (options.includes(effort)) return effort;
  if (effort === "none" || effort === "minimal") return "low";
  if (effort === "max" || effort === "xhigh") return options.includes("xhigh") ? "xhigh" : "high";
  return "medium";
}
