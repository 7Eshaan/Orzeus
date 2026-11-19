//! API keys in the operating system's credential store (macOS Keychain first), per ADR 0003.
//!
//! The webview can set, delete and ask *whether* a key exists, but can never read one back.
//! Keys reach the engine only as environment variables when the sidecar starts.

use serde::Serialize;

/// Keychain service name (matches the app identifier).
const SERVICE: &str = "dev.orzeus.desktop";

/// Keys Orzeus knows about: (name used by the UI, environment variable for the engine).
pub const KNOWN: [(&str, &str); 3] = [
    ("anthropic", "ANTHROPIC_API_KEY"),
    ("gemini", "GEMINI_API_KEY"),
    ("openai", "OPENAI_API_KEY"),
];

fn entry(name: &str) -> Result<keyring::Entry, String> {
    if !KNOWN.iter().any(|(known, _)| *known == name) {
        return Err(format!("unknown secret {name}"));
    }
    keyring::Entry::new(SERVICE, name).map_err(|error| error.to_string())
}

fn read(name: &str) -> Option<String> {
    entry(name).ok()?.get_password().ok()
}

/// Environment variables for the engine process, read fresh at every (re)start.
pub fn engine_env() -> Vec<(String, String)> {
    KNOWN
        .iter()
        .filter_map(|(name, var)| read(name).map(|value| ((*var).to_owned(), value)))
        .collect()
}

#[derive(Serialize)]
pub struct SecretStatus {
    anthropic: bool,
    gemini: bool,
    openai: bool,
}

#[tauri::command]
pub fn secret_status() -> SecretStatus {
    SecretStatus {
        anthropic: read("anthropic").is_some(),
        gemini: read("gemini").is_some(),
        openai: read("openai").is_some(),
    }
}

#[tauri::command]
pub fn secret_set(name: String, value: String) -> Result<(), String> {
    let value = value.trim();
    if value.is_empty() {
        return Err("the key is empty".to_owned());
    }
    entry(&name)?
        .set_password(value)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn secret_delete(name: String) -> Result<(), String> {
    match entry(&name)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_unknown_names() {
        assert!(entry("aws").is_err());
        assert!(entry("anthropic").is_ok());
    }
}
