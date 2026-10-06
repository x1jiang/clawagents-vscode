import { useEffect, useId, useRef, useState } from "react";
import type { Provider } from "./providerCatalog";

type ModelOption = {
  id: string;
  label?: string;
  available?: boolean;
};

type EffortOption = {
  value: string;
  label: string;
};

const COMMON_OPENAI_MODELS = ["gpt-6-astra", "gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"];

type Props = {
  disabled: boolean;
  busy: boolean;
  providerValue: string;
  providerLabel: string;
  providers: Provider[];
  models: ModelOption[];
  activeModelId: string;
  effort: string;
  showFastMode: boolean;
  fastMode: boolean;
  showEffort: boolean;
  efforts: readonly EffortOption[];
  onProviderChange: (value: string) => void;
  onModelChange: (value: string) => void;
  onEffortChange: (value: string) => void;
  onFastModeChange: (value: boolean) => void;
  onReset: () => void;
};

/** Compact current-route control with three directly selectable columns. */
export function ModelRouteCapsule({
  disabled,
  busy,
  providerValue,
  providerLabel,
  providers,
  models,
  activeModelId,
  effort,
  showFastMode,
  fastMode,
  showEffort,
  efforts,
  onProviderChange,
  onModelChange,
  onEffortChange,
  onFastModeChange,
  onReset,
}: Props) {
  const [open, setOpen] = useState(false);
  const fastTooltipId = useId();
  const root = useRef<HTMLDivElement>(null);
  const activeModel = models.find((item) => item.id === activeModelId);
  const effortLabel = efforts.find((item) => item.value === effort)?.label || "Default";
  const commonModels = COMMON_OPENAI_MODELS.flatMap((id) => {
    const model = models.find((item) => item.id === id);
    return model ? [model] : [];
  });
  const otherModels = models.filter((item) => !COMMON_OPENAI_MODELS.includes(item.id));

  useEffect(() => {
    if (!open) return undefined;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <div className="model-route-capsule-root" ref={root}>
      <div className="model-route-capsule">
        {showFastMode && (
          <button
            type="button"
            className={`model-route-fast-toggle${fastMode ? " active" : ""}`}
            disabled={disabled}
            aria-label="Fast mode"
            aria-pressed={fastMode}
            aria-describedby={fastTooltipId}
            onClick={() => onFastModeChange(!fastMode)}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M13 2 3 14h9l-1 8 10-12h-9l1-8Z" fill={fastMode ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
            </svg>
            <span id={fastTooltipId} className="model-route-fast-tooltip" role="tooltip">
              <span>Fast mode {fastMode ? "on" : "off"}</span>
              <span className="model-route-fast-tooltip-detail">Faster responses · higher API cost</span>
              {busy && <span className="model-route-fast-tooltip-detail">Applies next turn</span>}
            </span>
          </button>
        )}
        <button
          type="button"
          className="model-route-capsule-trigger"
          disabled={disabled}
          aria-haspopup="dialog"
          aria-expanded={open}
          title={`Model for this thread${busy ? " (applies next turn)" : ""}`}
          onClick={() => setOpen((value) => !value)}
        >
          <span className="model-route-capsule-main">
            {providerLabel} · {activeModel?.label || activeModelId || "Default"}
          </span>
          {showEffort && <span className="model-route-capsule-effort">{effortLabel}</span>}
          <svg className="model-route-capsule-chevron" viewBox="0 0 16 16" aria-hidden="true">
            <path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>
      {open && (
        <div className="model-route-popover" role="dialog" aria-label="Thread model settings">
          <section className="model-route-column" aria-label="Provider">
            <h3>Provider</h3>
            <div className="model-route-options">
              <button
                type="button"
                className={providerValue === "auto" ? "selected" : ""}
                onClick={() => onProviderChange("auto")}
                title="Use the saved default provider. It does not automatically choose the best model."
              >
                <span>Auto (default)</span>
                {providerValue === "auto" && <span aria-hidden="true">✓</span>}
              </button>
              {providers.map((provider) => (
                <button
                  key={provider.id}
                  type="button"
                  disabled={provider.available === false}
                  className={providerValue === provider.id ? "selected" : ""}
                  onClick={() => onProviderChange(provider.id)}
                >
                  <span>{provider.name}</span>
                  {providerValue === provider.id && <span aria-hidden="true">✓</span>}
                </button>
              ))}
            </div>
          </section>
          <section className="model-route-column" aria-label="Model">
            <h3>Model</h3>
            <div className="model-route-options">
              <button
                type="button"
                className={!activeModelId ? "selected" : ""}
                onClick={() => onModelChange("")}
              >
                <span>Default</span>
                {!activeModelId && <span aria-hidden="true">✓</span>}
              </button>
              {activeModelId && !models.some((item) => item.id === activeModelId) && (
                <button type="button" className="selected" disabled>
                  <span>{activeModelId} (unavailable)</span><span aria-hidden="true">✓</span>
                </button>
              )}
              {commonModels.length > 0 && <div className="model-route-group-label">Common</div>}
              {commonModels.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  disabled={item.available === false}
                  className={activeModelId === item.id ? "selected" : ""}
                  onClick={() => onModelChange(item.id)}
                >
                  <span>{item.label || item.id}</span>
                  {activeModelId === item.id && <span aria-hidden="true">✓</span>}
                </button>
              ))}
              {commonModels.length > 0 && otherModels.length > 0 && (
                <div className="model-route-group-label model-route-group-divider">All models</div>
              )}
              {otherModels.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  disabled={item.available === false}
                  className={activeModelId === item.id ? "selected" : ""}
                  onClick={() => onModelChange(item.id)}
                >
                  <span>{item.label || item.id}</span>
                  {activeModelId === item.id && <span aria-hidden="true">✓</span>}
                </button>
              ))}
            </div>
          </section>
          <section className="model-route-column model-route-effort-column" aria-label="Effort">
            <h3>Effort</h3>
            <div className="model-route-options">
              {showEffort ? efforts.map((item) => (
                <button
                  key={item.value}
                  type="button"
                  className={effort === item.value ? "selected" : ""}
                  onClick={() => onEffortChange(item.value)}
                >
                  <span>{item.label}</span>
                  {effort === item.value && <span aria-hidden="true">✓</span>}
                </button>
              )) : <p className="model-route-unavailable">This model uses the provider default.</p>}
            </div>
          </section>
          <footer className="model-route-footer">
            <button type="button" onClick={onReset}>↻ Reset to new-chat default</button>
          </footer>
        </div>
      )}
    </div>
  );
}
