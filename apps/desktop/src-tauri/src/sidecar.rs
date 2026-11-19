//! Supervises the `orzeusd` engine process and relays its stdio.
//!
//! Wire format: one JSON-RPC message per line. This module never parses messages; it only
//! moves lines. Engine stdout lines are emitted to the webview as [`LINE_EVENT`]; the webview
//! sends lines back with the [`engine_send`] command. Engine stderr (structured logs) is
//! forwarded to this process's stderr.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};

/// Event carrying one line of engine stdout.
pub const LINE_EVENT: &str = "engine://line";
/// Event carrying an [`EngineStatus`] whenever it changes.
pub const STATUS_EVENT: &str = "engine://status";

/// Give up after this many restarts inside [`RESTART_WINDOW`].
const MAX_RESTARTS: usize = 5;
const RESTART_WINDOW: Duration = Duration::from_secs(60);
const BASE_RESTART_DELAY: Duration = Duration::from_millis(250);

/// Lifecycle of the engine process, as seen by the webview.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum EngineStatus {
    Starting,
    Running { pid: u32 },
    Exited { code: Option<i32> },
    Failed { message: String },
}

/// Shared state: the running child (for writing to its stdin) and the latest status.
pub struct EngineHandle {
    child: Mutex<Option<CommandChild>>,
    status: Mutex<EngineStatus>,
}

impl Default for EngineHandle {
    fn default() -> Self {
        Self {
            child: Mutex::new(None),
            status: Mutex::new(EngineStatus::Starting),
        }
    }
}

impl EngineHandle {
    /// Kills the engine if it is running. Called when the app exits.
    pub fn shutdown(&self) {
        if let Ok(mut guard) = self.child.lock()
            && let Some(child) = guard.take()
        {
            // The engine also exits on its own when stdin closes; this is the backstop.
            let _ = child.kill();
        }
    }

    fn set_child(&self, child: Option<CommandChild>) {
        if let Ok(mut guard) = self.child.lock() {
            *guard = child;
        }
    }
}

/// How to launch the engine. Overridable for development and tests:
/// `ORZEUS_NODE` (default `node`) and `ORZEUS_ENGINE_ENTRY` (default: the built engine in this
/// repository). Production packaging as a single-executable sidecar comes in Phase 7.
struct LaunchSpec {
    program: String,
    args: Vec<String>,
}

fn launch_spec() -> LaunchSpec {
    let program = std::env::var("ORZEUS_NODE").unwrap_or_else(|_| "node".to_owned());
    let entry = std::env::var("ORZEUS_ENGINE_ENTRY").unwrap_or_else(|_| {
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../services/engine/dist/main.js"
        )
        .to_owned()
    });
    LaunchSpec {
        program,
        args: vec![entry],
    }
}

/// Starts the supervisor loop in the background.
pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(supervise(app));
}

async fn supervise(app: AppHandle) {
    let mut recent_starts: Vec<Instant> = Vec::new();
    loop {
        let now = Instant::now();
        recent_starts.retain(|started| now.duration_since(*started) < RESTART_WINDOW);
        if recent_starts.len() >= MAX_RESTARTS {
            set_status(
                &app,
                EngineStatus::Failed {
                    message: format!(
                        "engine stopped {MAX_RESTARTS} times within {}s; not restarting",
                        RESTART_WINDOW.as_secs()
                    ),
                },
            );
            return;
        }
        if let Some(delay) = restart_delay(recent_starts.len()) {
            tokio::time::sleep(delay).await;
        }
        recent_starts.push(Instant::now());

        set_status(&app, EngineStatus::Starting);
        let status = match run_once(&app).await {
            Ok(code) => EngineStatus::Exited { code },
            Err(message) => EngineStatus::Failed { message },
        };
        app.state::<EngineHandle>().set_child(None);
        set_status(&app, status);
    }
}

/// No delay for the first start, then exponential backoff.
fn restart_delay(previous_starts: usize) -> Option<Duration> {
    if previous_starts == 0 {
        return None;
    }
    let exponent = u32::try_from(previous_starts - 1)
        .unwrap_or(u32::MAX)
        .min(6);
    Some(BASE_RESTART_DELAY * 2u32.pow(exponent))
}

/// Runs the engine until it exits. Returns its exit code.
async fn run_once(app: &AppHandle) -> Result<Option<i32>, String> {
    let spec = launch_spec();
    let (mut events, child) = app
        .shell()
        .command(&spec.program)
        .args(&spec.args)
        .envs(crate::secrets::engine_env())
        .spawn()
        .map_err(|error| format!("failed to start engine with `{}`: {error}", spec.program))?;

    let pid = child.pid();
    app.state::<EngineHandle>().set_child(Some(child));
    set_status(app, EngineStatus::Running { pid });

    while let Some(event) = events.recv().await {
        match event {
            CommandEvent::Stdout(bytes) => {
                for line in split_lines(&bytes) {
                    let _ = app.emit(LINE_EVENT, line);
                }
            }
            CommandEvent::Stderr(bytes) => {
                for line in split_lines(&bytes) {
                    eprintln!("[orzeusd] {line}");
                }
            }
            CommandEvent::Error(message) => eprintln!("[orzeusd] stream error: {message}"),
            CommandEvent::Terminated(payload) => return Ok(payload.code),
            _ => {}
        }
    }
    Ok(None)
}

fn set_status(app: &AppHandle, status: EngineStatus) {
    if let Ok(mut guard) = app.state::<EngineHandle>().status.lock() {
        guard.clone_from(&status);
    }
    let _ = app.emit(STATUS_EVENT, status);
}

/// Splits a stdout/stderr chunk into non-empty lines without trailing CR/LF.
fn split_lines(bytes: &[u8]) -> Vec<String> {
    String::from_utf8_lossy(bytes)
        .split('\n')
        .map(|line| line.trim_end_matches('\r'))
        .filter(|line| !line.trim().is_empty())
        .map(str::to_owned)
        .collect()
}

/// Writes one JSON-RPC line to the engine's stdin.
#[tauri::command]
pub fn engine_send(line: String, handle: State<'_, EngineHandle>) -> Result<(), String> {
    if line.contains('\n') {
        return Err("a message must be a single line".to_owned());
    }
    let mut guard = handle
        .child
        .lock()
        .map_err(|_| "engine handle is poisoned".to_owned())?;
    let child = guard
        .as_mut()
        .ok_or_else(|| "engine is not running".to_owned())?;
    let mut bytes = line.into_bytes();
    bytes.push(b'\n');
    child
        .write(&bytes)
        .map_err(|error| format!("failed to write to engine: {error}"))
}

/// Stops the engine; the supervisor starts it again (picking up changed API keys).
#[tauri::command]
pub fn engine_restart(handle: State<'_, EngineHandle>) -> Result<(), String> {
    let mut guard = handle
        .child
        .lock()
        .map_err(|_| "engine handle is poisoned".to_owned())?;
    if let Some(child) = guard.take() {
        child.kill().map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// Latest engine status, for a webview that missed earlier status events.
#[tauri::command]
pub fn engine_status(handle: State<'_, EngineHandle>) -> Result<EngineStatus, String> {
    handle
        .status
        .lock()
        .map(|status| status.clone())
        .map_err(|_| "engine handle is poisoned".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_lines_handles_crlf_blank_and_multiple_lines() {
        assert_eq!(split_lines(b"a\r\n\n  \nb\n"), vec!["a", "b"]);
        assert_eq!(split_lines(b""), Vec::<String>::new());
    }

    #[test]
    fn restart_delay_backs_off_exponentially_with_a_cap() {
        assert_eq!(restart_delay(0), None);
        assert_eq!(restart_delay(1), Some(Duration::from_millis(250)));
        assert_eq!(restart_delay(2), Some(Duration::from_millis(500)));
        assert_eq!(restart_delay(100), Some(Duration::from_secs(16)));
    }

    #[test]
    fn status_serializes_with_a_state_tag() {
        let json = serde_json::to_string(&EngineStatus::Running { pid: 7 }).unwrap_or_default();
        assert_eq!(json, r#"{"state":"running","pid":7}"#);
    }
}
