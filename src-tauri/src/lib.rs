//! PSOperator backend.
//!
//! Every tab owns one long-lived PowerShell process (pwsh if installed, otherwise
//! Windows PowerShell) that is fed commands over stdin. Every command is wrapped so that:
//!
//!   * it runs in the *global* scope, so variables, functions, `cd`, etc. persist,
//!   * stdout and stderr are merged into one ordered stream (errors are tagged),
//!   * a sentinel line reports completion, success, exit code and working directory.
//!
//! Wire format (one record per stdout line, `\x1e` is the ASCII record separator):
//!
//!   `<text>`                          plain output
//!   `\x1eE <text>`                    error output
//!   `\x1eD <id> <ok> <code> <cwd>`    command finished
//!   `\x1eI <version> <edition> <cwd>` session is ready
//!   `\x1eC <req> <base64 json>`       tab-completion result

use std::{
    collections::HashMap,
    fs,
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStderr, ChildStdin, ChildStdout, Command, Stdio},
    sync::{Arc, Mutex},
    thread,
};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const MARK: char = '\u{1e}';

/// Executed once when a shell session starts. Every entry must be a single line.
const BOOTSTRAP: &[&str] = &[
    // UTF-8 everywhere, no progress bars.
    "try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); $OutputEncoding = [Console]::OutputEncoding } catch {}; try { if ($PSStyle) { $PSStyle.OutputRendering = 'Ansi' } } catch {}; $ProgressPreference = 'SilentlyContinue'; $global:__psoperator_bad = $false; $global:PSModuleAutoLoadingPreference = 'All'",
    // A GUI app can keep an old environment block after PATH is updated. Merge
    // the current User and Machine PATH values into the profile-adjusted path.
    "try { $paths = @($env:PATH, [Environment]::GetEnvironmentVariable('Path', 'User'), [Environment]::GetEnvironmentVariable('Path', 'Machine')); $env:PATH = ((($paths -join ';') -split ';' | Where-Object { $_ } | Select-Object -Unique) -join ';') } catch {}",
    // Format explicitly caught errors. Ordinary output and errors use PowerShell's
    // native stdout/stderr so flushed, non-newline output can stream to the UI.
    r#"function global:__psoperator_split { process { if ($_ -is [System.Management.Automation.ErrorRecord]) { if ($_.FullyQualifiedErrorId -like 'NativeCommandError*') { [Console]::Error.WriteLine($_.ToString()); [Console]::Error.Flush() } else { $global:__psoperator_bad = $true; $t = ($_ | Out-String).TrimEnd(); foreach ($l in ($t -split '\r\n|\r|\n')) { [Console]::Out.WriteLine([string][char]30 + 'E ' + $l); [Console]::Out.Flush() } } } else { $_ } } }"#,
    // Completion sentinel also reports this shell's active Python venv.
    r#"function global:__psoperator_done($id) { $c = $global:LASTEXITCODE; if ($null -eq $c) { $c = 0 }; $ok = if ($global:__psoperator_bad) { 0 } else { 1 }; $v = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$env:VIRTUAL_ENV)); [Console]::Out.WriteLine([string][char]30 + 'D ' + $id + ' ' + $ok + ' ' + $c + ' ' + (Get-Location).Path + '|' + $v) }"#,
    // Tab completion powered by PowerShell itself (commands, parameters, variables, paths...).
    r#"function global:__psoperator_complete($rid, $b64, $pos) { try { $in = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b64)); $r = [System.Management.Automation.CommandCompletion]::CompleteInput($in, [int]$pos, $null); $items = @($r.CompletionMatches | Select-Object -First 200 | ForEach-Object { @{ t = $_.CompletionText; l = $_.ListItemText; k = [string]$_.ResultType } }); $o = @{ s = $r.ReplacementIndex; n = $r.ReplacementLength; m = $items } | ConvertTo-Json -Depth 4 -Compress } catch { $o = '{"s":0,"n":0,"m":[]}' }; [Console]::Out.WriteLine([string][char]30 + 'C ' + $rid + ' ' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($o))) }"#,
    // Keep the host prompt silent in case PowerShell decides to print one.
    "function global:prompt { '' }",
];

/// Sent after optional venv restoration so the UI sees the shell's actual state.
const READY_LINE: &str = r#"$v = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$env:VIRTUAL_ENV)); [Console]::Out.WriteLine([string][char]30 + 'I ' + $PSVersionTable.PSVersion.ToString() + ' ' + $PSVersionTable.PSEdition + ' ' + (Get-Location).Path + '|' + $v)"#;

// ───────────────────────────── settings ─────────────────────────────

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", default)]
struct Settings {
    /// Load `$PROFILE` when a session starts.
    load_profile: bool,
    /// "manual" | "automatic" process pane behavior.
    split_mode: String,
    /// "auto" | "pwsh" | "powershell"
    shell: String,
    /// Terminal font size in CSS pixels.
    font_size: f64,
    /// "dark" | "light" | "midnight" | "cyberpunk" | "matcha" | "nord"
    theme: String,
    /// Sound effect volume from 0.0 (muted) to 1.0 (full volume).
    sfx_volume: f64,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            load_profile: true,
            split_mode: "manual".into(),
            shell: "auto".into(),
            font_size: 13.5,
            theme: "dark".into(),
            sfx_volume: 0.0,
        }
    }
}

fn settings_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|d| d.join("settings.json"))
}

fn load_settings(app: &AppHandle) -> Settings {
    settings_path(app)
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

// ───────────────────────────── state ─────────────────────────────

struct Shell {
    child: Child,
    stdin: ChildStdin,
}

struct Inner {
    shell: Option<Shell>,
    /// Id of the command currently executing, if any.
    running: Option<String>,
    cwd: PathBuf,
    virtual_env: Option<String>,
    shell_name: String,
    version: String,
    /// Bumped on every (re)spawn so output from dead sessions is ignored.
    generation: u64,
}

/// One tab's session.
#[derive(Clone)]
struct TabState {
    inner: Arc<Mutex<Inner>>,
    /// Serialises spawning / restarting so two callers never create two shells.
    spawn_lock: Arc<Mutex<()>>,
}

impl TabState {
    fn new(cwd: PathBuf) -> Self {
        Self {
            inner: Arc::new(Mutex::new(Inner {
                shell: None,
                running: None,
                cwd,
                virtual_env: None,
                shell_name: "PowerShell".into(),
                version: String::new(),
                generation: 0,
            })),
            spawn_lock: Arc::new(Mutex::new(())),
        }
    }
}

struct Registry {
    tabs: Mutex<HashMap<String, TabState>>,
    settings: Mutex<Settings>,
    home: PathBuf,
    startup_cwd: Mutex<Option<PathBuf>>,
}

impl Registry {
    fn new() -> Self {
        let home = std::env::var_os("USERPROFILE")
            .or_else(|| std::env::var_os("HOME"))
            .map(PathBuf::from)
            .filter(|p| p.is_dir())
            .or_else(|| std::env::current_dir().ok())
            .unwrap_or_default();

        let args: Vec<String> = std::env::args().collect();
        let startup_cwd = if process_is_elevated() {
            args.windows(2)
                .find(|pair| pair[0] == "--psoperator-admin-cwd")
                .and_then(|pair| STANDARD.decode(&pair[1]).ok())
                .and_then(|bytes| String::from_utf8(bytes).ok())
                .map(PathBuf::from)
                .filter(|path| path.is_dir())
        } else {
            None
        };

        Self {
            tabs: Mutex::new(HashMap::new()),
            settings: Mutex::new(Settings::default()),
            home,
            startup_cwd: Mutex::new(startup_cwd),
        }
    }

    fn get(&self, id: &str) -> Result<TabState, String> {
        self.tabs
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .ok_or_else(|| format!("Unknown tab: {id}"))
    }

    fn get_or_create(&self, id: &str, cwd: Option<String>) -> TabState {
        let mut tabs = self.tabs.lock().unwrap();
        tabs.entry(id.to_string())
            .or_insert_with(|| {
                let inherited = self.startup_cwd.lock().unwrap().take();
                let start = cwd
                    .map(PathBuf::from)
                    .filter(|p| p.is_dir())
                    .or(inherited)
                    .unwrap_or_else(|| self.home.clone());
                TabState::new(start)
            })
            .clone()
    }

    fn settings(&self) -> Settings {
        self.settings.lock().unwrap().clone()
    }
}

// ─────────────────────────── event payloads ───────────────────────────

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct OutputPayload {
    tab_id: String,
    id: Option<String>,
    /// "out" | "err"
    kind: &'static str,
    text: String,
    replace: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DonePayload {
    tab_id: String,
    id: String,
    ok: bool,
    code: i64,
    cwd: String,
    virtual_env: Option<String>,
    interrupted: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ReadyPayload {
    tab_id: String,
    shell: String,
    version: String,
    cwd: String,
    virtual_env: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ExitPayload {
    tab_id: String,
    id: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CompletionPayload {
    tab_id: String,
    req_id: String,
    result: serde_json::Value,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SessionInfo {
    shell: String,
    version: String,
    cwd: String,
    virtual_env: Option<String>,
    running: bool,
}

// ───────────────────────────── helpers ─────────────────────────────

fn shell_candidates(preference: &str) -> Vec<&'static str> {
    if cfg!(windows) {
        match preference {
            "pwsh" => vec!["pwsh.exe"],
            "powershell" => vec!["powershell.exe"],
            _ => vec!["pwsh.exe", "powershell.exe"],
        }
    } else {
        vec!["pwsh"]
    }
}

fn kill_tree(child: &mut Child) {
    #[cfg(windows)]
    {
        // `taskkill /T` takes the whole process tree down, not just powershell.exe.
        let pid = child.id().to_string();
        let _ = Command::new("taskkill")
            .args(["/PID", pid.as_str(), "/T", "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
    }
    let _ = child.kill();
    let _ = child.wait();
}

fn build_line(id: &str, command: &str) -> String {
    let b64 = STANDARD.encode(command.as_bytes());
    format!(
        "[Console]::Error.WriteLine([string][char]30 + 'B {id}'); [Console]::Error.Flush(); \
         $global:__psoperator_bad = $false; $global:__psoperator_error_count = $Error.Count; $global:LASTEXITCODE = 0; \
         $global:__psoperator_venv_before = $env:VIRTUAL_ENV; \
         try {{ . ([scriptblock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{b64}')))) }} \
         catch {{ $global:__psoperator_bad = $true; $_ | __psoperator_split }}; \
         if ($Error.Count -gt $global:__psoperator_error_count) {{ $global:__psoperator_bad = $true }}; \
         if ($env:VIRTUAL_ENV -and $env:VIRTUAL_ENV -ne $global:__psoperator_venv_before -and (Test-Path -LiteralPath (Join-Path $env:VIRTUAL_ENV 'Scripts/python.exe'))) {{ $global:__psoperator_bad = $false; $global:LASTEXITCODE = 0 }}; \
         [Console]::Error.WriteLine([string][char]30 + 'Z {id}'); [Console]::Error.Flush(); \
         __psoperator_done '{id}'\n"
    )
}

/// This shell captures streams through pipes rather than an interactive TTY.
/// Git suppresses transfer progress in that situation unless `--progress` is
/// supplied, so add it for common transfer commands while respecting quiet or
/// already-explicit progress flags.
fn ensure_git_progress(command: &str) -> String {
    let leading = command.len() - command.trim_start().len();
    let mut start = leading;
    let rest = &command[start..];
    if rest.starts_with("& ") || rest.starts_with("&\t") {
        start += 1;
        start += command[start..].len() - command[start..].trim_start().len();
    }

    let Some(executable_end_rel) = command[start..].find(char::is_whitespace) else {
        return command.to_string();
    };
    let executable_end = start + executable_end_rel;
    let executable = command[start..executable_end].trim_matches(['"', '\'']);
    let basename = executable.rsplit(['\\', '/']).next().unwrap_or(executable);
    if !matches!(basename.to_ascii_lowercase().as_str(), "git" | "git.exe") {
        return command.to_string();
    }

    let subcommand_start = executable_end + command[executable_end..].len()
        - command[executable_end..].trim_start().len();
    let Some(subcommand_end_rel) = command[subcommand_start..].find(char::is_whitespace) else {
        return command.to_string();
    };
    let subcommand_end = subcommand_start + subcommand_end_rel;
    let subcommand = command[subcommand_start..subcommand_end].to_ascii_lowercase();
    if !matches!(subcommand.as_str(), "clone" | "fetch" | "pull" | "push") {
        return command.to_string();
    }

    let args = &command[subcommand_end..];
    if args.split_whitespace().any(|arg| matches!(arg, "-q" | "--quiet" | "--progress")) {
        return command.to_string();
    }
    format!("{} --progress{}", &command[..subcommand_end], args)
}

fn session_info(inner: &Inner) -> SessionInfo {
    SessionInfo {
        shell: inner.shell_name.clone(),
        version: inner.version.clone(),
        cwd: inner.cwd.display().to_string(),
        virtual_env: inner.virtual_env.clone(),
        running: inner.running.is_some(),
    }
}

fn valid_req_id(id: &str) -> bool {
    !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn split_cwd_virtual_env(value: &str) -> (String, Option<String>) {
    let Some((cwd, encoded)) = value.rsplit_once('|') else {
        return (value.to_string(), None);
    };
    let virtual_env = STANDARD
        .decode(encoded)
        .ok()
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .filter(|path| !path.is_empty());
    (cwd.to_string(), virtual_env)
}

// ─────────────────────────── session lifecycle ───────────────────────────

fn spawn_shell(
    app: &AppHandle,
    tab_id: &str,
    inner: &Arc<Mutex<Inner>>,
    settings: &Settings,
) -> Result<(), String> {
    let (cwd, virtual_env, generation) = {
        let mut g = inner.lock().unwrap();
        g.generation += 1;
        (g.cwd.clone(), g.virtual_env.clone(), g.generation)
    };

    let mut args: Vec<&str> = vec!["-NoLogo"];
    if !settings.load_profile {
        args.push("-NoProfile");
    }
    args.extend([
        "-ExecutionPolicy",
        "Bypass",
        "-InputFormat",
        "Text",
        "-OutputFormat",
        "Text",
        "-Command",
        "-",
    ]);

    let mut last_err = String::from("no PowerShell executable found");

    for exe in shell_candidates(&settings.shell) {
        let mut cmd = Command::new(exe);
        cmd.args(&args)
            .current_dir(&cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);

        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                last_err = format!("{exe}: {e}");
                continue;
            }
        };

        let mut stdin = child.stdin.take().ok_or("failed to open shell stdin")?;
        let stdout = child.stdout.take().ok_or("failed to open shell stdout")?;
        let stderr = child.stderr.take().ok_or("failed to open shell stderr")?;

        {
            let (app, inner, tab_id) = (app.clone(), inner.clone(), tab_id.to_string());
            thread::spawn(move || read_stdout(app, tab_id, inner, stdout, generation));
        }
        {
            let (app, inner, tab_id) = (app.clone(), inner.clone(), tab_id.to_string());
            thread::spawn(move || read_stderr(app, tab_id, inner, stderr, generation));
        }

        for line in BOOTSTRAP {
            stdin
                .write_all(line.as_bytes())
                .and_then(|_| stdin.write_all(b"\n"))
                .map_err(|e| format!("failed to initialise shell: {e}"))?;
        }
        if let Some(virtual_env) = virtual_env {
            let encoded = STANDARD.encode(virtual_env.as_bytes());
            let restore = format!(
                "$p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{encoded}')); $a = Join-Path $p 'Scripts/Activate.ps1'; if (Test-Path -LiteralPath $a) {{ . $a }}\n"
            );
            stdin
                .write_all(restore.as_bytes())
                .map_err(|e| format!("failed to restore Python environment: {e}"))?;
        }
        stdin
            .write_all(READY_LINE.as_bytes())
            .and_then(|_| stdin.write_all(b"\n"))
            .map_err(|e| format!("failed to initialise session status: {e}"))?;
        stdin.flush().map_err(|e| e.to_string())?;

        inner.lock().unwrap().shell = Some(Shell { child, stdin });
        return Ok(());
    }

    Err(format!(
        "Could not start PowerShell ({last_err}). Check the shell setting in /settings."
    ))
}

fn ensure_shell(
    app: &AppHandle,
    tab_id: &str,
    tab: &TabState,
    settings: &Settings,
) -> Result<(), String> {
    let _guard = tab.spawn_lock.lock().unwrap();
    let alive = tab.inner.lock().unwrap().shell.is_some();
    if alive {
        return Ok(());
    }
    spawn_shell(app, tab_id, &tab.inner, settings)
}

/// Kill the tab's session (if any) and start a fresh one in the last known directory.
fn restart(
    app: &AppHandle,
    tab_id: &str,
    tab: &TabState,
    settings: &Settings,
) -> Result<(), String> {
    let _guard = tab.spawn_lock.lock().unwrap();

    let (old, running, cwd, virtual_env) = {
        let mut g = tab.inner.lock().unwrap();
        g.generation += 1; // silences the old reader threads
        (
            g.shell.take(),
            g.running.take(),
            g.cwd.display().to_string(),
            g.virtual_env.clone(),
        )
    };

    if let Some(mut shell) = old {
        kill_tree(&mut shell.child);
    }
    if let Some(id) = running {
        let _ = app.emit(
            "psoperator://done",
            DonePayload {
                tab_id: tab_id.to_string(),
                id,
                ok: false,
                code: -1,
                cwd,
                virtual_env,
                interrupted: true,
            },
        );
    }
    spawn_shell(app, tab_id, &tab.inner, settings)
}

// ─────────────────────────── reader threads ───────────────────────────

/// Read one console record terminated by either CR or LF. Native Windows
/// programs commonly use bare CR to refresh progress on the same terminal
/// line; waiting only for LF leaves that output buffered until the next line
/// (or forever while the PowerShell session remains open).
fn read_console_record<R: BufRead>(
    reader: &mut R,
    buf: &mut Vec<u8>,
) -> std::io::Result<Option<(usize, bool)>> {
    buf.clear();
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return Ok((!buf.is_empty()).then_some((buf.len(), false)));
        }

        if let Some(index) = available.iter().position(|byte| *byte == b'\r' || *byte == b'\n') {
            buf.extend_from_slice(&available[..index]);
            let delimiter = available[index];
            reader.consume(index + 1);
            let replace = if delimiter == b'\r' {
                let next = reader.fill_buf()?;
                if next.first() == Some(&b'\n') {
                    reader.consume(1);
                    false
                } else {
                    true
                }
            } else {
                false
            };
            return Ok(Some((buf.len(), replace)));
        }

        let count = available.len();
        buf.extend_from_slice(&available[..count]);
        reader.consume(count);
    }
}

fn read_stdout(
    app: AppHandle,
    tab_id: String,
    inner: Arc<Mutex<Inner>>,
    stdout: ChildStdout,
    generation: u64,
) {
    let mut reader = stdout;
    let mut buf = [0u8; 8192];
    let mut pending = Vec::new();

    loop {
        let count = match reader.read(&mut buf) {
            Ok(count) if count > 0 => count,
            Ok(_) | Err(_) => break,
        };
        pending.extend_from_slice(&buf[..count]);

        // Forward ordinary output as soon as the child flushes it. Waiting for
        // CR/LF here hid programs that repaint a screen with ANSI cursor codes
        // and intentionally never write a newline (for example donut.py).
        loop {
            let Some(marker) = pending.iter().position(|byte| *byte == MARK as u8) else {
                if !pending.is_empty() {
                    let text = String::from_utf8_lossy(&pending).into_owned();
                    pending.clear();
                    handle_line(&app, &tab_id, &inner, generation, &text);
                }
                break;
            };

            if marker > 0 {
                let text = String::from_utf8_lossy(&pending[..marker]).into_owned();
                pending.drain(..marker);
                handle_line(&app, &tab_id, &inner, generation, &text);
            }

            let Some(end) = pending.iter().position(|byte| *byte == b'\n' || *byte == b'\r') else {
                // Keep a partial control record out of the visible transcript
                // until its terminating newline arrives.
                break;
            };
            let record = String::from_utf8_lossy(&pending[..end]).into_owned();
            let skip_lf = pending[end] == b'\r' && pending.get(end + 1) == Some(&b'\n');
            let consumed = end + if skip_lf { 2 } else { 1 };
            pending.drain(..consumed);
            handle_line(&app, &tab_id, &inner, generation, &record);
        }
    }

    // Preserve any final ordinary output if the shell closes without a newline.
    if !pending.is_empty() && pending[0] != MARK as u8 {
        let text = String::from_utf8_lossy(&pending).into_owned();
        handle_line(&app, &tab_id, &inner, generation, &text);
    }

    // The process went away. If that wasn't us restarting it, tell the UI.
    let mut g = inner.lock().unwrap();
    if g.generation == generation {
        if let Some(mut shell) = g.shell.take() {
            let _ = shell.child.kill();
            let _ = shell.child.wait();
        }
        let id = g.running.take();
        drop(g);
        let _ = app.emit("psoperator://exit", ExitPayload { tab_id, id });
    }
}

fn read_stderr(
    app: AppHandle,
    tab_id: String,
    inner: Arc<Mutex<Inner>>,
    stderr: ChildStderr,
    generation: u64,
) {
    let mut reader = BufReader::new(stderr);
    let mut buf = Vec::new();
    loop {
        let (count, replace) = match read_console_record(&mut reader, &mut buf) {
            Ok(Some(record)) => record,
            Ok(None) | Err(_) => break,
        };
        let line = String::from_utf8_lossy(&buf[..count]);
        let marker_index = line.find(MARK);
        let output = marker_index.map_or(line.as_ref(), |index| &line[..index]);
        let running_id = {
            let g = inner.lock().unwrap();
            if g.generation == generation { g.running.clone() } else { None }
        };
        if running_id.is_some() && !output.is_empty() {
            let _ = app.emit(
                "psoperator://output",
                OutputPayload {
                    tab_id: tab_id.clone(),
                    id: running_id,
                    kind: "err",
                    text: if replace { output.to_string() } else { format!("{output}\n") },
                    replace,
                },
            );
        }
    }
}

fn handle_line(
    app: &AppHandle,
    tab_id: &str,
    inner: &Arc<Mutex<Inner>>,
    generation: u64,
    line: &str,
) {
    // Split off a trailing control record (it may follow output that had no newline).
    let (text, ctrl) = match line.find(MARK) {
        Some(i) => (&line[..i], Some(&line[i + MARK.len_utf8()..])),
        None => (line, None),
    };

    let running_id = {
        let g = inner.lock().unwrap();
        if g.generation != generation {
            return; // stale session
        }
        g.running.clone()
    };

    if !text.is_empty() || ctrl.is_none() {
        let _ = app.emit(
            "psoperator://output",
            OutputPayload {
                tab_id: tab_id.to_string(),
                id: running_id.clone(),
                kind: "out",
                text: text.to_string(),
                replace: false,
            },
        );
    }

    let Some(ctrl) = ctrl else { return };

    match ctrl.chars().next() {
        Some('E') => {
            let _ = app.emit(
                "psoperator://output",
                OutputPayload {
                    tab_id: tab_id.to_string(),
                    id: running_id,
                    kind: "err",
                    text: format!("{}\n", ctrl.get(2..).unwrap_or("")),
                    replace: false,
                },
            );
        }
        Some('D') => {
            // D <id> <ok> <code> <cwd>|<base64 virtual env>
            let mut parts = ctrl.get(2..).unwrap_or("").splitn(4, ' ');
            let id = parts.next().unwrap_or("").to_string();
            let ok = parts.next().unwrap_or("1") == "1";
            let code: i64 = parts.next().and_then(|c| c.parse().ok()).unwrap_or(0);
            let (cwd, virtual_env) = split_cwd_virtual_env(parts.next().unwrap_or(""));

            {
                let mut g = inner.lock().unwrap();
                if !cwd.is_empty() && Path::new(&cwd).is_dir() {
                    g.cwd = PathBuf::from(&cwd);
                }
                g.virtual_env = virtual_env.clone();
                if g.running.as_deref() == Some(id.as_str()) {
                    g.running = None;
                }
            }

            let _ = app.emit(
                "psoperator://done",
                DonePayload {
                    tab_id: tab_id.to_string(),
                    id,
                    ok: ok && code == 0,
                    code,
                    cwd,
                    virtual_env,
                    interrupted: false,
                },
            );
        }
        Some('I') => {
            // I <version> <edition> <cwd>|<base64 virtual env>
            let mut parts = ctrl.get(2..).unwrap_or("").splitn(3, ' ');
            let version = parts.next().unwrap_or("").to_string();
            let edition = parts.next().unwrap_or("");
            let shell = if edition == "Core" {
                "PowerShell"
            } else {
                "Windows PowerShell"
            }
            .to_string();

            let (reported_cwd, virtual_env) = split_cwd_virtual_env(parts.next().unwrap_or(""));
            let cwd = {
                let mut g = inner.lock().unwrap();
                g.version = version.clone();
                g.shell_name = shell.clone();
                if !reported_cwd.is_empty() && Path::new(&reported_cwd).is_dir() {
                    g.cwd = PathBuf::from(&reported_cwd);
                }
                g.virtual_env = virtual_env.clone();
                g.cwd.display().to_string()
            };
            let _ = app.emit(
                "psoperator://ready",
                ReadyPayload {
                    tab_id: tab_id.to_string(),
                    shell,
                    version,
                    cwd,
                    virtual_env,
                },
            );
        }
        Some('C') => {
            // C <req> <base64 json>
            let mut parts = ctrl.get(2..).unwrap_or("").splitn(2, ' ');
            let req_id = parts.next().unwrap_or("").to_string();
            let b64 = parts.next().unwrap_or("");
            let result = STANDARD
                .decode(b64)
                .ok()
                .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
                .unwrap_or(serde_json::Value::Null);
            let _ = app.emit(
                "psoperator://completion",
                CompletionPayload {
                    tab_id: tab_id.to_string(),
                    req_id,
                    result,
                },
            );
        }
        _ => {}
    }
}

// ───────────────────────────── commands ─────────────────────────────

/// Create the tab's session if it doesn't exist yet. Safe to call repeatedly.
#[tauri::command]
fn start_shell(
    app: AppHandle,
    registry: State<'_, Registry>,
    tab_id: String,
    cwd: Option<String>,
) -> Result<SessionInfo, String> {
    let tab = registry.get_or_create(&tab_id, cwd);
    ensure_shell(&app, &tab_id, &tab, &registry.settings())?;
    let g = tab.inner.lock().unwrap();
    Ok(session_info(&g))
}

/// Read the live per-tab shell state. Used when a new tab inherits its start folder.
#[tauri::command]
fn get_session_info(
    registry: State<'_, Registry>,
    tab_id: String,
) -> Result<SessionInfo, String> {
    let tab = registry.get(&tab_id)?;
    let inner = tab.inner.lock().unwrap();
    Ok(session_info(&inner))
}

#[tauri::command]
fn close_tab(registry: State<'_, Registry>, tab_id: String) {
    let tab = registry.tabs.lock().unwrap().remove(&tab_id);
    if let Some(tab) = tab {
        let shell = {
            let mut g = tab.inner.lock().unwrap();
            g.generation += 1;
            g.running = None;
            g.shell.take()
        };
        if let Some(mut shell) = shell {
            kill_tree(&mut shell.child);
        }
    }
}

#[tauri::command]
fn run_command(
    app: AppHandle,
    registry: State<'_, Registry>,
    tab_id: String,
    id: String,
    command: String,
) -> Result<(), String> {
    let tab = registry.get(&tab_id)?;
    if tab.inner.lock().unwrap().running.is_some() {
        return Err("A command is already running.".into());
    }
    ensure_shell(&app, &tab_id, &tab, &registry.settings())?;

    let command = ensure_git_progress(&command);
    let line = build_line(&id, &command);
    let mut guard = tab.inner.lock().unwrap();
    let g = &mut *guard;

    // Mark as running while holding the lock so the reader thread can never see
    // output for this command before it knows the command's id.
    g.running = Some(id);
    let result = match g.shell.as_mut() {
        Some(shell) => shell
            .stdin
            .write_all(line.as_bytes())
            .and_then(|_| shell.stdin.flush())
            .map_err(|e| format!("Failed to send command to PowerShell: {e}")),
        None => Err("PowerShell is not running.".to_string()),
    };
    if result.is_err() {
        g.running = None;
    }
    result
}

/// Forward a line of text to the stdin of whatever is currently running.
#[tauri::command]
fn send_input(
    registry: State<'_, Registry>,
    tab_id: String,
    text: String,
) -> Result<(), String> {
    let tab = registry.get(&tab_id)?;
    let mut guard = tab.inner.lock().unwrap();
    let g = &mut *guard;
    if g.running.is_none() {
        return Err("Nothing is running.".into());
    }
    let shell = g.shell.as_mut().ok_or("PowerShell is not running.")?;
    shell
        .stdin
        .write_all(text.as_bytes())
        .and_then(|_| shell.stdin.write_all(b"\n"))
        .and_then(|_| shell.stdin.flush())
        .map_err(|e| e.to_string())
}

/// Interrupt the running command. A persistent pipe-based session cannot deliver
/// Ctrl+C, so the session is restarted in the same directory instead.
#[tauri::command]
fn cancel_command(
    app: AppHandle,
    registry: State<'_, Registry>,
    tab_id: String,
) -> Result<(), String> {
    let tab = registry.get(&tab_id)?;
    if tab.inner.lock().unwrap().running.is_none() {
        return Ok(());
    }
    restart(&app, &tab_id, &tab, &registry.settings())
}

#[tauri::command]
fn restart_shell(
    app: AppHandle,
    registry: State<'_, Registry>,
    tab_id: String,
) -> Result<(), String> {
    let tab = registry.get(&tab_id)?;
    restart(&app, &tab_id, &tab, &registry.settings())
}

/// Ask the tab's PowerShell for completions. The answer arrives asynchronously as a
/// `psoperator://completion` event carrying the same `req_id`.
#[tauri::command]
fn request_completion(
    registry: State<'_, Registry>,
    tab_id: String,
    req_id: String,
    input: String,
    cursor: u32,
) -> Result<(), String> {
    if !valid_req_id(&req_id) {
        return Err("Invalid request id.".into());
    }
    let tab = registry.get(&tab_id)?;
    let mut guard = tab.inner.lock().unwrap();
    let g = &mut *guard;
    if g.running.is_some() {
        return Err("A command is running.".into());
    }
    let shell = g.shell.as_mut().ok_or("PowerShell is not running.")?;
    let line = format!(
        "__psoperator_complete '{}' '{}' {}\n",
        req_id,
        STANDARD.encode(input.as_bytes()),
        cursor
    );
    shell
        .stdin
        .write_all(line.as_bytes())
        .and_then(|_| shell.stdin.flush())
        .map_err(|e| e.to_string())
}

/// Plain file-system completion, used as a fallback when PowerShell can't answer in time.
#[tauri::command]
fn complete_path(registry: State<'_, Registry>, tab_id: String, partial: String) -> Vec<String> {
    let Ok(tab) = registry.get(&tab_id) else {
        return Vec::new();
    };
    let cwd = tab.inner.lock().unwrap().cwd.clone();

    let (dir_part, prefix) = match partial.rfind(|c: char| c == '\\' || c == '/') {
        Some(i) => (&partial[..=i], &partial[i + 1..]),
        None => ("", partial.as_str()),
    };

    let base = if dir_part.is_empty() {
        cwd
    } else {
        let p = PathBuf::from(dir_part);
        if p.is_absolute() {
            p
        } else {
            cwd.join(p)
        }
    };

    let prefix_lc = prefix.to_lowercase();
    let mut dirs = Vec::new();
    let mut files = Vec::new();

    if let Ok(read) = fs::read_dir(&base) {
        for entry in read.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if !name.to_lowercase().starts_with(&prefix_lc) {
                continue;
            }
            // Hide dotfiles unless the user started typing one.
            if name.starts_with('.') && !prefix.starts_with('.') {
                continue;
            }
            let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
            if is_dir {
                dirs.push(format!("{dir_part}{name}\\"));
            } else {
                files.push(format!("{dir_part}{name}"));
            }
        }
    }

    dirs.sort_by_key(|s| s.to_lowercase());
    files.sort_by_key(|s| s.to_lowercase());
    dirs.extend(files);
    dirs.truncate(200);
    dirs
}

#[tauri::command]
fn get_settings(registry: State<'_, Registry>) -> Settings {
    registry.settings()
}

#[tauri::command]
fn is_admin_mode() -> bool {
    process_is_elevated()
}

#[tauri::command]
fn launch_admin(registry: State<'_, Registry>, tab_id: String) -> Result<(), String> {
    let tab = registry.get(&tab_id)?;
    let cwd = tab.inner.lock().unwrap().cwd.clone();
    #[cfg(windows)]
    {
        launch_elevated(&cwd)
    }
    #[cfg(not(windows))]
    {
        let _ = cwd;
        Err("Administrator mode is available only on Windows.".into())
    }
}

#[cfg(windows)]
fn process_is_elevated() -> bool {
    use std::{ffi::c_void, mem::size_of, ptr::null_mut};

    #[repr(C)]
    struct TokenElevation {
        token_is_elevated: u32,
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn GetCurrentProcess() -> *mut c_void;
        fn CloseHandle(handle: *mut c_void) -> i32;
    }
    #[link(name = "advapi32")]
    extern "system" {
        fn OpenProcessToken(process: *mut c_void, access: u32, token: *mut *mut c_void) -> i32;
        fn GetTokenInformation(
            token: *mut c_void,
            information_class: u32,
            information: *mut c_void,
            information_length: u32,
            return_length: *mut u32,
        ) -> i32;
    }

    unsafe {
        let mut token = null_mut();
        if OpenProcessToken(GetCurrentProcess(), 0x0008, &mut token) == 0 {
            return false;
        }
        let mut elevation = TokenElevation { token_is_elevated: 0 };
        let mut returned = 0;
        let ok = GetTokenInformation(
            token,
            20,
            &mut elevation as *mut _ as *mut c_void,
            size_of::<TokenElevation>() as u32,
            &mut returned,
        ) != 0;
        CloseHandle(token);
        ok && elevation.token_is_elevated != 0
    }
}

#[cfg(not(windows))]
fn process_is_elevated() -> bool {
    false
}

#[cfg(windows)]
fn launch_elevated(cwd: &Path) -> Result<(), String> {
    use std::{ffi::OsStr, iter, os::windows::ffi::OsStrExt, ptr};

    #[link(name = "shell32")]
    extern "system" {
        fn ShellExecuteW(
            window: *mut std::ffi::c_void,
            operation: *const u16,
            file: *const u16,
            parameters: *const u16,
            directory: *const u16,
            show_command: i32,
        ) -> isize;
    }

    fn wide(value: &OsStr) -> Vec<u16> {
        value.encode_wide().chain(iter::once(0)).collect()
    }

    let executable = std::env::current_exe().map_err(|e| format!("Could not find PSOperator: {e}"))?;
    let cwd_text = cwd.to_string_lossy();
    let encoded_cwd = STANDARD.encode(cwd_text.as_bytes());
    let parameters = wide(OsStr::new(&format!("--psoperator-admin-cwd {encoded_cwd}")));
    let verb = wide(OsStr::new("runas"));
    let executable = wide(executable.as_os_str());
    let directory = wide(cwd.as_os_str());

    let result = unsafe {
        ShellExecuteW(
            ptr::null_mut(),
            verb.as_ptr(),
            executable.as_ptr(),
            parameters.as_ptr(),
            directory.as_ptr(),
            1,
        )
    };
    if result > 32 {
        Ok(())
    } else if result == 5 {
        Err("The Windows elevation request was canceled.".into())
    } else {
        Err(format!("Windows could not start the elevated app (ShellExecute error {result})."))
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DirectoryTreeNode {
    id: usize,
    parent_id: Option<usize>,
    name: String,
    path: String,
    is_directory: bool,
    depth: usize,
    size: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DirectoryTree {
    root: String,
    nodes: Vec<DirectoryTreeNode>,
    truncated: bool,
}

const DIRECTORY_TREE_LIMIT: usize = 450;
const DIRECTORY_TREE_DEPTH: usize = 4;

#[tauri::command]
fn read_directory_tree(path: String) -> Result<DirectoryTree, String> {
    let root = PathBuf::from(path)
        .canonicalize()
        .map_err(|error| format!("Could not open directory: {error}"))?;
    if !root.is_dir() {
        return Err("The selected path is not a directory.".into());
    }

    let root_path = root.to_string_lossy().into_owned();
    let mut nodes = vec![DirectoryTreeNode {
        id: 0,
        parent_id: None,
        name: root.file_name().and_then(|name| name.to_str()).unwrap_or(&root_path).to_string(),
        path: root_path.clone(),
        is_directory: true,
        depth: 0,
        size: None,
    }];
    let mut truncated = false;
    append_directory_nodes(&root, 0, 0, &mut nodes, &mut truncated);
    Ok(DirectoryTree {
        root: root_path,
        nodes,
        truncated,
    })
}

fn append_directory_nodes(
    directory: &Path,
    parent_id: usize,
    depth: usize,
    nodes: &mut Vec<DirectoryTreeNode>,
    truncated: &mut bool,
) {
    if depth >= DIRECTORY_TREE_DEPTH || nodes.len() >= DIRECTORY_TREE_LIMIT {
        if nodes.len() >= DIRECTORY_TREE_LIMIT { *truncated = true; }
        return;
    }
    let Ok(read_dir) = fs::read_dir(directory) else { return; };
    let mut entries: Vec<_> = read_dir.filter_map(Result::ok).collect();
    entries.sort_by_key(|entry| {
        let is_dir = entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false);
        (!is_dir, entry.file_name().to_string_lossy().to_lowercase())
    });

    for entry in entries {
        if nodes.len() >= DIRECTORY_TREE_LIMIT {
            *truncated = true;
            break;
        }
        let Ok(kind) = entry.file_type() else { continue; };
        let is_directory = kind.is_dir();
        let metadata = entry.metadata().ok();
        let id = nodes.len();
        nodes.push(DirectoryTreeNode {
            id,
            parent_id: Some(parent_id),
            name: entry.file_name().to_string_lossy().into_owned(),
            path: entry.path().to_string_lossy().into_owned(),
            is_directory,
            depth: depth + 1,
            size: if is_directory { None } else { metadata.map(|value| value.len()) },
        });
        if is_directory {
            append_directory_nodes(&entry.path(), id, depth + 1, nodes, truncated);
        }
    }
}

/// Persist settings. They apply to sessions started after this call (new tabs, /restart).
#[tauri::command]
fn set_settings(
    app: AppHandle,
    registry: State<'_, Registry>,
    mut settings: Settings,
) -> Result<Settings, String> {
    if !matches!(settings.shell.as_str(), "auto" | "pwsh" | "powershell") {
        settings.shell = "auto".into();
    }
    if !matches!(settings.split_mode.as_str(), "manual" | "automatic") {
        settings.split_mode = "manual".into();
    }
    if !settings.font_size.is_finite() {
        settings.font_size = 13.5;
    }
    settings.font_size = settings.font_size.clamp(11.0, 20.0);
    if !matches!(
        settings.theme.as_str(),
        "dark" | "light" | "midnight" | "cyberpunk" | "matcha" | "nord"
    ) {
        settings.theme = "dark".into();
    }
    if !settings.sfx_volume.is_finite() {
        settings.sfx_volume = 0.0;
    }
    settings.sfx_volume = settings.sfx_volume.clamp(0.0, 1.0);
    if let Some(path) = settings_path(&app) {
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir).map_err(|e| format!("Could not save settings: {e}"))?;
        }
        let json = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
        fs::write(&path, json).map_err(|e| format!("Could not save settings: {e}"))?;
    }

    *registry.settings.lock().unwrap() = settings.clone();
    Ok(settings)
}

// ───────────────────────────── entry point ─────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(Registry::new())
        .setup(|app| {
            let settings = load_settings(app.handle());
            *app.state::<Registry>().settings.lock().unwrap() = settings;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            start_shell,
            get_session_info,
            close_tab,
            run_command,
            send_input,
            cancel_command,
            restart_shell,
            request_completion,
            complete_path,
            get_settings,
            is_admin_mode,
            launch_admin,
            read_directory_tree,
            set_settings,
        ])
        .build(tauri::generate_context!())
        .expect("error while building PSOperator");

    app.run(|handle, event| {
        // Don't leave orphaned PowerShell processes behind.
        if let tauri::RunEvent::Exit = event {
            let registry = handle.state::<Registry>();
            let tabs: Vec<TabState> = registry.tabs.lock().unwrap().values().cloned().collect();
            for tab in tabs {
                let shell = tab.inner.lock().unwrap().shell.take();
                if let Some(mut shell) = shell {
                    kill_tree(&mut shell.child);
                }
            }
        }
    });
}
