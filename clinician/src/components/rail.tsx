"use client";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import "./rail.css";

const MIN = 168;
const MAX = 360;
const COLLAPSED = 64;
const DEFAULT = 204;

function read(key: string) {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? "null") as { width?: number; collapsed?: boolean } | null;
    return { width: Math.min(MAX, Math.max(MIN, v?.width ?? DEFAULT)), collapsed: !!v?.collapsed };
  } catch {
    return { width: DEFAULT, collapsed: false };
  }
}

/** Width and collapsed state of the navigation rail, remembered per portal in this browser. */
export function useRail(key: string) {
  const [state, setState] = useState({ width: DEFAULT, collapsed: false });
  const [dragging, setDragging] = useState(false);
  useEffect(() => setState(read(key)), [key]);
  useEffect(() => {
    try { localStorage.setItem(key, JSON.stringify(state)); } catch { /* storage unavailable: keep it for this visit */ }
  }, [key, state]);
  const rail = state.collapsed ? COLLAPSED : state.width;
  return {
    ...state,
    dragging,
    setDragging,
    style: { "--rail": `${rail}px` } as CSSProperties,
    className: (state.collapsed ? " rail-collapsed" : "") + (dragging ? " rail-dragging" : ""),
    toggle: useCallback(() => setState((s) => ({ ...s, collapsed: !s.collapsed })), []),
    /** A menu item was clicked: a collapsed rail opens; clicking the page you are already on folds it away. */
    navClick: useCallback((current: boolean) => setState((s) => (s.collapsed ? { ...s, collapsed: false } : current ? { ...s, collapsed: true } : s)), []),
    setWidth: useCallback((width: number, collapsed = false) => setState({ width: Math.min(MAX, Math.max(MIN, width)), collapsed }), []),
  };
}
export type Rail = ReturnType<typeof useRail>;

/**
 * Lives inside the rail: a collapse button at the bottom and a grip on the right edge to drag the width.
 * Dragging far to the left collapses it; dragging a collapsed rail out opens it again. Double-click the grip to toggle.
 */
export function RailControls({ rail }: { rail: Rail }) {
  const start = useRef<{ x: number; width: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  // Collapsed items show their name as a tooltip.
  useEffect(() => {
    const aside = ref.current?.closest("aside");
    aside?.querySelectorAll<HTMLElement>(".nav-item").forEach((item) => {
      const name = item.querySelector(".nav-label")?.textContent ?? "";
      if (rail.collapsed) item.title = name;
      else if (item.title === name) item.removeAttribute("title");
    });
  }, [rail.collapsed]);

  function down(e: ReactPointerEvent<HTMLDivElement>) {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    start.current = { x: e.clientX, width: rail.collapsed ? COLLAPSED : rail.width };
    rail.setDragging(true);
  }
  function move(e: ReactPointerEvent<HTMLDivElement>) {
    if (!start.current) return;
    const next = start.current.width + (e.clientX - start.current.x);
    if (next < (MIN + COLLAPSED) / 2) rail.setWidth(rail.width, true);
    else rail.setWidth(next, false);
  }
  function up(e: ReactPointerEvent<HTMLDivElement>) {
    if (!start.current) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    start.current = null;
    rail.setDragging(false);
  }
  function key(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "ArrowLeft") { e.preventDefault(); rail.collapsed || rail.width - 16 < MIN ? rail.setWidth(rail.width, true) : rail.setWidth(rail.width - 16); }
    if (e.key === "ArrowRight") { e.preventDefault(); rail.setWidth(rail.collapsed ? rail.width : rail.width + 16); }
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); rail.toggle(); }
  }

  return (
    <>
      <div className="rail-foot" ref={ref}>
        <button type="button" className="nav-item rail-toggle" onClick={rail.toggle} aria-expanded={!rail.collapsed}
          aria-label={rail.collapsed ? "Fäll ut menyn" : "Fäll ihop menyn"} title={rail.collapsed ? "Fäll ut menyn" : "Fäll ihop menyn"}>
          {rail.collapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
          <span className="nav-label">Fäll ihop</span>
        </button>
      </div>
      <div className="rail-grip" role="separator" aria-orientation="vertical" aria-label="Ändra menyns bredd"
        aria-valuemin={COLLAPSED} aria-valuemax={MAX} aria-valuenow={rail.collapsed ? COLLAPSED : rail.width} tabIndex={0}
        onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onDoubleClick={rail.toggle} onKeyDown={key}
        title="Dra för att ändra bredd · dubbelklicka för att fälla ihop" />
    </>
  );
}
