fn main() {
    // Declare app commands explicitly so each one gets a permission that capabilities must grant.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "engine_send",
            "engine_status",
            "engine_restart",
            "secret_status",
            "secret_set",
            "secret_delete",
        ]),
    ))
    .expect("failed to run tauri-build");
}
