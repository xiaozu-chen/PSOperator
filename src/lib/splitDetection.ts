export interface SplitLaunchInfo {
  /** Whether this kind of launched program commonly reads from stdin. */
  acceptsInput: boolean;
}

/**
 * Identify common interactive programs and long-running app commands. This is
 * intentionally a small, extensible command-line heuristic: a command string
 * cannot reveal the stdin behavior of every arbitrary executable.
 */
export function detectSplitLaunch(command: string): SplitLaunchInfo | null {
  const value = command.trim();
  if (!value || value.startsWith("/")) return null;

  const executable = value.match(/^(?:&\s*)?(?:"([^"]+)"|'([^']+)'|(\S+))/)?.slice(1).find(Boolean);
  const name = (executable ?? "").split(/[\\/]/).pop()?.replace(/\.exe$/i, "").toLowerCase() ?? "";
  const args = value.slice(value.indexOf(executable ?? "") + (executable?.length ?? 0)).trim();
  const pythonScript = /(?:"[^"]+\.py"|'[^']+\.py'|(?:^|\s)\S+\.py(?:\s|$))/i.test(args);
  const jsScript = /(?:"[^"]+\.(?:[cm]?js|ts|tsx|jsx)"|'[^']+\.(?:[cm]?js|ts|tsx|jsx)'|(?:^|\s)\S+\.(?:[cm]?js|ts|tsx|jsx)(?:\s|$))/i.test(args);

  // REPLs and source scripts commonly accept stdin.
  if (name === "py" || /^python(?:3(?:\.\d+)?)?$/.test(name)) {
    if (/^(?:--version|-V|--help|-h|--list-paths)\b/i.test(args)) return null;
    return !args || pythonScript || /^-m\s+(?!pip\b)\S+/i.test(args) ? { acceptsInput: true } : null;
  }
  if (["node", "deno", "tsx", "ts-node"].includes(name)) {
    if (/^(?:--version|-v|--help|-h)\b/i.test(args)) return null;
    return !args || jsScript || /\b(?:run|repl)\b/i.test(args) ? { acceptsInput: true } : null;
  }
  if (name === "bun") {
    if (!args) return { acceptsInput: true };
    if (/^(?:--version|-v|--help|-h)\b/i.test(args)) return null;
    if (jsScript) return { acceptsInput: true };
    if (/\b(?:dev|start|serve|preview|watch|electron|tauri|storybook|docs)(?::[\w-]+)?\b/i.test(args)) {
      return { acceptsInput: false };
    }
    return null;
  }
  if (["ruby", "pwsh", "powershell"].includes(name)) {
    if (/^(?:--version|-v|--help|-h)\b/i.test(args)) return null;
    const isScript = name === "ruby"
      ? /(?:"[^"]+\.rb"|'[^']+\.rb'|(?:^|\s)\S+\.rb(?:\s|$))/i.test(args)
      : /(?:-File\s+|(?:"[^"]+\.ps1"|'[^']+\.ps1'|(?:^|\s)\S+\.ps1(?:\s|$)))/i.test(args);
    return isScript ? { acceptsInput: true } : null;
  }

  // App launchers and web development servers generally do not read stdin.
  if (/\b(?:tauri|electron)\b/i.test(value)) {
    return /\b(?:--version|--help|build)\b/i.test(value) ? null : { acceptsInput: false };
  }
  if (["npm", "pnpm", "yarn", "bun"].includes(name)) {
    if (/\b(?:dlx|exec)\b/i.test(args) && /\b(?:vite|next|astro|parcel|webpack|ng|flask|uvicorn|streamlit)\b/i.test(args)) {
      return /\b(?:--version|--help|build)\b/i.test(args) ? null : { acceptsInput: false };
    }
    return /\b(?:run|start|dev|serve|preview|watch)\b/i.test(args)
      && /\b(?:dev|start|serve|preview|watch|electron|tauri|storybook|docs)(?::[\w-]+)?\b/i.test(args)
      ? { acceptsInput: false }
      : null;
  }
  if (name === "npx") {
    return /\b(?:vite|next|astro|parcel|webpack|ng|flask|uvicorn|streamlit|tauri|electron)\b/i.test(args)
      && !/\b(?:--version|--help|build|create)\b/i.test(args)
      ? { acceptsInput: false }
      : null;
  }
  if (["cargo", "dotnet", "go", "uv"].includes(name)) {
    if (name === "uv" && /^run\b/i.test(args) && pythonScript) return { acceptsInput: true };
    return /\b(?:run|watch|serve)\b/i.test(args)
      && !/\b(?:--version|--help|build|test|check|fmt)\b/i.test(args)
      ? { acceptsInput: true }
      : null;
  }
  if (["vite", "next", "astro", "parcel", "webpack", "ng", "flask", "uvicorn", "streamlit", "llama-server"].includes(name)) {
    return /\b(?:--version|--help|build)\b/i.test(args) ? null : { acceptsInput: false };
  }

  return null;
}
