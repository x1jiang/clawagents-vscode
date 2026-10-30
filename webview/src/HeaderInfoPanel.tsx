import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

export function HeaderInfoPanel({ open, onOpenChange, context, cost, children }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  context: string;
  cost: string;
  children: ReactNode;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout>>();
  const [hovered, setHovered] = useState(false);
  const [position, setPosition] = useState({ left: 12, top: 12, maxHeight: 480 });
  const visible = open || hovered;
  const keepOpen = () => { clearTimeout(closeTimer.current); setHovered(true); };
  const leave = () => { closeTimer.current = setTimeout(() => setHovered(false), 160); };
  useEffect(() => () => clearTimeout(closeTimer.current), []);
  useLayoutEffect(() => {
    if (!visible) return;
    const place = () => {
      const anchor = trigger.current?.getBoundingClientRect();
      const popup = panel.current;
      if (!anchor || !popup) return;
      const width = popup.getBoundingClientRect().width;
      const left = Math.max(12, Math.min(open ? anchor.left : anchor.right + 8, window.innerWidth - width - 12));
      // A preview grows right; the pinned card grows down from the button.
      const top = Math.min(open || left < anchor.right ? anchor.bottom + 8 : anchor.top, Math.max(12, window.innerHeight - 100));
      setPosition({ left, top, maxHeight: Math.max(60, window.innerHeight - top - 12) });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [visible, open]);
  useEffect(() => {
    if (!visible) return;
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !trigger.current?.contains(event.target) && !panel.current?.contains(event.target)) {
        onOpenChange(false); setHovered(false);
      }
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation(); onOpenChange(false); setHovered(false); trigger.current?.focus();
      }
    };
    const blur = (event: FocusEvent) => {
      if (event.target instanceof Node && !trigger.current?.contains(event.target) && !panel.current?.contains(event.target)) {
        onOpenChange(false); setHovered(false);
      }
    };
    const windowBlur = () => { onOpenChange(false); setHovered(false); };
    document.addEventListener("focusin", blur);
    window.addEventListener("blur", windowBlur);
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("focusin", blur); window.removeEventListener("blur", windowBlur); document.removeEventListener("pointerdown", dismiss); document.removeEventListener("keydown", escape); };
  }, [visible, onOpenChange]);
  return <>
    <button ref={trigger} type="button" className="header-info-trigger" aria-expanded={open}
      aria-controls={visible ? "conversation-info-panel" : undefined}
      aria-label="Conversation information" onMouseEnter={keepOpen} onMouseLeave={leave}
      onClick={() => { setHovered(false); onOpenChange(!open); }}>
      <span className="info-trigger-icon" aria-hidden="true">i</span> Info
      <span className="info-trigger-chevron" aria-hidden="true">{open ? "⌄" : "›"}</span>
    </button>
    {visible && createPortal(<div ref={panel} id="conversation-info-panel"
      className={`header-info-popover ${open ? "is-expanded" : "is-preview"}`}
      style={position} role="region" aria-label="Conversation information"
      onMouseEnter={keepOpen} onMouseLeave={leave}>
      {open ? <>
        <div className="info-panel-heading"><h2>Session overview</h2><span className="info-eyebrow">USAGE & TIMING</span></div>
        {children}
      </> : <>
        <span className="info-eyebrow">AT A GLANCE</span>
        <div className="info-preview-values"><div><span>Context</span><strong>{context}</strong></div><div><span>Session cost</span><strong>{cost}</strong></div></div>
        <button type="button" className="info-preview-expand" onClick={() => onOpenChange(true)}>View session details <span aria-hidden="true">↘</span></button>
      </>}
    </div>, document.body)}
  </>;
}
