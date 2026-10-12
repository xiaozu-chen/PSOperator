import { useCallback, useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  CommandEntry,
  Entry,
  LineKind,
  NoticeTone,
  OutLine,
  SessionInfo,
} from "../types";
import * as api from "../lib/shell";
import { cleanLine } from "../lib/format";

/** Per-command cap so a runaway `Get-ChildItem -Recurse C:\` can't eat all memory. */
const MAX_LINES = 20_000;
const FLUSH_MS = 24;
const TRANSIENT_PROGRESS = /^\s*(?:remote:\s*)?(Enumerating objects|Counting objects|Compressing objects|Receiving objects|Resolving deltas|Writing objects|Updating files|Checking out files|Filtering content|Downloading LFS objects)\s*:/i;

export interface CommandProgress {
  label: string;
  percent: number | null;
}

function progressInfo(text: string): CommandProgress | null {
  const plain = text.replace(/\x1b\[[0-9;]*m/g, "");
  const stage = TRANSIENT_PROGRESS.exec(plain)?.[1];
  if (stage) {
    const percent = /\b(\d{1,3})%/.exec(plain)?.[1];
    return { label: stage, percent: percent === undefined ? null : Math.min(100, Number(percent)) };
  }

  // Common transfer tools (curl, wget, package managers) report a percentage
  // without a stable stage prefix. Keep this conservative to avoid treating
  // arbitrary percentages in command output as progress.
  const transfer = /^\s*(?:\[#?\s*\d+\s*)?([\w .-]{0,40}?(?:download|install|process|copy|extract|transfer)[\w .-]*?)\s*[:|-].*?\b(\d{1,3})%/i.exec(plain);
  if (transfer) return { label: transfer[1].trim() || "Processing", percent: Math.min(100, Number(transfer[2])) };
  return null;
}

function progressStage(text: string): string | null {
  return progressInfo(text)?.label.toLowerCase() ?? null;
}

interface OutputPayload {
  tabId: string;
  id: string | null;
  kind: "out" | "err";
  text: string;
}

interface ScreenCapture {
  enabled: boolean;
  pending: string;
  frame: string;
}

const ANSI_HOME = "\x1b[H";
const ANSI_CLEAR = "\x1b[2J";

function renderScreenFrame(frame: string): string {
  const plain = cleanLine(frame);
  const rows: string[] = [];
  for (let offset = 0; offset < plain.length; offset += 80) {
    rows.push(plain.slice(offset, offset + 80));
  }
  return rows.join("\n");
}

/** Capture simple ANSI full-screen output and return completed 80-column frames. */
function screenFrames(capture: ScreenCapture, text: string): string[] | null {
  capture.pending += text;
  if (!capture.enabled && capture.pending.includes(ANSI_CLEAR)) {
    capture.enabled = true;
  }
  if (!capture.enabled && !capture.pending.includes(ANSI_HOME)) {
    let suffix = 0;
    for (let length = 1; length < ANSI_HOME.length; length += 1) {
      if (capture.pending.endsWith(ANSI_HOME.slice(0, length))) suffix = length;
    }
    capture.pending = capture.pending.slice(capture.pending.length - suffix);
    return null;
  }

  capture.enabled = true;
  capture.pending = capture.pending.replaceAll(ANSI_CLEAR, "");
  const frames: string[] = [];
  while (true) {
    const home = capture.pending.indexOf(ANSI_HOME);
    if (home >= 0) {
      capture.frame += capture.pending.slice(0, home);
      if (capture.frame.length > 0) frames.push(renderScreenFrame(capture.frame));
      capture.frame = "";
      capture.pending = capture.pending.slice(home + ANSI_HOME.length);
      continue;
    }

    // A stream read can split ESC[H over two chunks. Keep a matching suffix
    // until the next event so the cursor-home marker is never printed as text.
    let suffix = 0;
    for (let length = 1; length < ANSI_HOME.length; length += 1) {
      if (capture.pending.endsWith(ANSI_HOME.slice(0, length))) suffix = length;
    }
    capture.frame += capture.pending.slice(0, capture.pending.length - suffix);
    capture.pending = capture.pending.slice(capture.pending.length - suffix);
    break;
  }
  return frames;
}
interface DonePayload {
  tabId: string;
  id: string;
  ok: boolean;
  code: number;
  cwd: string;
  virtualEnv: string | null;
  interrupted: boolean;
}
interface ReadyPayload {
  tabId: string;
  shell: string;
  version: string;
  cwd: string;
  virtualEnv: string | null;
}
interface ExitPayload {
  tabId: string;
  id: string | null;
}

const errText = (e: unknown) => (typeof e === "string" ? e : e instanceof Error ? e.message : String(e));

export function useShell(tabId: string, initialCwd?: string) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [session, setSession] = useState<SessionInfo>({
    shell: "PowerShell",
    version: "",
    cwd: "",
  });
  const [runningId, setRunningId] = useState<string | null>(null);
  const [progress, setProgress] = useState<CommandProgress | null>(null);

  const pending = useRef<Map<string, OutLine[]>>(new Map());
  const screenCaptures = useRef<Map<string, ScreenCapture>>(new Map());
  const timer = useRef<number | null>(null);
  const seq = useRef(0);
  const onFinished = useRef<Map<string, () => void>>(new Map());

  const nextId = (prefix: string) => `${prefix}${++seq.current}`;

  // ── output batching ──────────────────────────────────────────────
  const flush = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    if (pending.current.size === 0) return;
    const batch = pending.current;
    pending.current = new Map();

    setEntries((prev) =>
      prev.map((e) => {
        if (e.type !== "command") return e;
        const add = batch.get(e.id);
        if (!add) return e;
        let lines = e.lines.slice();
        for (const next of add) {
          if (next.replace) lines = [];
          const stage = progressStage(next.text);
          const last = lines[lines.length - 1];
          // Carriage-return progress is delivered as a sequence of snapshots.
          // Keep the latest snapshot for the active stage instead of growing
          // the transcript by one row for every percentage update.
          if (stage && last && last.kind === next.kind && progressStage(last.text) === stage) {
            lines[lines.length - 1] = next;
          } else {
            lines.push(next);
          }
        }
        let dropped = e.dropped;
        if (lines.length > MAX_LINES) {
          dropped += lines.length - MAX_LINES;
          lines = lines.slice(-MAX_LINES);
        }
        return { ...e, lines, dropped };
      }),
    );
  }, []);

  const queue = useCallback(
    (id: string, kind: LineKind, text: string, replace = false) => {
      const list = pending.current.get(id);
      const line: OutLine = { kind, text, replace };
      if (list) list.push(line);
      else pending.current.set(id, [line]);
      if (timer.current === null) {
        timer.current = window.setTimeout(flush, FLUSH_MS);
      }
    },
    [flush],
  );

  const patchCommand = useCallback((id: string, patch: Partial<CommandEntry>) => {
    setEntries((prev) =>
      prev.map((e) => (e.type === "command" && e.id === id ? { ...e, ...patch } : e)),
    );
  }, []);

  // ── notices ──────────────────────────────────────────────────────
  const notice = useCallback((tone: NoticeTone, lines: string[], echo?: string) => {
    setEntries((prev) => [
      ...prev,
      { type: "notice", id: `n${++seq.current}`, tone, lines, echo },
    ]);
  }, []);

  // ── backend events ───────────────────────────────────────────────
  useEffect(() => {
    let disposed = false;
    const unsubs: UnlistenFn[] = [];

    const on = async <T,>(name: string, cb: (payload: T) => void) => {
      const un = await listen<T>(name, (e) => cb(e.payload));
      if (disposed) un();
      else unsubs.push(un);
    };

    void on<OutputPayload>("psoperator://output", (p) => {
      if (p.tabId !== tabId || !p.id) return;
      if (p.kind === "out") {
        let capture = screenCaptures.current.get(p.id);
        if (!capture) {
          capture = { enabled: false, pending: "", frame: "" };
          screenCaptures.current.set(p.id, capture);
        }
        const frames = screenFrames(capture, p.text);
        if (frames) {
          for (const frame of frames) queue(p.id, p.kind, frame, true);
          return;
        }
      }
      const text = cleanLine(p.text);
      const info = progressInfo(text);
      if (info) setProgress(info);
      queue(p.id, p.kind, text);
    });

    void on<DonePayload>("psoperator://done", (p) => {
      if (p.tabId !== tabId) return;
      flush();
      patchCommand(p.id, {
        status: p.interrupted ? "interrupted" : p.ok ? "ok" : "error",
        code: p.code,
        endedAt: Date.now(),
      });
      screenCaptures.current.delete(p.id);
      setRunningId((cur) => (cur === p.id ? null : cur));
      setProgress(null);
      if (!p.interrupted) {
        setSession((s) => ({ ...s, cwd: p.cwd || s.cwd, virtualEnv: p.virtualEnv }));
      }
      const callback = onFinished.current.get(p.id);
      if (callback) {
        onFinished.current.delete(p.id);
        callback();
      }
    });

    void on<ReadyPayload>("psoperator://ready", (p) => {
      if (p.tabId !== tabId) return;
      setSession({ shell: p.shell, version: p.version, cwd: p.cwd, virtualEnv: p.virtualEnv });
    });

    void on<ExitPayload>("psoperator://exit", (p) => {
      if (p.tabId !== tabId) return;
      flush();
      if (p.id) {
        patchCommand(p.id, { status: "interrupted", code: -1, endedAt: Date.now() });
        const callback = onFinished.current.get(p.id);
        if (callback) {
          onFinished.current.delete(p.id);
          callback();
        }
      }
      setRunningId(null);
      setProgress(null);
      notice("error", [
        "The PowerShell process exited.",
        "Run another command or type /restart to start a new session.",
      ]);
    });

    api
      .startShell(tabId, initialCwd)
      .then((info) => setSession((s) => ({ ...s, ...info, virtualEnv: info.virtualEnv ?? s.virtualEnv })))
      .catch((e) => notice("error", [errText(e)]));

    return () => {
      disposed = true;
      unsubs.forEach((u) => u());
    };
    // initialCwd only matters for the very first start of this tab.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId, queue, flush, patchCommand, notice]);

  // ── actions ──────────────────────────────────────────────────────
  const run = useCallback(
    async (command: string, afterFinish?: () => void, displayCommand = command) => {
      const id = nextId("c");
      if (afterFinish) onFinished.current.set(id, afterFinish);
      setEntries((prev) => [
        ...prev,
        {
          type: "command",
          id,
          command: displayCommand,
          lines: [],
          dropped: 0,
          status: "running",
          code: 0,
          startedAt: Date.now(),
          expanded: false,
          outputExpanded: true,
          pinned: false,
        },
      ]);
      setRunningId(id);
      setProgress(null);
      try {
        await api.runCommand(tabId, id, command);
      } catch (e) {
        onFinished.current.delete(id);
        setRunningId(null);
        setProgress(null);
        patchCommand(id, {
          status: "error",
          code: 1,
          endedAt: Date.now(),
          lines: [{ kind: "err", text: errText(e) }],
        });
        afterFinish?.();
      }
    },
    [tabId, patchCommand],
  );

  const sendInput = useCallback(
    async (text: string) => {
      if (!runningId) return;
      queue(runningId, "in", `${text}\n`);
      try {
        await api.sendInput(tabId, text);
      } catch (e) {
        queue(runningId, "err", errText(e));
      }
    },
    [tabId, queue, runningId],
  );

  const interrupt = useCallback(async () => {
    try {
      await api.cancelCommand(tabId);
    } catch (e) {
      notice("error", [errText(e)]);
    }
  }, [tabId, notice]);

  const restart = useCallback(async () => {
    try {
      await api.restartShell(tabId);
      notice("dim", ["Session restarted."]);
    } catch (e) {
      notice("error", [errText(e)]);
    }
  }, [tabId, notice]);

  const clear = useCallback(() => {
    pending.current = new Map();
    setEntries([]);
  }, []);

  const appendEntries = useCallback((extra: Entry[]) => {
    if (extra.length) setEntries((prev) => [...prev, ...extra]);
  }, []);

  const toggleExpand = useCallback((id: string) => {
    setEntries((prev) =>
      prev.map((e) => (e.type === "command" && e.id === id ? { ...e, expanded: !e.expanded } : e)),
    );
  }, []);

  const toggleOutput = useCallback((id: string) => {
    setEntries((prev) => prev.map((e) => (
      e.type === "command" && e.id === id ? { ...e, outputExpanded: !e.outputExpanded } : e
    )));
  }, []);

  const togglePin = useCallback((id: string) => {
    setEntries((prev) => prev.map((e) => (
      e.type === "command" && e.id === id ? { ...e, pinned: !e.pinned } : e
    )));
  }, []);

  /** Expand/collapse the most recent command that has more output than fits. */
  const toggleLatestOutput = useCallback(() => {
    setEntries((prev) => {
      for (let i = prev.length - 1; i >= 0; i--) {
        const e = prev[i];
        if (e.type === "command" && e.lines.length > 12) {
          const next = prev.slice();
          next[i] = { ...e, expanded: !e.expanded };
          return next;
        }
      }
      return prev;
    });
  }, []);

  const runningSince =
    runningId === null
      ? null
      : (entries.find((e): e is CommandEntry => e.type === "command" && e.id === runningId)
        ?.startedAt ?? Date.now());

  return {
    entries,
    session,
    runningId,
    progress,
    runningSince,
    run,
    sendInput,
    interrupt,
    restart,
    clear,
    appendEntries,
    notice,
    toggleExpand,
    toggleOutput,
    togglePin,
    toggleLatestOutput,
  };
}
