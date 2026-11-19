//! API keys in the operating system's credential store (macOS Keychain first), per ADR 0003.
//!
//! The webview can set, delete and ask *whether* a key exists, but can never read one back.
//! Keys reach the engine only as environment variables when the sidecar starts.
//!
//! Besides the provider keys in [`KNOWN`], each MCP server may have one secret, stored as
//! `mcp.<server id>` and passed as `ORZEUS_MCP_SECRET_<ID>` (the engine uses the same rule in
//! services/engine/src/mcp-servers.ts). The keychain cannot list entries, so the ids of stored
//! MCP secrets are kept in one more entry, [`MCP_INDEX`].

use serde::Serialize;

/// Keychain service name (matches the app identifier).
const SERVICE: &str = "dev.orzeus.desktop";

/// Keys Orzeus knows about: (name used by the UI, environment variable for the engine).
pub const KNOWN: [(&str, &str); 3] = [
    ("anthropic", "ANTHROPIC_API_KEY"),
    ("gemini", "GEMINI_API_KEY"),
    ("openai", "OPENAI_API_KEY"),
];

/// Keychain entry listing the server ids that have an MCP secret, one per line.
const MCP_INDEX: &str = "mcp-index";

/// The server id of an MCP secret name (`mcp.<id>`), if the name is one.
fn mcp_id(name: &str) -> Option<&str> {
    let id = name.strip_prefix("mcp.")?;
    let valid = !id.is_empty()
        && id.len() <= 63
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        && !id.starts_with('-');
    valid.then_some(id)
}

fn mcp_var(id: &str) -> String {
    format!(
        "ORZEUS_MCP_SECRET_{}",
        id.to_ascii_uppercase().replace('-', "_")
    )
}

fn entry(name: &str) -> Result<keyring::Entry, String> {
    if !KNOWN.iter().any(|(known, _)| *known == name) && mcp_id(name).is_none() {
        return Err(format!("unknown secret {name}"));
    }
    keyring::Entry::new(SERVICE, name).map_err(|error| error.to_string())
}

fn mcp_index() -> Vec<String> {
    keyring::Entry::new(SERVICE, MCP_INDEX)
        .ok()
        .and_then(|e| e.get_password().ok())
        .map(|text| {
            text.lines()
                .filter(|id| mcp_id(&format!("mcp.{id}")).is_some())
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

fn set_mcp_index(ids: &[String]) -> Result<(), String> {
    let entry = keyring::Entry::new(SERVICE, MCP_INDEX).map_err(|error| error.to_string())?;
    if ids.is_empty() {
        return match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(error.to_string()),
        };
    }
    entry
        .set_password(&ids.join("\n"))
        .map_err(|error| error.to_string())
}

fn read(name: &str) -> Option<String> {
    entry(name).ok()?.get_password().ok()
}

/// Environment variables for the engine process, read fresh at every (re)start.
pub fn engine_env() -> Vec<(String, String)> {
    let providers = KNOWN
        .iter()
        .filter_map(|(name, var)| read(name).map(|value| ((*var).to_owned(), value)));
    let mcp = mcp_index()
        .into_iter()
        .filter_map(|id| read(&format!("mcp.{id}")).map(|value| (mcp_var(&id), value)));
    providers.chain(mcp).collect()
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
        .map_err(|error| error.to_string())?;
    if let Some(id) = mcp_id(&name) {
        let mut ids = mcp_index();
        if !ids.iter().any(|known| known == id) {
            ids.push(id.to_owned());
            set_mcp_index(&ids)?;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn secret_delete(name: String) -> Result<(), String> {
    match entry(&name)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => {}
        Err(error) => return Err(error.to_string()),
    }
    if let Some(id) = mcp_id(&name) {
        let ids: Vec<String> = mcp_index()
            .into_iter()
            .filter(|known| known != id)
            .collect();
        set_mcp_index(&ids)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_unknown_names() {
        assert!(entry("aws").is_err());
        assert!(entry("anthropic").is_ok());
        assert!(entry("mcp.github").is_ok());
        assert!(entry("mcp.").is_err());
        assert!(entry("mcp.GitHub").is_err());
        assert!(entry("mcp.-x").is_err());
        assert!(entry(MCP_INDEX).is_err());
    }

    #[test]
    fn mcp_variables_match_the_engine() {
        assert_eq!(mcp_var("my-server-2"), "ORZEUS_MCP_SECRET_MY_SERVER_2");
    }
}
