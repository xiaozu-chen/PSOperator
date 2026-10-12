import {
  useLayoutEffect,
  useRef,
  useState,
  useEffect,
  type ChangeEvent,
  type KeyboardEvent,
  type RefObject,
} from "react";
import { SLASH_COMMANDS } from "../types";
import { completePath } from "../lib/shell";
import { complete } from "../lib/completion";
import { commonPrefix, lastToken, shortenPath } from "../lib/format";
import { loadHistory, pushHistory } from "../lib/history";
import { Spinner } from "./Spinner";
import type { CommandProgress } from "../hooks/useShell";

interface Props {
  tabId: string;
  disabled?: boolean;
  disabledReason?: string;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  /** Start time of the running command, or null when idle. */
  runningSince: number | null;
  progress: CommandProgress | null;
  shellLabel: string;
  cwd: string;
  onSubmit: (text: string) => void;
  onInterrupt: () => void;
  onClear: () => void;
  onToggleOutput: () => void;
  followingOutput: boolean;
  onToggleFollowOutput: () => void;
  processPaneAction?: { command: string; onClick: () => void };
}

const SHORTCUTS: [string, string][] = [
  ["Enter", "run command"],
  ["Shift+Enter", "new line"],
  ["Tab", "complete commands, params, paths"],
  ["↑ / ↓", "command history"],
  ["Esc", "interrupt, or clear input"],
  ["Ctrl+C", "interrupt, or clear input"],
  ["Ctrl+L", "clear screen"],
  ["Ctrl+O", "expand / collapse output"],
  ["Ctrl+T / Ctrl+W", "new / close tab"],
  ["Ctrl+Tab", "next tab (Ctrl+1-9 jumps)"],
  ["Ctrl+,", "settings"],
  ["/", "slash commands"],
  ["?", "toggle this panel"],
];

export function Prompt({
  tabId,
  disabled = false,
  disabledReason,
  inputRef,
  runningSince,
  progress,
  shellLabel,
  cwd,
  onSubmit,
  onInterrupt,
  onClear,
  onToggleOutput,
  followingOutput,
  onToggleFollowOutput,
  processPaneAction,
}: Props) {
  const running = runningSince !== null;
  const [value, setValue] = useState("");
  const [completionItems, setCompletionItems] = useState<{ value: string; label: string; detail?: string }[]>([]);
  const [showKeys, setShowKeys] = useState(false);
  const [menuSel, setMenuSel] = useState(0);
  const [menuDismissed, setMenuDismissed] = useState(false);
  const [caretAtEnd, setCaretAtEnd] = useState(true);
  const completionMenuRef = useRef<HTMLUListElement>(null);

  const history = useRef<string[]>(loadHistory());
  const histIdx = useRef(history.current.length);
  const draft = useRef("");
  /** Set after a Tab with several matches; further Tabs cycle through them. */
  const cycle = useRef<{ before: string; after: string; matches: string[]; idx: number } | null>(null);

  // Auto-grow the textarea with its content.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [value, inputRef]);

  const menuItems =
    !running && !menuDismissed && value.startsWith("/") && !/\s/.test(value)
      ? SLASH_COMMANDS.filter((c) => c.name.startsWith(value.toLowerCase()))
      : [];
  const menuOpen = menuItems.length > 0;
  const canPredict = !running && !disabled && !menuOpen
    && value.length > 0 && !value.includes("\n") && !value.startsWith("/")
    && caretAtEnd;
  const prediction = canPredict
    ? [...history.current].reverse().find((command) =>
        command.length > value.length && command.toLocaleLowerCase().startsWith(value.toLocaleLowerCase()),
      )?.slice(value.length) ?? ""
    : "";

  useLayoutEffect(() => {
    const menu = completionMenuRef.current;
    const selected = menu?.children.item(menuSel) as HTMLElement | null;
    selected?.scrollIntoView({ block: "nearest" });
  }, [menuSel, completionItems.length]);

  const edit = (next: string) => {
    setValue(next);
    setCaretAtEnd(true);
    setCompletionItems([]);
    setMenuSel(0);
    setMenuDismissed(false);
    cycle.current = null;
    histIdx.current = history.current.length;
  };

  const submit = (text: string) => {
    if (!running && !text.trim()) return;
    if (!running && !text.startsWith("/")) {
      history.current = pushHistory(history.current, text);
    }
    histIdx.current = history.current.length;
    draft.current = "";
    cycle.current = null;
    setValue("");
    setCompletionItems([]);
    setShowKeys(false);
    onSubmit(text);
  };

  const recall = (index: number) => {
    const list = history.current;
    if (index < 0 || index > list.length) return;
    cycle.current = null;
    if (histIdx.current === list.length) draft.current = value;
    histIdx.current = index;
    const next = index === list.length ? draft.current : list[index];
    setValue(next);
    setCaretAtEnd(true);
  };

  const placeCaret = (el: HTMLTextAreaElement, pos: number) =>
    requestAnimationFrame(() => el.setSelectionRange(pos, pos));

  const acceptCompletion = (item: { value: string }) => {
    const el = inputRef.current;
    if (!el) return;
    const caret = el.selectionStart;
    const { start } = lastToken(value.slice(0, caret));
    const next = value.slice(0, start) + item.value + value.slice(caret);
    setValue(next);
    setCompletionItems([]);
    cycle.current = null;
    placeCaret(el, start + item.value.length);
  };

  useEffect(() => {
    if (running || !value.trim() || menuDismissed || value.startsWith("/") && !/\s/.test(value)) {
      setCompletionItems([]);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      const el = inputRef.current;
      if (!el) return;
      const caret = el.selectionStart;
      const result = await complete(tabId, value, caret, 1000);
      if (cancelled || inputRef.current?.value !== value) return;
      if (result?.m.length) {
        setCompletionItems(result.m.slice(0, 40).map((item) => ({ value: item.t, label: item.l, detail: item.k })));
        setMenuSel(0);
        return;
      }
      const { token } = lastToken(value.slice(0, caret));
      try {
        const paths = await completePath(tabId, token);
        if (cancelled || inputRef.current?.value !== value) return;
        setCompletionItems(paths.slice(0, 40).map((path) => ({ value: path, label: path.slice(path.lastIndexOf("\\", path.length - 2) + 1), detail: path })));
        setMenuSel(0);
      } catch {
        if (!cancelled) setCompletionItems([]);
      }
    }, 160);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [value, running, menuDismissed, tabId, inputRef]);

  /** Fallback when PowerShell can't answer: complete file and folder names natively. */
  const completeViaPath = async (el: HTMLTextAreaElement) => {
    const caret = el.selectionStart;
    const before = value.slice(0, caret);
    const after = value.slice(caret);
    const { start, token, quoted } = lastToken(before);

    let matches: string[] = [];
    try {
      matches = await completePath(tabId, token);
    } catch {
      return;
    }
    if (matches.length === 0) return;

    const single = matches.length === 1;
    const completed = single ? matches[0] : commonPrefix(matches);
    const needsQuote = quoted || /\s/.test(completed);
    const closing = needsQuote && single && !completed.endsWith("\\") ? '"' : "";
    const insert = (needsQuote ? '"' : "") + completed + closing;

    setValue(value.slice(0, start) + insert + after);
    setCompletionItems(matches.slice(0, 40).map((m) => ({ value: m, label: m.slice(m.lastIndexOf("\\", m.length - 2) + 1), detail: m })));
    setMenuSel(0);
    placeCaret(el, start + insert.length);
  };

  const completeToken = async () => {
    const el = inputRef.current;
    if (!el) return;

    if (completionItems.length) {
      acceptCompletion(completionItems[menuSel] ?? completionItems[0]);
      return;
    }

    if (!value.trim()) return;

    const result = await complete(tabId, value, el.selectionStart);
    // The user kept typing while we waited: drop the stale answer.
    if (inputRef.current?.value !== value) return;

    if (!result) {
      await completeViaPath(el);
      return;
    }
    if (result.m.length === 0) return;

    setCompletionItems(result.m.slice(0, 40).map((item) => ({ value: item.t, label: item.l, detail: item.k })));
    setMenuSel(0);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    const noSelection = el.selectionStart === el.selectionEnd;

    if (e.key === "ArrowRight" && prediction && noSelection && el.selectionStart === value.length) {
      e.preventDefault();
      const completed = value + prediction;
      edit(completed);
      placeCaret(el, completed.length);
      return;
    }

    if (completionItems.length && !menuOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMenuSel((s) => (s + 1) % completionItems.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMenuSel((s) => (s - 1 + completionItems.length) % completionItems.length);
        return;
      }
      //  || e.key === "Enter" && !e.shiftKey
      if (e.key === "Tab") {
        e.preventDefault();
        acceptCompletion(completionItems[menuSel] ?? completionItems[0]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        if (running) {
          onInterrupt();
          return;
        }
        setCompletionItems([]);
        setMenuDismissed(true);
        return;
      }
    }

    if (menuOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMenuSel((s) => (s + 1) % menuItems.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMenuSel((s) => (s - 1 + menuItems.length) % menuItems.length);
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        setValue(menuItems[menuSel].name);
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        submit(menuItems[menuSel].name);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        if (running) {
          onInterrupt();
          return;
        }
        setMenuDismissed(true);
        return;
      }
    }

    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit(value);
      return;
    }

    if (e.key === "Tab" && !running && !e.ctrlKey) {
      e.preventDefault();
      void completeToken();
      return;
    }

    if (e.key === "Escape") {
      e.preventDefault();
      if (showKeys) setShowKeys(false);
      else if (running) onInterrupt();
      else if (value) edit("");
      return;
    }

    if (e.ctrlKey && e.key.toLowerCase() === "c" && noSelection) {
      e.preventDefault();
      if (running) onInterrupt();
      else edit("");
      return;
    }
    if (e.ctrlKey && e.key.toLowerCase() === "l") {
      e.preventDefault();
      onClear();
      return;
    }
    if (e.ctrlKey && e.key.toLowerCase() === "o") {
      e.preventDefault();
      onToggleOutput();
      return;
    }

    if (e.key === "?" && value === "") {
      e.preventDefault();
      setShowKeys((s) => !s);
      return;
    }

    if (!running && !e.shiftKey && !e.altKey && noSelection) {
      const caret = el.selectionStart;
      if (e.key === "ArrowUp" && !value.slice(0, caret).includes("\n")) {
        e.preventDefault();
        recall(histIdx.current - 1);
      } else if (e.key === "ArrowDown" && !value.slice(caret).includes("\n")) {
        e.preventDefault();
        recall(histIdx.current + 1);
      }
    }
  };

  return (
    <footer className="dock">
      {runningSince !== null && <Spinner since={runningSince} />}

      {running && progress && (
        <div className="command-progress" role="status" aria-live="polite">
          <div className="command-progress-heading">
            <span>{progress.label}</span>
            {progress.percent !== null && <span>{progress.percent}%</span>}
          </div>
          <div
            className={`command-progress-track${progress.percent === null ? " indeterminate" : ""}`}
            role="progressbar"
            aria-label={progress.label}
            aria-valuemin={0}
            aria-valuemax={100}
            {...(progress.percent === null ? {} : { "aria-valuenow": progress.percent })}
          >
            {progress.percent !== null && <span style={{ width: `${progress.percent}%` }} />}
          </div>
        </div>
      )}

      {menuOpen ? (
        <ul className="slash-menu" role="listbox">
          {menuItems.map((c, i) => (
            <li key={c.name} role="option" aria-selected={i === menuSel} className={i === menuSel ? "selected" : ""}
              onMouseEnter={() => setMenuSel(i)} onMouseDown={(e) => { e.preventDefault(); submit(c.name); }}>
              <span className="slash-name">{c.name}</span><span className="slash-desc">{c.desc}</span>
            </li>
          ))}
        </ul>
      ) : completionItems.length > 0 ? (
        <ul ref={completionMenuRef} className="completion-menu" role="listbox" aria-label="Completions">
          {completionItems.map((item, i) => (
            <li key={`${item.value}-${i}`} role="option" aria-selected={i === menuSel} className={i === menuSel ? "selected" : ""}
              onMouseEnter={() => setMenuSel(i)} onMouseDown={(event) => { event.preventDefault(); acceptCompletion(item); }}>
              <span className="completion-label">{item.label}</span>
              {item.detail && item.detail !== item.label && <span className="completion-detail">{item.detail}</span>}
            </li>
          ))}
        </ul>
      ) : null}

      <div className={`prompt-box${running ? " busy" : ""}${disabled ? " disabled" : ""}`}>
        <span className="prompt-caret">{running ? "›" : ">"}</span>
        <div className="prompt-input-wrap">
          {prediction && <div className="prompt-inline-ghost" aria-hidden="true"><span>{value}</span><span className="prompt-inline-suffix">{prediction}</span></div>}
          <textarea
            ref={inputRef}
            rows={1}
            autoFocus
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            disabled={disabled}
            value={value}
            placeholder={disabled ? disabledReason ?? "Input unavailable" : running ? "Send input to the running command…" : "Run a PowerShell command"}
            onChange={(e: ChangeEvent<HTMLTextAreaElement>) => {
              edit(e.target.value);
              setCaretAtEnd(e.currentTarget.selectionStart === e.currentTarget.value.length);
            }}
            onSelect={(e) => setCaretAtEnd(e.currentTarget.selectionStart === e.currentTarget.value.length && e.currentTarget.selectionEnd === e.currentTarget.value.length)}
            onKeyDown={onKeyDown}
          />
        </div>
        {processPaneAction && <button type="button" className="process-pane-icon" aria-label="Move process to pane" title={`Move process to pane: ${processPaneAction.command}`} onMouseDown={(event) => event.preventDefault()} onClick={processPaneAction.onClick}>
          <SplitPaneIcon />
        </button>}
        <button disabled={disabled} className={`follow-output-icon${followingOutput ? " active" : ""}`} aria-label={followingOutput ? "Stop following output" : "Follow output"} aria-pressed={followingOutput} onMouseMove={(event) => {
          const tip = event.currentTarget;
          const { clientX: x, clientY: y } = event;
          const bubble = tip.parentElement?.querySelector<HTMLElement>(".follow-tooltip");
          if (!bubble) return;
          const box = tip.getBoundingClientRect();
          bubble.style.display = "block";
          const bubbleBox = bubble.getBoundingClientRect();
          const tooltipWidth = bubbleBox.width;
          const tooltipHeight = bubbleBox.height;
          const gap = 10;
          const placeLeft = x + box.width + gap + tooltipWidth > window.innerWidth - 6;
          const placeAbove = y + gap + tooltipHeight > window.innerHeight - 6;
          const left = placeLeft ? x - gap - tooltipWidth : x + box.width + gap;
          const top = placeAbove ? y - gap - tooltipHeight : y + gap;
          bubble.style.left = `${Math.max(6, Math.min(left, window.innerWidth - tooltipWidth - 6))}px`;
          bubble.style.top = `${Math.max(6, Math.min(top, window.innerHeight - tooltipHeight - 6))}px`;
        }} onMouseLeave={(event) => {
          const bubble = event.currentTarget.parentElement?.querySelector<HTMLElement>(".follow-tooltip");
          if (bubble) bubble.style.display = "none";
        }} onBlur={(event) => {
          const bubble = event.currentTarget.parentElement?.querySelector<HTMLElement>(".follow-tooltip");
          if (bubble) bubble.style.display = "none";
        }} onFocus={(event) => {
          const bubble = event.currentTarget.parentElement?.querySelector<HTMLElement>(".follow-tooltip");
          if (bubble) bubble.style.display = "block";
        }} onMouseDown={(event) => event.preventDefault()} onClick={onToggleFollowOutput}>
          <PromptIcon following={followingOutput} />
        </button>
        <span className="follow-tooltip" role="tooltip">{followingOutput ? "Following output" : "Follow output"}</span>
      </div>

      {showKeys && (
        <div className="shortcuts">
          {SHORTCUTS.map(([k, d]) => (
            <div key={k}>
              <span className="key">{k}</span> <span className="dim">{d}</span>
            </div>
          ))}
        </div>
      )}
      {!showKeys && <div className="statusline">
        <span className="dim">{disabled ? disabledReason ?? "input unavailable" : running ? "esc to interrupt" : prediction ? "→ accept suggestion" : "? for shortcuts"}</span>
        {disabled && running && <button className="stop-program-button" onClick={onInterrupt}>Stop program</button>}
        <span className="dim statusline-right">
          {shellLabel} · {shortenPath(cwd, 44)}
        </span>
      </div>}
    </footer>
  );
}

function PromptIcon({ following }: { following: boolean }) {
  return following
    ? <svg width="17" height="17" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 3v10h10" /><path d="m5 10 3-3 2 2 3-4" /></svg>
    : <svg width="17" height="17" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 3v10h10" /><path d="m5 10 3-3 2 2 3-4" /><path d="m3 3 10 10" /></svg>;
}

function SplitPaneIcon() {
  return <svg width="17" height="17" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="2" y="2" width="12" height="12" rx="1.5" />
    <path d="M8 2v12M4.5 5.5h1M10.5 10.5h1" />
  </svg>;
}
