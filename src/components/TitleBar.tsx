import { getCurrentWindow } from "@tauri-apps/api/window";
import { useState, type PointerEvent as ReactPointerEvent } from "react";

export interface TabInfo {
  id: string;
  title: string;
  virtualEnv?: string | null;
  busy: boolean;
}

interface Props {
  tabs: TabInfo[];
  activeId: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
  onDragTab: (id: string) => void;
  onEndDragTab: () => void;
  onHoverDropPoint: (x: number, y: number) => void;
  onDropTab: (id: string, x: number, y: number) => void;
  adminMode: boolean;
}

export function TitleBar({ tabs, activeId, onSelect, onClose, onNew, onDragTab, onEndDragTab, onHoverDropPoint, onDropTab, adminMode }: Props) {
  const win = getCurrentWindow();
  const [dragPreview, setDragPreview] = useState<{ id: string; x: number; y: number } | null>(null);

  const beginTabDrag = (id: string, event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    const startX = event.clientX;
    const startY = event.clientY;
    let dragging = false;
    const move = (pointerEvent: PointerEvent) => {
      if (!dragging && Math.hypot(pointerEvent.clientX - startX, pointerEvent.clientY - startY) > 7) {
        dragging = true;
        onDragTab(id);
      }
      if (!dragging) return;
      setDragPreview({ id, x: pointerEvent.clientX, y: pointerEvent.clientY });
      onHoverDropPoint(pointerEvent.clientX, pointerEvent.clientY);
      pointerEvent.preventDefault();
    };
    const end = (pointerEvent: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      if (dragging) {
        setDragPreview(null);
        const insideWindow = pointerEvent.clientX >= 0 && pointerEvent.clientX <= window.innerWidth
          && pointerEvent.clientY >= 34 && pointerEvent.clientY <= window.innerHeight;
        if (insideWindow) onDropTab(id, pointerEvent.clientX, pointerEvent.clientY);
        onEndDragTab();
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end, { once: true });
  };

  return (
    <>
    <header className="titlebar" data-tauri-drag-region>
      <div className="titlebar-brand" data-tauri-drag-region>
        <span className="glyph" data-tauri-drag-region>✻</span>
        <span data-tauri-drag-region>PSOperator</span>
        {adminMode && <span className="admin-badge" data-tauri-drag-region>ADMIN</span>}
      </div>

      <div className="tabs" role="tablist">
        {tabs.map((t) => (
          <div
            key={t.id}
            className={`tab${t.id === activeId ? " active" : ""}`}
            role="tab"
            aria-selected={t.id === activeId}
            onMouseDown={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                onClose(t.id);
              }
            }}
          >
            <button className="tab-main" onPointerDown={(event) => beginTabDrag(t.id, event)} onClick={() => onSelect(t.id)} title={t.title}>
              <span className={`tab-dot${t.busy ? " busy" : ""}`} aria-hidden="true">
                {t.busy ? <span className="tab-busy-icon"><svg viewBox="0 0 16 16"><path d="M8 1.5v3M8 11.5v3M1.5 8h3m7 0h3M3.4 3.4l2.1 2.1m5 5 2.1 2.1m0-9.2-2.1 2.1m-5 5-2.1 2.1" /></svg></span> : <span className="tab-idle-icon"><svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="2" /></svg></span>}
              </span>
              <span className="tab-title">{t.title}</span>
              {t.virtualEnv && <span className="tab-venv" title={`Python environment: ${t.virtualEnv}`}>venv</span>}
            </button>
            <button
              className="tab-close"
              aria-label={`Close ${t.title}`}
              onClick={() => onClose(t.id)}
            >
              <svg className="tab-close-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" /></svg>
            </button>
          </div>
        ))}
        <button className="tab-new" aria-label="New tab" title="New tab (Ctrl+T)" onClick={onNew}>
          <svg className="tab-new-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3 8h10" /></svg>
        </button>
      </div>

      <div className="titlebar-spacer" data-tauri-drag-region />

      <div className="titlebar-controls">
        <button aria-label="Minimize" onClick={() => void win.minimize()}>
          <svg width="10" height="10" viewBox="0 0 10 10"><path d="M0 5h10" stroke="currentColor" /></svg>
        </button>
        <button aria-label="Maximize" onClick={() => void win.toggleMaximize()}>
          <svg width="10" height="10" viewBox="0 0 10 10"><rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" /></svg>
        </button>
        <button className="close" aria-label="Close" onClick={() => void win.close()}>
          <svg width="10" height="10" viewBox="0 0 10 10"><path d="M0 0l10 10M10 0L0 10" stroke="currentColor" /></svg>
        </button>
      </div>
    </header>
    {dragPreview && (() => {
      const tab = tabs.find((item) => item.id === dragPreview.id);
      if (!tab) return null;
      return <div className="tab-drag-preview" style={{ left: dragPreview.x + 12, top: dragPreview.y + 12 }} aria-hidden="true">
        <span className={`tab-dot${tab.busy ? " busy" : ""}`}>
          {tab.busy ? <span className="tab-busy-icon"><svg viewBox="0 0 16 16"><path d="M8 1.5v3M8 11.5v3M1.5 8h3m7 0h3M3.4 3.4l2.1 2.1m5 5 2.1 2.1m0-9.2-2.1 2.1m-5 5-2.1 2.1" /></svg></span> : <span className="tab-idle-icon"><svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="2" /></svg></span>}
        </span>
        <span className="tab-title">{tab.title}</span>
        {tab.virtualEnv && <span className="tab-venv">venv</span>}
      </div>;
    })()}
    </>
  );
}
