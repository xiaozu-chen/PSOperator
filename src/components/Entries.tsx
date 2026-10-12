import { useId, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type FocusEvent as ReactFocusEvent, type ReactNode } from "react";
import type { CommandEntry, NoticeEntry, OutLine, SplitArchiveEntry } from "../types";
import { formatDuration } from "../lib/format";
import { parseOutputBlocks } from "../lib/table";
import { JsonOutput, LogsOutput, WeatherOutput } from "./StructuredOutput";
import { openLocalUrl } from "../lib/shell";

const COLLAPSED_LINES = 60;

function UserMessage({ text, status, tooltip }: { text: string; status?: CommandEntry["status"]; tooltip?: string }) {
  const tooltipId = useId();
  const tooltipRef = useRef<HTMLSpanElement>(null);
  const [tooltipPosition, setTooltipPosition] = useState({ left: 0, top: 0 });
  const [tooltipVisible, setTooltipVisible] = useState(false);

  const placeTooltip = (x: number, y: number) => {
    const tooltip = tooltipRef.current;
    const bounds = tooltip?.getBoundingClientRect();
    const width = bounds?.width ?? 210;
    const height = bounds?.height ?? 32;
    const gap = 14;
    let left = x + gap;
    let top = y + gap;
    if (left + width > window.innerWidth - 8) left = x - width - gap;
    if (top + height > window.innerHeight - 8) top = y - height - gap;
    left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
    top = Math.max(8, Math.min(top, window.innerHeight - height - 8));
    setTooltipPosition({ left, top });
  };

  const onPointerMove = (event: ReactMouseEvent<HTMLSpanElement>) => {
    placeTooltip(event.clientX, event.clientY);
  };

  const onFocus = (event: ReactFocusEvent<HTMLSpanElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    placeTooltip(bounds.right, bounds.top);
    setTooltipVisible(true);
  };

  return (
    <div className="user-msg">
      {status && tooltip && (
        <span
          className={`command-streak-wrap streak-wrap-${status}`}
          onMouseEnter={(event) => { onPointerMove(event); setTooltipVisible(true); }}
          onMouseMove={onPointerMove}
          onMouseLeave={() => setTooltipVisible(false)}
        >
          <span
            className={`command-streak streak-${status}`}
            role="img"
            tabIndex={0}
            aria-label={tooltip}
            aria-describedby={tooltipId}
            onFocus={onFocus}
            onMouseEnter={(event) => { onPointerMove(event); setTooltipVisible(true); }}
            onMouseMove={onPointerMove}
            onBlur={() => setTooltipVisible(false)}
          />
          <span
            ref={tooltipRef}
            className={`status-tooltip${tooltipVisible ? " status-tooltip-visible" : ""}`}
            id={tooltipId}
            role="tooltip"
            aria-hidden={!tooltipVisible}
            style={{ left: tooltipPosition.left, top: tooltipPosition.top }}
          >
            {tooltip}
          </span>
        </span>
      )}
      <span className="user-caret">&gt;</span>
      <pre>{text}</pre>
    </div>
  );
}

/** Merge consecutive lines of the same kind so the DOM stays small for big outputs. */
function Segments({ lines, codeLanguage }: { lines: OutLine[]; codeLanguage?: string }) {
  const segs: { kind: OutLine["kind"]; text: string }[] = [];
  for (const l of lines) {
    const text = l.kind === "in" ? `› ${l.text}` : l.text;
    const last = segs[segs.length - 1];
    if (last && last.kind === l.kind) last.text += text;
    else segs.push({ kind: l.kind, text });
  }
  return <>{segs.map((segment, i) => <Segment key={i} kind={segment.kind} text={segment.text} codeLanguage={segment.kind === "out" ? codeLanguage : undefined} />)}</>;
}

function Segment({ kind, text, codeLanguage }: { kind: OutLine["kind"]; text: string; codeLanguage?: string }) {
  if (kind === "in") return <pre className="seg seg-in">{text}</pre>;
  if (codeLanguage) return <CodeOutput language={codeLanguage} source={text} />;

  return <>
    {parseOutputBlocks(text).flatMap((block, index) => {
      if (block.type === "text") {
        const parts = block.text.split(/(```[^\n]*\n[\s\S]*?```)/g);
        return parts.map((part, partIndex) => {
          const code = part.match(/^```([^\n]*)\n([\s\S]*?)```$/);
          if (!code) return part ? <TextOutput key={`${index}-${partIndex}`} text={part} kind={kind} /> : null;
          const language = code[1].trim();
          const source = code[2].replace(/\n$/, "");
          return <CodeOutput key={`${index}-${partIndex}`} language={language} source={source} />;
        });
      }
      if (block.type === "logs") return <LogsOutput key={index} block={block} />;
      if (block.type === "json") return <JsonOutput key={index} block={block} />;
      if (block.type === "weather") return <WeatherOutput key={index} block={block} />;
      return (
        <div className="formatted-table" key={index}>
          <div className="table-scroll">
            <table>
              <thead><tr>{block.headers.map((header, column) => <th key={column}>{header}</th>)}</tr></thead>
              <tbody>{block.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>{block.headers.map((_, column) => <td key={column}>{row[column]}</td>)}</tr>
              ))}</tbody>
            </table>
          </div>
          <details className="table-raw">
            <summary>Raw output</summary>
            <pre className="seg">{block.raw}</pre>
          </details>
        </div>
      );
    })}
  </>;
}

function commandCodeLanguage(command: string): string | undefined {
  if (!/^\s*(?:\s*&\s*)?(?:Get-Content|gc|cat)\b/i.test(command)) return undefined;
  const path = /(?:-Path\s+)?(?:'([^']+)'|"([^"]+)"|(\S+))/i.exec(command.replace(/^\s*(?:\s*&\s*)?(?:Get-Content|gc|cat)\b/i, ""));
  const file = path?.[1] ?? path?.[2] ?? path?.[3] ?? "";
  const extension = /\.([a-z0-9]+)$/i.exec(file)?.[1]?.toLowerCase();
  const languages: Record<string, string> = { py: "python", pyw: "python", js: "javascript", jsx: "jsx", ts: "typescript", tsx: "tsx", json: "json", html: "html", css: "css", rs: "rust", go: "go", java: "java", cs: "csharp", cpp: "cpp", c: "c", sh: "bash", ps1: "powershell", yaml: "yaml", yml: "yaml", toml: "toml", md: "markdown" };
  return extension ? languages[extension] : undefined;
}

function CodeOutput({ language, source }: { language: string; source: string }) {
  const [copyState, setCopyState] = useState("Copy");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(source);
      setCopyState("Copied");
    } catch {
      setCopyState("Copy unavailable");
    }
    window.setTimeout(() => setCopyState("Copy"), 1400);
  };
  return <section className="rendered-code" aria-label={`${language || "Code"} code block`}>
    <header><span>{language || "Code"}</span><button onClick={() => void copy()}>{copyState}</button></header>
    <pre><code>{highlightCode(source, language)}</code></pre>
  </section>;
}

function highlightCode(source: string, language: string): ReactNode[] {
  const keywords: Record<string, string> = {
    python: "and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield",
    javascript: "async await break case catch class const continue debugger default delete do else export extends finally for function if import in instanceof let new return static super switch this throw try typeof var void while yield",
    typescript: "abstract any as async await boolean break case catch class const continue declare default delete do else enum export extends finally for from function if implements import in infer instanceof interface is keyof let namespace never new number object package private protected public readonly require return static string super switch this throw type typeof undefined unique unknown var void while yield",
    powershell: "begin break catch class continue data do dynamicparam else elseif end enum exit filter finally for foreach from function if in param process return switch throw trap try until using var while",
  };
  const pattern = /(#[^\n]*|\/\/[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b(?:\d+(?:\.\d+)?)\b|\b[A-Za-z_$][\w$]*\b)/g;
  const reserved = new Set((keywords[language] ?? "").split(" "));
  const parts: ReactNode[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source))) {
    if (match.index > last) parts.push(source.slice(last, match.index));
    const token = match[0];
    const kind = /^(#|\/\/)/.test(token) ? "comment" : /^("|'|`)/.test(token) ? "string" : /^\d/.test(token) ? "number" : reserved.has(token) ? "keyword" : "identifier";
    parts.push(<span key={`${match.index}-${kind}`} className={`code-${kind}`}>{token}</span>);
    last = pattern.lastIndex;
  }
  if (last < source.length) parts.push(source.slice(last));
  return parts;
}

const LOG_LEVEL = /^(\s*(?:(?:\[\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\]|\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?|\d{2}:\d{2}:\d{2}(?:\.\d+)?)\s+)?)(\[(TRACE|DEBUG|INFO|NOTICE|WARN(?:ING)?|ERROR|FATAL|CRITICAL|SUCCESS|OK)\s*\])(?=\s|$)(.*)$/i;

const ANSI_BASE = ["#000000", "#cd0000", "#00cd00", "#cdcd00", "#0000ee", "#cd00cd", "#00cdcd", "#e5e5e5"];
const ANSI_BRIGHT = ["#7f7f7f", "#ff0000", "#00ff00", "#ffff00", "#5c5cff", "#ff00ff", "#00ffff", "#ffffff"];

function color256(index: number): string {
  if (index < 8) return ANSI_BASE[index];
  if (index < 16) return ANSI_BRIGHT[index - 8];
  if (index < 232) {
    const value = index - 16;
    const component = (part: number) => part === 0 ? 0 : 55 + part * 40;
    return `rgb(${component(Math.floor(value / 36))}, ${component(Math.floor(value / 6) % 6)}, ${component(value % 6)})`;
  }
  const gray = 8 + (index - 232) * 10;
  return `rgb(${gray}, ${gray}, ${gray})`;
}

function applyAnsiCodes(current: CSSProperties, codes: number[]): CSSProperties {
  const style = { ...current };
  for (let i = 0; i < codes.length; i += 1) {
    const code = codes[i];
    if (code === 0) { Object.keys(style).forEach((key) => delete style[key as keyof CSSProperties]); }
    else if (code === 1) style.fontWeight = 700;
    else if (code === 2) style.opacity = 0.72;
    else if (code === 3) style.fontStyle = "italic";
    else if (code === 4) style.textDecorationLine = "underline";
    else if (code === 9) style.textDecorationLine = style.textDecorationLine ? `${style.textDecorationLine} line-through` : "line-through";
    else if (code === 22) { delete style.fontWeight; delete style.opacity; }
    else if (code === 23) delete style.fontStyle;
    else if (code === 24 || code === 29) delete style.textDecorationLine;
    else if (code === 39) delete style.color;
    else if (code === 49) delete style.backgroundColor;
    else if (code >= 30 && code <= 37) style.color = ANSI_BASE[code - 30];
    else if (code >= 90 && code <= 97) style.color = ANSI_BRIGHT[code - 90];
    else if (code >= 40 && code <= 47) style.backgroundColor = ANSI_BASE[code - 40];
    else if (code >= 100 && code <= 107) style.backgroundColor = ANSI_BRIGHT[code - 100];
    else if ((code === 38 || code === 48) && codes[i + 1] === 5 && codes[i + 2] !== undefined) {
      style[code === 38 ? "color" : "backgroundColor"] = color256(Math.max(0, Math.min(255, codes[i + 2])));
      i += 2;
    } else if ((code === 38 || code === 48) && codes[i + 1] === 2 && codes[i + 4] !== undefined) {
      style[code === 38 ? "color" : "backgroundColor"] = `rgb(${codes[i + 2]}, ${codes[i + 3]}, ${codes[i + 4]})`;
      i += 4;
    }
  }
  return style;
}

const URL_PATTERN = /https?:\/\/[^\s"'<>]+/gi;

function AnsiText({ text }: { text: string }) {
  const sequence = /\x1b\[([0-9;]*)m/g;
  const pieces: { text: string; style: CSSProperties }[] = [];
  let plainText = "";
  let style: CSSProperties = {};
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = sequence.exec(text))) {
    if (match.index > last) {
      const piece = text.slice(last, match.index);
      pieces.push({ text: piece, style });
      plainText += piece;
    }
    const codes = match[1] ? match[1].split(";").map((value) => Number(value) || 0) : [0];
    style = applyAnsiCodes(style, codes);
    last = sequence.lastIndex;
  }
  if (last < text.length) {
    const piece = text.slice(last);
    pieces.push({ text: piece, style });
    plainText += piece;
  }

  const links: { start: number; end: number; url: string }[] = [];
  URL_PATTERN.lastIndex = 0;
  while ((match = URL_PATTERN.exec(plainText))) {
    const trailing = match[0].match(/[),.;!?\]}]+$/)?.[0] ?? "";
    const url = match[0].slice(0, match[0].length - trailing.length);
    if (url) links.push({ start: match.index, end: match.index + url.length, url });
  }
  if (!links.length) return <>{pieces.map((piece, index) => <span key={index} style={piece.style}>{piece.text}</span>)}</>;

  let offset = 0;
  const rendered: ReactNode[] = [];
  for (const piece of pieces) {
    const pieceStart = offset;
    const pieceEnd = offset + piece.text.length;
    const boundaries = new Set<number>([pieceStart, pieceEnd]);
    for (const link of links) {
      if (link.start > pieceStart && link.start < pieceEnd) boundaries.add(link.start);
      if (link.end > pieceStart && link.end < pieceEnd) boundaries.add(link.end);
    }
    const points = [...boundaries].sort((a, b) => a - b);
    for (let i = 0; i < points.length - 1; i += 1) {
      const start = points[i];
      const end = points[i + 1];
      const value = piece.text.slice(start - pieceStart, end - pieceStart);
      const link = links.find((candidate) => start >= candidate.start && end <= candidate.end);
      const content = link ? (
        <a
          className="output-link"
          href={link.url}
          title={`Open ${link.url}`}
          onClick={(event) => {
            event.preventDefault();
            void openLocalUrl(link.url).catch(() => undefined);
          }}
        >{value}</a>
      ) : value;
      rendered.push(<span key={`${pieceStart}-${start}`} style={piece.style}>{content}</span>);
    }
    offset = pieceEnd;
  }
  return <>{rendered}</>;
}

function TextOutput({ text, kind }: { text: string; kind: "out" | "err" }) {
  const lines = text.split("\n");
  const richLayout = /[╭╮╰╯├┤┬┴┼─│┏┓┗┛┣┫┳┻╋━┃┌┐└┘]/u.test(text)
    || /^\s*\+[-=]{3,}\+/m.test(text)
    || /\x1b\[[0-9;]*m/.test(text);
  const output = (
    <pre className={`seg seg-${kind} log-output${richLayout ? " seg-rich" : ""}`}>
      {lines.map((line, index) => {
        const hasAnsi = /\x1b\[[0-9;]*m/.test(line);
        const match = hasAnsi ? null : LOG_LEVEL.exec(line);
        let levelClass = "";
        if (match) {
          const level = match[3].toLowerCase();
          levelClass = ["trace", "debug"].includes(level)
            ? "debug"
            : ["warn", "warning"].includes(level)
              ? "warn"
              : ["error", "fatal", "critical"].includes(level)
                ? "error"
                : ["success", "ok"].includes(level)
                  ? "success"
                  : level;
        }
        return (
          <span key={index} className={match && kind === "err" ? "log-line" : undefined}>
            {match ? <>{match[1]}<span className={`log-level log-level-${levelClass}`}>{match[2]}</span>{match[4]}</> : <AnsiText text={line} />}
            {index < lines.length - 1 ? "\n" : ""}
          </span>
        );
      })}
    </pre>
  );
  return richLayout ? <div className="rich-output-scroll">{output}</div> : output;
}

export function CommandBlock({
  entry,
  onToggle,
}: {
  entry: CommandEntry;
  onToggle: (id: string) => void;
}) {
  const { lines, status, expanded, dropped } = entry;
  const running = status === "running";
  const collapsible = lines.length > COLLAPSED_LINES;

  let shown = lines;
  let hidden = 0;
  let hiddenAbove = false;
  if (collapsible && !expanded) {
    hidden = lines.length - COLLAPSED_LINES;
    hiddenAbove = running; // while streaming show the tail, afterwards the head
    shown = hiddenAbove ? lines.slice(-COLLAPSED_LINES) : lines.slice(0, COLLAPSED_LINES);
  }

  const duration = entry.endedAt ? formatDuration(entry.endedAt - entry.startedAt) : null;
  const silentSuccess = status === "ok" && dropped === 0 && lines.every((line) => !line.text.trim());
  const elapsed = duration ?? formatDuration(Date.now() - entry.startedAt);
  const statusTooltip = status === "ok"
    ? `Done in ${elapsed}`
    : status === "error"
      ? `Failed${entry.code !== 0 ? ` with exit code ${entry.code}` : ""} in ${elapsed}`
      : status === "interrupted"
        ? `Interrupted after ${elapsed}`
        : "Command is running";
  const hasOutput = lines.length > 0 || dropped > 0;
  const hint = (
    <button className="more" onClick={() => onToggle(entry.id)}>
      … {hidden} more output line{hidden === 1 ? "" : "s"} <span className="dim">(ctrl+o to show all)</span>
    </button>
  );

  return (
    <div className={`entry${silentSuccess ? " entry-silent" : ""}`} id={`entry-${entry.id}`}>
      <div className="command-row">
        <UserMessage text={entry.command} status={status} tooltip={statusTooltip} />
      </div>

      {hasOutput && entry.outputExpanded && (
        <div className="output">
          <span className="elbow" aria-hidden="true" />
          <div className="output-body">
            {lines.length === 0 && dropped === 0 && <span className="dim">(No output)</span>}
            {dropped > 0 && (
              <div className="dim">… {dropped.toLocaleString()} earlier lines dropped</div>
            )}
            {hidden > 0 && hiddenAbove && hint}
            <Segments lines={shown} codeLanguage={commandCodeLanguage(entry.command)} />
            {hidden > 0 && !hiddenAbove && hint}
            {collapsible && expanded && (
              <button className="more" onClick={() => onToggle(entry.id)}>
                <span className="dim">(ctrl+o to collapse)</span>
              </button>
            )}
          </div>
        </div>
      )}
      {!hasOutput && !running && !silentSuccess && <div className="output"><span className="elbow" aria-hidden="true" /><span className="dim">(No output)</span></div>}
    </div>
  );
}

export function NoticeBlock({ entry }: { entry: NoticeEntry }) {
  return (
    <div className="entry">
      {entry.echo && <UserMessage text={entry.echo} />}
      <div className={`output notice notice-${entry.tone}`}>
        <span className="elbow" aria-hidden="true" />
        <div className="output-body">
          {entry.lines.map((l, i) => (
            <pre key={i} className="seg">
              <AnsiText text={l} />
            </pre>
          ))}
        </div>
      </div>
    </div>
  );
}

export function SplitArchiveBlock({ entry, onToggle }: { entry: SplitArchiveEntry; onToggle: (id: string) => void }) {
  return (
    <details className="split-archive">
      <summary>
        <span className="split-archive-label">Closed program pane</span>
        <code>{entry.command}</code>
        <span className="split-archive-count">{entry.entries.length} item{entry.entries.length === 1 ? "" : "s"} · hidden</span>
      </summary>
      <div className="split-archive-content">
        {entry.entries.map((item) => item.type === "command"
          ? <CommandBlock key={item.id} entry={item} onToggle={onToggle} />
          : <NoticeBlock key={item.id} entry={item} />)}
      </div>
    </details>
  );
}
