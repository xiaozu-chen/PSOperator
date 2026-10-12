# PSOperator

A PowerShell wrapper for Windows with a Claude Code CLI look and feel.
Tauri v2 · Rust backend · React 19 + TypeScript frontend.

## Prerequisites (Windows)

- [Rust](https://rustup.rs) (MSVC toolchain) and the Visual Studio C++ Build Tools
- [Node.js](https://nodejs.org) 20+
- WebView2 runtime (usually included with Windows 10/11; the installer can download its bootstrapper if needed)

## Run

```powershell
npm install
npm run tauri -- dev
```

## Build an installer

```powershell
npm run tauri -- build
```

Run this from the project root after `npm install`. The `--` passes `build` to
the local Tauri CLI installed in `node_modules`; this avoids depending on a
globally installed `tauri` command. On Windows, the current configuration
builds both an NSIS setup executable and an MSI in
`src-tauri/target/release/bundle/`.

The Windows installers use Tauri's default WebView2 bootstrapper mode: machines
without the WebView2 runtime need an internet connection during installation.
Recent Windows 10 and Windows 11 installations generally already include it.

Before distributing a release, update the version in `src-tauri/tauri.conf.json`
(the Tauri app version is the source of truth), review the app identity and icon,
and sign the installers with your publisher's Windows code-signing certificate.
Unsigned installers can trigger Microsoft Defender SmartScreen warnings when
downloaded. Test installation, launch, upgrade, and uninstall on a clean Windows
account or machine before sharing the installers.

## How it works

The Rust side (`src-tauri/src/lib.rs`) keeps one long-lived PowerShell process per
tab (`pwsh.exe` if installed, otherwise `powershell.exe`) and sends it commands over
stdin. Each command is base64-encoded, dot-sourced in the global scope and followed
by a sentinel line, so variables, functions and `cd` persist, output streams back
in order, and PSOperator knows the exit code and working directory when it finishes.
The frontend subscribes to `psoperator://output`, `psoperator://done`,
`psoperator://ready`, `psoperator://exit` and `psoperator://completion` event channels; every
payload carries a `tabId`.

**Tab completion** is answered by PowerShell itself (`CommandCompletion.CompleteInput`),
so it covers cmdlets, aliases, functions, parameters, variables, modules and paths.
Tab extends to the shared prefix, lists the matches, and further Tabs cycle through
them. If PowerShell is busy or slow, PSOperator falls back to native path completion.

## Using it

| Key | Action |
| --- | --- |
| Enter / Shift+Enter | run / new line |
| Tab | complete commands, parameters, variables and paths (repeat to cycle) |
| Ctrl+T / Ctrl+W | new tab (starts in the current folder) / close tab |
| Ctrl+Tab, Ctrl+Shift+Tab, Ctrl+1-9 | switch tabs |
| Ctrl+, | settings |
| Up / Down | history (saved between sessions) |
| Esc, Ctrl+C | interrupt a running command, or clear the input |
| Ctrl+L | clear the screen |
| Ctrl+O | expand or collapse long output |
| `/` | slash commands: `/help /clear /status /history /new /close /settings /restart /exit` |
| `?` | shortcut panel (on an empty prompt) |

While a command runs, whatever you type is sent to it as stdin (for `Read-Host`,
`python`, and so on).

Interactive programs and common long-running app commands are automatically
launched in a second, independent PowerShell session beside the current one.
For example, `python norma.py`, `npm run tauri -- dev`, and
`npm run electron:dev` open in the secondary pane. Both panes use the same
terminal interface. While the program runs, the main prompt pauses. Stdin-capable
launches such as Python scripts can receive input in the program pane; dev-server
launches such as Tauri and Electron keep that input disabled. When the program
exits, the main prompt is restored and the completed program pane remains visible
with its input disabled. Close the pane to dismiss it. Drag the divider to resize.
Each session keeps its own working directory and PowerShell state. PSOperator uses
piped input and output rather than a PTY, so full-screen terminal applications
may not behave correctly in either pane.

## Known limitations

- Not a real terminal (no PTY). Full-screen TUIs such as `vim` or `htop` won't work.
- Interrupting restarts the session in the same directory, so variables defined
  earlier are lost.
- Sessions start with `-NoProfile` by default so prompts and themes (oh-my-posh, etc.)
  don't pollute output. Turn on "Load my PowerShell profile" in `/settings` (or
  Ctrl+,) to run `$PROFILE`; it applies to new tabs and after `/restart`. Settings are
  saved to `settings.json` in the app config directory
  (the existing `%APPDATA%\dev.psoperator.shell\` app-data folder).
- PSOperator requires Windows PowerShell 5.1, which is included with supported
  Windows versions. PowerShell 7 is optional; PSOperator prefers it when available
  with the shell set to Auto.
