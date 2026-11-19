//! Orzeus desktop shell.
//!
//! Deliberately thin: it owns the window, supervises the `orzeusd` engine sidecar and relays
//! JSON-RPC lines between the engine's stdio and the webview. All orchestration logic lives in
//! the engine (see `docs/decisions/0001-engine-as-node-sidecar.md`).

mod secrets;
mod sidecar;

use tauri::{Manager, RunEvent};

/// Builds and runs the app. Called from `main`.
///
/// # Panics
///
/// Panics if the Tauri runtime fails to start, which leaves nothing to recover.
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(sidecar::EngineHandle::default())
        .setup(|app| {
            sidecar::start(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            sidecar::engine_send,
            sidecar::engine_status,
            sidecar::engine_restart,
            secrets::secret_status,
            secrets::secret_set,
            secrets::secret_delete
        ])
        .build(tauri::generate_context!())
        .expect("failed to build the Orzeus app");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            handle.state::<sidecar::EngineHandle>().shutdown();
        }
    });
}
