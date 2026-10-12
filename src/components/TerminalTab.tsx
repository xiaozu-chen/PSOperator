import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useShell } from "../hooks/useShell";
import { Welcome } from "./Welcome";
import { DirectoryGraph } from "./DirectoryGraph";
import { CommandBlock, NoticeBlock, SplitArchiveBlock } from "./Entries";
import { Prompt } from "./Prompt";
import { loadHistory } from "../lib/history";
import { SLASH_COMMANDS } from "../types";
import { formatDuration, findLocalUrl } from "../lib/format";
import { isAdminMode, launchAdmin, openLocalUrl } from "../lib/shell";
import { detectSplitLaunch, type SplitLaunchInfo } from "../lib/splitDetection";
import type { CommandEntry, Entry, SplitArchiveEntry } from "../types";

function ServiceElapsed({ since }: { since: number }) {
    const [, tick] = useState(0);
    useEffect(() => {
        const timer = window.setInterval(() => tick((value) => value + 1), 500);
        return () => window.clearInterval(timer);
    }, []);
    return <>{formatDuration(Date.now() - since)}</>;
}

function ServicePanel({
    services,
    onStop,
    onOpenUrl,
}: {
    services: CommandEntry[];
    onStop: (id: string) => void;
    onOpenUrl: (url: string) => void;
}) {
    if (services.length === 0) return null;
    return (
        <section className="service-panel" aria-label="Pinned services">
            <div className="service-panel-title">Pinned services <span>{services.length}</span></div>
            {services.map((service) => {
                const url = findLocalUrl(service.lines);
                return (
                    <div className="service-row" key={service.id}>
                        <span className="service-live" />
                        <code className="service-command" title={service.command}>{service.command}</code>
                        {url && <span className="service-url" title={url}>{url}</span>}
                        <span className="service-elapsed"><ServiceElapsed since={service.startedAt} /></span>
                        {url && <button onClick={() => onOpenUrl(url)}>Open</button>}
                        <button className="command-stop" onClick={() => onStop(service.id)}>Stop</button>
                    </div>
                );
            })}
        </section>
    );
}

interface Props {
    tabId: string;
    active: boolean;
    initialCwd?: string;
    initialVirtualEnv?: string | null;
    initialCommand?: string;
    onMeta: (tabId: string, cwd: string, virtualEnv: string | null, busy: boolean) => void;
    onNewTab: () => void;
    onCloseTab: () => void;
    onOpenSettings: () => void;
    onOpenMinigames: () => void;
    onRunInSplit: (tabId: string, command: string, info: SplitLaunchInfo) => void;
    splitMode?: "manual" | "automatic";
    onProgramExit?: () => void;
    onEntriesSnapshot?: (tabId: string, entries: Entry[]) => void;
    onRegisterArchiveSink?: (tabId: string, sink: ((entry: SplitArchiveEntry) => void) | null) => void;
    canAutoSplit?: boolean;
    inputDisabled?: boolean;
    inputDisabledReason?: string;
}

export function TerminalTab({
    tabId,
    active,
    initialCwd,
    initialVirtualEnv,
    initialCommand,
    onMeta,
    onNewTab,
    onCloseTab,
    onOpenSettings,
    onOpenMinigames,
    onRunInSplit,
    splitMode = "manual",
    onProgramExit,
    onEntriesSnapshot,
    onRegisterArchiveSink,
    canAutoSplit = true,
    inputDisabled = false,
    inputDisabledReason,
}: Props) {
    const shell = useShell(tabId, initialCwd);
    const { entries, session, runningSince, runningId } = shell;
    const [followOutput, setFollowOutput] = useState(true);
    const [directoryGraphOpen, setDirectoryGraphOpen] = useState(false);
    const [pendingProcess, setPendingProcess] = useState<{ command: string; info: SplitLaunchInfo } | null>(null);

    useEffect(() => {
        if (!canAutoSplit) onEntriesSnapshot?.(tabId, entries);
    }, [canAutoSplit, entries, onEntriesSnapshot, tabId]);

    useEffect(() => {
        if (!canAutoSplit || !onRegisterArchiveSink) return;
        const sink = (entry: SplitArchiveEntry) => shell.appendEntries([entry]);
        onRegisterArchiveSink(tabId, sink);
        return () => onRegisterArchiveSink(tabId, null);
    }, [canAutoSplit, onRegisterArchiveSink, shell.appendEntries, tabId]);

    const scrollRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLTextAreaElement>(null);
    const interruptRef = useRef(shell.interrupt);
    const runningRef = useRef(runningId !== null);
    const stick = useRef(true);
    const initialCommandStarted = useRef(false);

    interruptRef.current = shell.interrupt;
    runningRef.current = runningId !== null;

    // Interrupt shortcuts must still work when an auto-split program has a
    // disabled prompt and focus is elsewhere in the pane.
    useEffect(() => {
        if (!active) return;
        const handleGlobalInterrupt = (event: KeyboardEvent) => {
            const isEscape = event.key === "Escape";
            const isCtrlC = event.ctrlKey && event.key.toLowerCase() === "c";
            if (!runningRef.current || (!isEscape && !isCtrlC)) return;
            if (isCtrlC && window.getSelection()?.toString()) return;
            event.preventDefault();
            event.stopPropagation();
            void interruptRef.current();
        };
        window.addEventListener("keydown", handleGlobalInterrupt, true);
        return () => window.removeEventListener("keydown", handleGlobalInterrupt, true);
    }, [active]);

    // Report folder + busy state upward so the tab strip can label this tab.
    useEffect(() => {
        onMeta(tabId, session.cwd, session.virtualEnv ?? null, runningId !== null);
    }, [onMeta, tabId, session.cwd, session.virtualEnv, runningId]);

    // Keep the view pinned to the newest output unless the user scrolled up.
    useEffect(() => {
        const el = scrollRef.current;
        if (el && stick.current && followOutput) el.scrollTop = el.scrollHeight;
    }, [entries, runningId, active, followOutput]);

    // Switching to this tab: focus the prompt.
    useEffect(() => {
        if (active) inputRef.current?.focus();
    }, [active]);

    useEffect(() => {
        if (!inputDisabled && active) inputRef.current?.focus();
    }, [inputDisabled, active]);

    useEffect(() => {
        if (!initialCommand || !session.cwd || initialCommandStarted.current) return;
        initialCommandStarted.current = true;
        const virtualEnvSetup = initialVirtualEnv
            ? `$env:VIRTUAL_ENV = '${initialVirtualEnv.replace(/'/g, "''")}'; $env:PATH = (Join-Path $env:VIRTUAL_ENV 'Scripts') + ';' + $env:PATH; `
            : "";
        const command = `$env:PYTHONUNBUFFERED = '1'; $env:PYTHONIOENCODING = 'utf-8'; $env:FORCE_COLOR = '1'; ${virtualEnvSetup}${initialCommand}`;
        void shell.run(command, onProgramExit, initialCommand);
    }, [initialCommand, initialVirtualEnv, session.cwd, shell.run, onProgramExit]);

    const onScroll = () => {
        const el = scrollRef.current;
        if (!el || !active) return;
        const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        stick.current = atBottom;
        setFollowOutput(atBottom);
    };

    const toggleFollowOutput = () => {
        setFollowOutput((following) => {
            const next = !following;
            stick.current = next;
            if (next) requestAnimationFrame(() => {
                const el = scrollRef.current;
                if (el) el.scrollTop = el.scrollHeight;
            });
            return next;
        });
    };

    const onOpenUrl = (url: string) => {
        void openLocalUrl(url).catch((error) => shell.notice("error", [String(error)]));
    };

    const pinnedServices = entries.filter((entry): entry is CommandEntry => (
        entry.type === "command" && entry.pinned && entry.status === "running"
    ));
    const terminalEmpty = entries.length === 0;

    // Clicking the transcript focuses the prompt, but never steals a text selection.
    const focusPrompt = () => {
        if (window.getSelection()?.isCollapsed) inputRef.current?.focus();
    };

    const handleSlash = useCallback(
        async (raw: string) => {
            const name = raw.trim().split(/\s+/)[0].toLowerCase();
            switch (name) {
                case "/help":
                    shell.notice(
                        "info",
                        [
                            "PSOperator runs a persistent PowerShell session in every tab. Variables,",
                            "functions and your working directory carry over between commands.",
                            "",
                            ...SLASH_COMMANDS.map((c) => `${c.name.padEnd(10)} ${c.desc}`),
                            "",
                            "Tab completes commands, parameters, variables and paths.",
                            "Interactive programs and development servers open in a separate CLI pane.",
                            "Press ? on an empty prompt for keyboard shortcuts.",
                            "Interrupting a command restarts the session in the same directory.",
                        ],
                        raw,
                    );
                    break;
                case "/clear":
                    shell.clear();
                    break;
                case "/status":
                    shell.notice(
                        "info",
                        [
                            `Shell:    ${session.shell} ${session.version}`.trimEnd(),
                            `Folder:   ${session.cwd}`,
                            `Python:   ${session.virtualEnv || "no active venv"}`,
                            `State:    ${runningId ? "running a command" : "idle"}`,
                        ],
                        raw,
                    );
                    break;
                case "/modules":
                    await shell.run(
                        "$loaded = @(Get-Module | ForEach-Object { \"$($_.Name)|$($_.Version)\" }); Get-Module -ListAvailable | Sort-Object Name, Version -Unique | ForEach-Object { [pscustomobject]@{ State = if ($loaded -contains \"$($_.Name)|$($_.Version)\") { 'ACTIVE' } else { 'INSTALLED' }; Name = $_.Name; Version = $_.Version.ToString(); Path = $_.ModuleBase } } | Format-Table -AutoSize",
                        undefined,
                        raw,
                    );
                    break;
                case "/history": {
                    const recent = loadHistory().slice(-20);
                    shell.notice(
                        "info",
                        recent.length
                            ? recent.map((c, i) => `${String(i + 1).padStart(2)}  ${c.split("\n")[0]}`)
                            : ["No history yet."],
                        raw,
                    );
                    break;
                }
                case "/new":
                    onNewTab();
                    break;
                case "/close":
                    onCloseTab();
                    break;
                case "/settings":
                    onOpenSettings();
                    break;
                case "/admin":
                    if (await isAdminMode()) {
                        shell.notice("info", ["This window is already running as administrator."], raw);
                    } else {
                        try {
                            await launchAdmin(tabId);
                            shell.notice("info", ["Windows opened an administrator window for this folder."], raw);
                        } catch (error) {
                            shell.notice("error", [`Could not open administrator mode: ${String(error)}`], raw);
                        }
                    }
                    break;
                case "/minigames":
                    onOpenMinigames();
                    break;
                case "/tree":
                    setDirectoryGraphOpen(true);
                    break;
                case "/restart":
                    await shell.restart();
                    break;
                case "/exit":
                    await getCurrentWindow().close();
                    break;
                default:
                    shell.notice(
                        "error",
                        [`Unknown command: ${name}`, "Type /help to see what's available."],
                        raw,
                    );
            }
        },
        [shell, session, runningId, onNewTab, onCloseTab, onOpenSettings, onOpenMinigames, tabId],
    );

    const handleSubmit = useCallback(
        (text: string) => {
            stick.current = true;
            if (runningId) void shell.sendInput(text);
            else if (text.startsWith("/")) void handleSlash(text);
            else {
                const splitInfo = canAutoSplit ? detectSplitLaunch(text) : null;
                if (splitInfo && splitMode === "automatic") onRunInSplit(tabId, text, splitInfo);
                else {
                    if (splitInfo) setPendingProcess({ command: text, info: splitInfo });
                    void shell.run(text);
                }
            }
        },
        [runningId, shell, handleSlash, canAutoSplit, onRunInSplit, tabId, splitMode],
    );

    return (
        <div className={`tab-pane${active ? " active" : ""}`}>
            <div className="transcript-frame">
                <div className={`transcript${terminalEmpty ? " transcript-empty" : ""}`} ref={scrollRef} onScroll={onScroll} onMouseUp={focusPrompt}>
                    <ServicePanel services={pinnedServices} onStop={() => shell.interrupt()} onOpenUrl={onOpenUrl} />
                    {/* <div className="transcript-toolbar"><span>Activity</span></div> */}
                    <nav className="transcript-rail" aria-label="Output navigation">
                        {entries.filter((entry) => entry.type === "command").map((entry, index) => (
                            <button
                                key={entry.id}
                                className={`rail-mark rail-${entry.status}`}
                                aria-label={`Go to command ${index + 1}: ${entry.command}`}
                                data-status={entry.status === "ok" ? "Done" : entry.status === "error" ? "Failed" : entry.status === "interrupted" ? "Interrupted" : "Running"}
                                data-command={entry.command}
                                title={entry.command}
                                onClick={() => document.getElementById(`entry-${entry.id}`)?.scrollIntoView({ behavior: "smooth", block: "center" })}
                            />
                        ))}
                    </nav>
                    {terminalEmpty && <Welcome session={session} />}
                    {entries.map((e) =>
                        e.type === "command" ? (
                            <CommandBlock
                                key={e.id}
                                entry={e}
                                onToggle={shell.toggleExpand}
                            />
                        ) : e.type === "splitArchive" ? (
                            <SplitArchiveBlock key={e.id} entry={e} onToggle={shell.toggleExpand} />
                        ) : (
                            <NoticeBlock key={e.id} entry={e} />
                        ),
                    )}
                </div>
            </div>

            <Prompt
                tabId={tabId}
                disabled={inputDisabled}
                disabledReason={inputDisabledReason}
                inputRef={inputRef}
                runningSince={runningSince}
                progress={shell.progress}
                shellLabel={session.version ? `${session.shell} ${session.version}` : session.shell}
                cwd={session.cwd}
                onSubmit={handleSubmit}
                onInterrupt={() => void shell.interrupt()}
                onClear={shell.clear}
                onToggleOutput={shell.toggleLatestOutput}
                followingOutput={followOutput}
                onToggleFollowOutput={toggleFollowOutput}
                processPaneAction={pendingProcess && canAutoSplit && splitMode === "manual" ? {
                    command: pendingProcess.command,
                    onClick: () => {
                        void shell.interrupt();
                        onRunInSplit(tabId, pendingProcess.command, pendingProcess.info);
                        setPendingProcess(null);
                    },
                } : undefined}
            />
            {directoryGraphOpen && <DirectoryGraph initialPath={session.cwd} onClose={() => setDirectoryGraphOpen(false)} />}
        </div>
    );
}
