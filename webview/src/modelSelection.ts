/** Model-specific reasoning controls shared by Settings and the thread picker. */
export function modelSupportsEffort(model: string): boolean {
  const m = model.trim().toLowerCase().replace(/^openai\./, "");
  return /^(o1|o3|o4|gpt-5\.5|gpt-5\.6|gpt-6-astra)/.test(m)
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
  const m = model.trim().toLowerCase().replace(/^openai\./, "");
  if (m.startsWith("gpt-6-astra")) {
    return [...EFFORT_OPTIONS.filter((option) => option.value !== "none"),
      { value: "max", label: "Max" }];
  }
  return EFFORT_OPTIONS;
}
