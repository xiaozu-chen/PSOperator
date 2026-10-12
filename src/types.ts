export type LineKind = "out" | "err" | "in";

export interface OutLine {
  kind: LineKind;
  text: string;
  /** Replace prior command output when this line is a refreshed terminal frame. */
  replace?: boolean;
}

export type CommandStatus = "running" | "ok" | "error" | "interrupted";

export interface CommandEntry {
  type: "command";
  id: string;
  command: string;
  lines: OutLine[];
  /** Lines discarded from the head once the buffer cap was hit. */
  dropped: number;
  status: CommandStatus;
  code: number;
  startedAt: number;
  endedAt?: number;
  expanded: boolean;
  outputExpanded: boolean;
  pinned: boolean;
}

export type NoticeTone = "info" | "error" | "dim";

export interface NoticeEntry {
  type: "notice";
  id: string;
  /** Shown as a user message above the notice (e.g. the slash command typed). */
  echo?: string;
  tone: NoticeTone;
  lines: string[];
}

export interface SplitArchiveEntry {
  type: "splitArchive";
  id: string;
  command: string;
  entries: Array<CommandEntry | NoticeEntry>;
}

export type Entry = CommandEntry | NoticeEntry | SplitArchiveEntry;

export interface SessionInfo {
  shell: string;
  version: string;
  cwd: string;
  virtualEnv?: string | null;
  running?: boolean;
}

export interface Settings {
  loadProfile: boolean;
  splitMode: "manual" | "automatic";
  shell: "auto" | "pwsh" | "powershell";
  fontSize?: number;
  theme?: "dark" | "light" | "midnight" | "cyberpunk" | "matcha" | "nord";
  sfxVolume: number;
}

export interface CompletionItem {
  /** Text to insert (already quoted by PowerShell when needed). */
  t: string;
  /** Short label for the match list. */
  l: string;
  /** PowerShell completion result type, e.g. Command, ParameterName. */
  k: string;
}

export interface CompletionResult {
  /** Index where the replaced span starts. */
  s: number;
  /** Length of the replaced span. */
  n: number;
  m: CompletionItem[];
}

export interface SlashCommand {
  name: string;
  desc: string;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: "/help", desc: "Show shortcuts and available commands" },
  { name: "/clear", desc: "Clear the screen" },
  { name: "/status", desc: "Show shell, version and working directory" },
  { name: "/modules", desc: "List installed modules and show which are loaded" },
  { name: "/tree", desc: "Explore files and folders as a 3D network" },
  { name: "/history", desc: "Show your recent commands" },
  { name: "/new", desc: "Open a new tab in this folder" },
  { name: "/close", desc: "Close this tab" },
  { name: "/settings", desc: "Choose the shell and profile loading" },
  { name: "/admin", desc: "Open a separate administrator window" },
  { name: "/minigames", desc: "Open the minigames arcade" },
  { name: "/restart", desc: "Restart this tab's PowerShell session" },
  { name: "/exit", desc: "Close PSOperator" },
];
