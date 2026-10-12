export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s % 60)}s`;
}

/** Keep the tail of a long path: C:\Users\me\...\project -> …\me\project */
export function shortenPath(p: string, max = 46): string {
  if (p.length <= max) return p;
  return "…" + p.slice(p.length - (max - 1));
}

/** Find a local web app URL in process output, ignoring common closing punctuation. */
export function findLocalUrl(lines: { text: string }[]): string | null {
  const pattern = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?(?:[/?#][^\s"'<>]*)?/i;
  for (const line of lines) {
    const match = pattern.exec(line.text);
    if (match) return match[0].replace(/[),.;]+$/, "");
  }
  return null;
}

// eslint-disable-next-line no-control-regex
const CSI = /\x1b\[([0-9;?]*)([ -/]*)([@-~])/g;
// eslint-disable-next-line no-control-regex
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

/** Strip escape sequences and emulate carriage-return overwrites (progress output). */
export function cleanLine(text: string): string {
  // Keep SGR (color/style) sequences for the transcript renderer. Cursor and
  // other terminal-control CSI sequences are ignored by this line-based UI.
  let t = text.replace(OSC, "").replace(CSI, (sequence, _params: string, intermediate: string, final: string) =>
    final === "m" && intermediate === "" ? sequence : "",
  );
  // Raw stdout chunks can contain ordinary Windows CRLF line endings. Keep
  // those newlines; only a bare CR represents an in-place progress update.
  t = t.replace(/\r\n/g, "\n");
  if (t.includes("\r")) {
    t = t.split("\r").filter(Boolean).pop() ?? "";
  }
  return t;
}

export function commonPrefix(items: string[]): string {
  if (items.length === 0) return "";
  let prefix = items[0];
  for (const item of items.slice(1)) {
    let i = 0;
    while (
      i < prefix.length &&
      i < item.length &&
      prefix[i].toLowerCase() === item[i].toLowerCase()
    ) {
      i++;
    }
    prefix = prefix.slice(0, i);
    if (!prefix) break;
  }
  return prefix;
}

/** Find the whitespace-delimited token that ends at the end of `before`, honouring quotes. */
export function lastToken(before: string): { start: number; token: string; quoted: boolean } {
  let inQuote = false;
  let start = 0;
  for (let i = 0; i < before.length; i++) {
    const c = before[i];
    if (c === '"') inQuote = !inQuote;
    else if (!inQuote && /\s/.test(c)) start = i + 1;
  }
  const raw = before.slice(start);
  const quoted = raw.startsWith('"');
  return { start, token: quoted ? raw.slice(1) : raw, quoted };
}
