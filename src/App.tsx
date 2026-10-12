import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { TitleBar, type TabInfo } from "./components/TitleBar";
import { TerminalTab } from "./components/TerminalTab";
import { SettingsDialog } from "./components/Settings";
import { WaitingArcade } from "./components/WaitingArcade";
import { closeTab as closeBackendTab, getSettings, isAdminMode } from "./lib/shell";
import type { SplitLaunchInfo } from "./lib/splitDetection";
import type { CommandEntry, Entry, NoticeEntry, Settings, SplitArchiveEntry } from "./types";

interface TabMeta {
  cwd: string;
  virtualEnv?: string | null;
  busy: boolean;
}

interface TabSpec {
  id: string;
  /** Optional folder to start in. New tabs use the user's home directory by default. */
  cwd?: string;
}

interface SplitSpec {
  id: string;
  cwd?: string;
  virtualEnv?: string | null;
  command?: string;
  acceptsInput: boolean;
  running: boolean;
  movedTab?: TabSpec;
}

type PaneNode =
  | { kind: "leaf"; tab: TabSpec }
  | { kind: "split"; axis: "side" | "stack"; first: PaneNode; second: PaneNode };

function paneLeafCount(node: PaneNode): number {
  return node.kind === "leaf" ? 1 : paneLeafCount(node.first) + paneLeafCount(node.second);
}

function paneTabs(node: PaneNode): TabSpec[] {
  return node.kind === "leaf" ? [node.tab] : [...paneTabs(node.first), ...paneTabs(node.second)];
}

function paneSplitAxis(node: PaneNode, id: string, inherited?: "side" | "stack"): "side" | "stack" | undefined {
  if (node.kind === "leaf") return node.tab.id === id ? inherited : undefined;
  return paneSplitAxis(node.first, id, node.axis) ?? paneSplitAxis(node.second, id, node.axis);
}

function removePaneTab(node: PaneNode, id: string): PaneNode | null {
  if (node.kind === "leaf") return node.tab.id === id ? null : node;
  const first = removePaneTab(node.first, id);
  const second = removePaneTab(node.second, id);
  if (!first) return second;
  if (!second) return first;
  return { ...node, first, second };
}

function insertPaneTab(node: PaneNode, targetId: string, tab: TabSpec, axis: "side" | "stack", before: boolean): PaneNode {
  if (node.kind === "leaf") {
    if (node.tab.id !== targetId) return node;
    const added: PaneNode = { kind: "leaf", tab };
    return { kind: "split", axis, first: before ? added : node, second: before ? node : added };
  }
  return {
    ...node,
    first: insertPaneTab(node.first, targetId, tab, axis, before),
    second: insertPaneTab(node.second, targetId, tab, axis, before),
  };
}

interface PaneRect { left: number; top: number; width: number; height: number }

function paneRects(node: PaneNode, rect: PaneRect = { left: 0, top: 0, width: 1, height: 1 }, result: Record<string, PaneRect> = {}): Record<string, PaneRect> {
  if (node.kind === "leaf") {
    result[node.tab.id] = rect;
    return result;
  }
  if (node.axis === "side") {
    const half = rect.width / 2;
    paneRects(node.first, { ...rect, width: half }, result);
    paneRects(node.second, { ...rect, left: rect.left + half, width: half }, result);
  } else {
    const half = rect.height / 2;
    paneRects(node.first, { ...rect, height: half }, result);
    paneRects(node.second, { ...rect, top: rect.top + half, height: half }, result);
  }
  return result;
}

interface ConfirmationRequest {
  message: string;
}

function folderName(cwd: string | undefined): string {
  if (!cwd) return "PSOperator";
  const name = cwd.split(/[\\/]/).filter(Boolean).pop();
  return name ?? cwd;
}

export default function App() {
  const counter = useRef(1);
  const [tabs, setTabs] = useState<TabSpec[]>([{ id: "t1" }]);
  const [activeId, setActiveId] = useState("t1");
  const [meta, setMeta] = useState<Record<string, TabMeta>>({});
  const [splits, setSplits] = useState<Record<string, SplitSpec>>({});
  const [paneTrees, setPaneTrees] = useState<Record<string, PaneNode>>({});
  const splitCounter = useRef(0);
  const archiveCounter = useRef(0);
  const splitEntries = useRef<Record<string, Entry[]>>({});
  const archiveSinks = useRef<Record<string, (entry: SplitArchiveEntry) => void>>({});
  const [splitRatio, setSplitRatio] = useState(0.5);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [minigamesOpen, setMinigamesOpen] = useState(false);
  const [confirmation, setConfirmation] = useState<ConfirmationRequest | null>(null);
  const confirmationResolver = useRef<((confirmed: boolean) => void) | null>(null);
  const [appearance, setAppearance] = useState({ fontSize: 13.5, theme: "dark" });
  const [adminMode, setAdminMode] = useState(false);
  const [splitMode, setSplitMode] = useState<Settings["splitMode"]>("manual");
  const [dragTabId, setDragTabId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ rootId: string; paneId: string; zone: number } | null>(null);

  useEffect(() => {
    Promise.all([getSettings(), isAdminMode()]).then(([settings, elevated]) => {
      const { fontSize, theme } = settings;
      setAppearance({ fontSize: fontSize ?? 13.5, theme: theme ?? "dark" });
      setSplitMode(settings.splitMode ?? "manual");
      setAdminMode(elevated);
    }).catch(() => {});
    const onAppearance = (event: Event) => setAppearance((event as CustomEvent<typeof appearance>).detail);
    const onSettings = (event: Event) => setSplitMode((event as CustomEvent<Settings>).detail.splitMode ?? "manual");
    window.addEventListener("psoperator:appearance", onAppearance);
    window.addEventListener("psoperator:settings", onSettings);
    return () => {
      window.removeEventListener("psoperator:appearance", onAppearance);
      window.removeEventListener("psoperator:settings", onSettings);
    };
  }, []);

  // This is a keyboard-driven terminal UI; browser context menus get in the way
  // of selection and can expose actions that do not apply to the shell.
  useEffect(() => {
    const preventContextMenu = (event: MouseEvent) => event.preventDefault();
    window.addEventListener("contextmenu", preventContextMenu);
    return () => window.removeEventListener("contextmenu", preventContextMenu);
  }, []);

  // Reloading the webview remounts the UI while backend shell processes may
  // still be running. Block the common browser refresh shortcuts to protect
  // active sessions from getting out of sync with their transcript.
  useEffect(() => {
    const preventRefresh = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      const refresh = key === "f5" || ((event.ctrlKey || event.metaKey) && key === "r");
      if (!refresh) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    window.addEventListener("keydown", preventRefresh, true);
    return () => window.removeEventListener("keydown", preventRefresh, true);
  }, []);

  const onMeta = useCallback((id: string, cwd: string, virtualEnv: string | null, busy: boolean) => {
    setMeta((m) => (
      m[id]?.cwd === cwd && m[id]?.virtualEnv === virtualEnv && m[id]?.busy === busy
        ? m
        : { ...m, [id]: { cwd, virtualEnv, busy } }
    ));
  }, []);

  const onSplitEntries = useCallback((id: string, entries: Entry[]) => {
    splitEntries.current[id] = entries;
  }, []);

  const registerArchiveSink = useCallback((id: string, sink: ((entry: SplitArchiveEntry) => void) | null) => {
    if (sink) archiveSinks.current[id] = sink;
    else delete archiveSinks.current[id];
  }, []);

  const newTab = useCallback(() => {
    const id = `t${++counter.current}`;
    setTabs((t) => [...t, { id }]);
    setActiveId(id);
  }, []);

  const getDropTarget = useCallback((x: number, y: number) => {
    const hit = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-pane-root][data-pane-id]");
    if (!hit) return null;
    const rootId = hit.dataset.paneRoot;
    const paneId = hit.dataset.paneId;
    if (!rootId || !paneId) return null;
    const tree = paneTrees[rootId];
    const inheritedAxis = tree ? paneSplitAxis(tree, paneId) : undefined;
    const axis: "side" | "stack" = inheritedAxis === "side" ? "stack" : "side";
    const bounds = hit.getBoundingClientRect();
    const xRatio = (x - bounds.left) / bounds.width;
    const yRatio = (y - bounds.top) / bounds.height;
    const zone = axis === "stack"
      ? (yRatio < 0.5 ? 0 : 1)
      : (xRatio < 0.5 ? 0 : 1);
    return { rootId, paneId, zone, axis };
  }, [paneTrees, splits]);

  const dropTabIntoSplit = useCallback((draggedId: string, x: number, y: number) => {
    const target = getDropTarget(x, y);
    if (!target || draggedId === target.paneId || splits[draggedId] || paneTrees[draggedId]) return;
    const moved = tabs.find((tab) => tab.id === draggedId);
    if (!moved || draggedId === target.rootId) return;
    const rootTab = tabs.find((tab) => tab.id === target.rootId);
    const root = paneTrees[target.rootId] ?? (rootTab ? { kind: "leaf" as const, tab: rootTab } : null);
    if (!root || !paneTabs(root).some((tab) => tab.id === target.paneId)) return;
    const next = insertPaneTab(root, target.paneId, moved, target.axis, target.zone === 0);
    setPaneTrees((current) => ({ ...current, [target.rootId]: next }));
    setTabs((current) => current.filter((tab) => tab.id !== draggedId));
    setActiveId(target.rootId);
    setDragTabId(null);
    setDropTarget(null);
  }, [getDropTarget, paneTrees, splits, tabs]);

  const askConfirmation = useCallback((message: string) => new Promise<boolean>((resolve) => {
    confirmationResolver.current?.(false);
    confirmationResolver.current = resolve;
    setConfirmation({ message });
  }), []);

  const finishConfirmation = useCallback((confirmed: boolean) => {
    setConfirmation(null);
    const resolve = confirmationResolver.current;
    confirmationResolver.current = null;
    resolve?.(confirmed);
  }, []);

  useEffect(() => {
    if (!confirmation) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      finishConfirmation(false);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [confirmation, finishConfirmation]);

  const closeTab = useCallback(
    async (id: string) => {
      if (meta[id]?.busy && !(await askConfirmation("A command is still running in this tab. Close it anyway?"))) {
        return;
      }
      const split = splits[id];
      if (split && meta[split.id]?.busy && !(await askConfirmation("A command is still running in the split session. Close both sessions anyway?"))) {
        return;
      }
      const movedTabs = paneTrees[id] ? paneTabs(paneTrees[id]).filter((tab) => tab.id !== id) : [];
      if (movedTabs.some((tab) => meta[tab.id]?.busy) && !(await askConfirmation("A command is still running in a split tab. Close all panes anyway?"))) return;
      if (tabs.length === 1) {
        void getCurrentWindow().close();
        return;
      }
      const index = tabs.findIndex((t) => t.id === id);
      const remaining = tabs.filter((t) => t.id !== id);
      if (id === activeId) {
        setActiveId(remaining[Math.min(index, remaining.length - 1)].id);
      }
      setTabs(remaining);
      setMeta((m) => {
        const rest = { ...m };
        delete rest[id];
        if (split) delete rest[split.id];
        for (const tab of movedTabs) delete rest[tab.id];
        return rest;
      });
      void closeBackendTab(id);
      if (split) {
        void closeBackendTab(split.id);
        setSplits((current) => {
          const { [id]: _closed, ...rest } = current;
          return rest;
        });
      }
      for (const tab of movedTabs) void closeBackendTab(tab.id);
      if (movedTabs.length) setPaneTrees((current) => { const { [id]: _closed, ...rest } = current; return rest; });
    },
    [meta, tabs, activeId, splits, paneTrees, askConfirmation],
  );

  const runInSplit = useCallback((parentId: string, command: string, info: SplitLaunchInfo) => {
    const existing = splits[parentId];
    if (existing?.running) return;
    if (existing) {
      void closeBackendTab(existing.id);
      setMeta((current) => {
        const { [existing.id]: _closed, ...rest } = current;
        return rest;
      });
    }
    const id = `${parentId}-split-${++splitCounter.current}`;
    setSplits((current) => ({
      ...current,
      [parentId]: { id, cwd: meta[parentId]?.cwd, virtualEnv: meta[parentId]?.virtualEnv, command, acceptsInput: info.acceptsInput, running: true },
    }));
  }, [meta, splits]);

  const markProgramExited = useCallback((parentId: string) => {
    setSplits((current) => {
      const split = current[parentId];
      return split?.running ? { ...current, [parentId]: { ...split, running: false } } : current;
    });
  }, []);

  const restartProgram = useCallback((parentId: string) => {
    const current = splits[parentId];
    if (!current?.command) return;
    // Give the restarted process a new backend identity so late output/exit
    // events from the previous process cannot affect its fresh pane.
    void closeBackendTab(current.id);
    setMeta((state) => {
      const { [current.id]: _closed, ...rest } = state;
      return rest;
    });
    const id = `${parentId}-split-${++splitCounter.current}`;
    setSplits((state) => ({
      ...state,
      [parentId]: { ...current, id, running: true },
    }));
  }, [splits]);

  const closeSplit = useCallback(async (parentId: string) => {
    const split = splits[parentId];
    if (!split) return;
    if (meta[split.id]?.busy && !(await askConfirmation("A command is still running in the split session. Close it anyway?"))) return;
    if (split.movedTab) {
      setTabs((current) => [...current, split.movedTab!]);
      setSplits((current) => {
        const { [parentId]: _closed, ...rest } = current;
        return rest;
      });
      return;
    }
    const paneEntries = (splitEntries.current[split.id] ?? [])
      .filter((entry): entry is CommandEntry | NoticeEntry => entry.type !== "splitArchive");
    if (paneEntries.length) {
      const archiveId = `${split.id}-archive-${++archiveCounter.current}`;
      const archivedAt = Date.now();
      const archivedEntries = paneEntries.map((entry) => {
        const id = `${archiveId}-${entry.id}`;
        if (entry.type === "command" && entry.status === "running") {
          return { ...entry, id, status: "interrupted" as const, code: -1, endedAt: archivedAt };
        }
        return { ...entry, id };
      });
      archiveSinks.current[parentId]?.({
        type: "splitArchive",
        id: archiveId,
        command: split.command ?? "Program session",
        entries: archivedEntries,
      });
    }
    delete splitEntries.current[split.id];
    setSplits((current) => {
      const { [parentId]: _closed, ...rest } = current;
      return rest;
    });
    setMeta((current) => {
      const { [split.id]: _closed, ...rest } = current;
      return rest;
    });
    void closeBackendTab(split.id);
  }, [meta, splits, askConfirmation]);

  const returnSplitTab = useCallback((parentId: string, tabId: string) => {
    const tree = paneTrees[parentId];
    const returned = tree ? paneTabs(tree).find((tab) => tab.id === tabId) : undefined;
    if (!returned) return;
    setPaneTrees((current) => {
      const root = current[parentId];
      if (!root) return current;
      const remaining = removePaneTab(root, tabId);
      const next = { ...current };
      if (remaining && paneLeafCount(remaining) > 1) next[parentId] = remaining;
      else delete next[parentId];
      return next;
    });
    setTabs((tabsNow) => [...tabsNow, returned]);
  }, [paneTrees]);

  const resizeSplit = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const columns = event.currentTarget.parentElement;
    if (!columns) return;
    const rect = columns.getBoundingClientRect();
    const move = (pointerEvent: globalThis.PointerEvent) => {
      setSplitRatio(Math.max(0.25, Math.min(0.75, (pointerEvent.clientX - rect.left) / rect.width)));
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    move(event.nativeEvent);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
  }, []);

  const select = useCallback(
    (offset: number) => {
      const i = tabs.findIndex((t) => t.id === activeId);
      setActiveId(tabs[(i + offset + tabs.length) % tabs.length].id);
    },
    [tabs, activeId],
  );

  const openSettings = useCallback(() => setSettingsOpen(true), []);
  const closeSettings = useCallback(() => {
    setSettingsOpen(false);
    requestAnimationFrame(() =>
      document.querySelector<HTMLTextAreaElement>(".tab-pane.active textarea:not(:disabled)")?.focus(),
    );
  }, []);

  // Global shortcuts (capture phase, so they win over the prompt's own handling).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.altKey || e.metaKey) return;
      const key = e.key.toLowerCase();
      let handled = true;

      if (key === "t" && !e.shiftKey) newTab();
      else if (key === "w" && !e.shiftKey) closeTab(activeId);
      else if (e.key === "Tab") select(e.shiftKey ? -1 : 1);
      else if (e.key === ",") openSettings();
      else if (/^[1-9]$/.test(e.key)) {
        const target = tabs[Number(e.key) - 1];
        if (target) setActiveId(target.id);
      } else handled = false;

      if (handled) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [newTab, closeTab, select, openSettings, tabs, activeId]);

  const tabInfos: TabInfo[] = useMemo(
    () =>
      tabs.map((t) => ({
        id: t.id,
        title: folderName(meta[t.id]?.cwd || t.cwd),
        virtualEnv: meta[t.id]?.virtualEnv,
        busy: meta[t.id]?.busy ?? false,
      })),
    [tabs, meta],
  );

  return (
    <div className={`app theme-${adminMode ? "admin" : appearance.theme}`} style={{ "--size": `${appearance.fontSize}px` } as React.CSSProperties}>
      <TitleBar
        tabs={tabInfos}
        activeId={activeId}
        onSelect={setActiveId}
        onClose={closeTab}
        onNew={newTab}
        onDragTab={setDragTabId}
        onEndDragTab={() => { setDragTabId(null); setDropTarget(null); }}
        onHoverDropPoint={(x, y) => {
          const target = getDropTarget(x, y);
          setDropTarget(target && target.paneId !== dragTabId ? target : null);
        }}
        onDropTab={dropTabIntoSplit}
        adminMode={adminMode}
      />

      <div className="panes">
        {tabs.map((t) => {
          const tree = paneTrees[t.id] ?? { kind: "leaf" as const, tab: t };
          const paneCount = paneLeafCount(tree) + (splits[t.id] ? 1 : 0);
          const panePositions = paneRects(tree);
          const renderLeaf = (paneTab: TabSpec) => {
            const isRoot = paneTab.id === t.id;
            const showIndicators = !!dragTabId && paneTab.id !== dragTabId
              && (paneCount === 2 || dropTarget?.paneId === paneTab.id);
            const inheritedAxis = paneSplitAxis(tree, paneTab.id);
            const zoneAxis = inheritedAxis === "side" ? "stack" : "side";
            const rect = panePositions[paneTab.id] ?? { left: 0, top: 0, width: 1, height: 1 };
            return <div className={`split-column pane-leaf${isRoot ? "" : " moved-split-pane"}`} key={paneTab.id}
              style={{ left: `${rect.left * 100}%`, top: `${rect.top * 100}%`, width: `${rect.width * 100}%`, height: `${rect.height * 100}%` }}
              data-pane-root={t.id} data-pane-id={paneTab.id}>
              {showIndicators && <div className={`pane-drop-indicators ${zoneAxis}`} aria-hidden="true">
                {[0, 1].map((zone) => <div key={zone} className={dropTarget?.rootId === t.id && dropTarget.paneId === paneTab.id && dropTarget.zone === zone ? "selected" : ""} />)}
              </div>}
              {!isRoot && <div className="moved-split-header">
                <span>{folderName(meta[paneTab.id]?.cwd || paneTab.cwd)}</span>
                <button className="split-close" onClick={() => returnSplitTab(t.id, paneTab.id)} title="Return tab to tab strip">Return tab <span>×</span></button>
              </div>}
              <TerminalTab
                tabId={paneTab.id}
                active={isRoot && t.id === activeId}
                inputDisabled={isRoot && !!splits[t.id]?.running}
                inputDisabledReason="Program is running in the process pane"
                initialCwd={paneTab.cwd}
                onMeta={onMeta}
                onNewTab={newTab}
                onCloseTab={() => isRoot ? closeTab(t.id) : returnSplitTab(t.id, paneTab.id)}
                onOpenSettings={openSettings}
                onOpenMinigames={() => setMinigamesOpen(true)}
                onRunInSplit={runInSplit}
                splitMode={splitMode}
                onRegisterArchiveSink={isRoot ? registerArchiveSink : undefined}
                canAutoSplit={isRoot}
              />
            </div>;
          };
          return <div className={`tab-layout${t.id === activeId ? " active" : ""}${splits[t.id] || paneCount > 1 ? " split" : ""}`} key={t.id}>
            <div className={`split-toolbar${paneCount > 1 ? "" : " hidden"}`}>
              <span><b>Main CLI</b><span className="split-paused-label">{splits[t.id]?.running ? "Input paused" : "Ready"}</span></span>
              <span className="split-toolbar-spacer" />
              {splits[t.id] && <>
                <span className="process-pane-heading"><b>Process</b><span className="split-session-label">{splits[t.id].running ? "Running" : "Exited"}</span></span>
                {splits[t.id].command && <code className="process-pane-command" title={splits[t.id].command}>{splits[t.id].command}</code>}
                <button className="split-restart" onClick={() => restartProgram(t.id)} disabled={!splits[t.id].command} title="Restart process">↻ <span>Restart</span></button>
                <button className="split-close" onClick={() => closeSplit(t.id)} title="Close process pane">Close pane <span>×</span></button>
              </>}
              {paneCount > 1 && <span className="split-session-label">{paneCount} panes</span>}
            </div>
            <div className="split-columns">
              <div className="pane-tree-host" style={{ width: splits[t.id] ? `${splitRatio * 100}%` : "100%" }}>
                {paneTabs(tree).map(renderLeaf)}
              </div>
              {splits[t.id] && <div className="split-divider" role="separator" aria-label="Resize split panes" onPointerDown={resizeSplit} />}
              {splits[t.id] && <div className="split-column split-secondary">
                <TerminalTab
                  key={splits[t.id].id}
                  tabId={splits[t.id].id}
                  active={t.id === activeId}
                  inputDisabled={!splits[t.id].running || !splits[t.id].acceptsInput || !meta[splits[t.id].id]?.busy}
                  inputDisabledReason={!splits[t.id].running ? "Program has exited" : "This program does not accept input"}
                  initialCwd={splits[t.id].cwd}
                  initialVirtualEnv={splits[t.id].virtualEnv}
                  initialCommand={splits[t.id].command}
                  onMeta={onMeta}
                  onNewTab={newTab}
                  onCloseTab={() => closeSplit(t.id)}
                  onOpenSettings={openSettings}
                  onOpenMinigames={() => setMinigamesOpen(true)}
                  onRunInSplit={runInSplit}
                  onEntriesSnapshot={onSplitEntries}
                  canAutoSplit={false}
                  onProgramExit={() => markProgramExited(t.id)}
                />
              </div>}
            </div>
          </div>;
        })}
      </div>

      {settingsOpen && <SettingsDialog onClose={closeSettings} adminMode={adminMode} />}
      {minigamesOpen && <WaitingArcade onClose={() => setMinigamesOpen(false)} />}
      {confirmation && (
        <div className="overlay confirm-overlay" onMouseDown={() => finishConfirmation(false)}>
          <section
            className="confirm-card"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="confirm-title"
            aria-describedby="confirm-message"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="confirm-icon" aria-hidden="true">!</div>
            <div className="confirm-copy">
              <h2 id="confirm-title">Close running program?</h2>
              <p id="confirm-message">{confirmation.message}</p>
              <div className="confirm-actions">
                <button className="confirm-cancel" autoFocus onClick={() => finishConfirmation(false)}>Cancel</button>
                <button className="confirm-accept" onClick={() => finishConfirmation(true)}>Close anyway</button>
              </div>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
