// Adapted from Soflution1/McpHub (MIT)

//! API token management for SSE clients (Cursor / Claude Desktop).
//!
//! Upstream kept the token store inline in `main.rs` / `dashboard.rs`; the
//! standalone `auth` module was declared but never shipped. Rebuilt here from
//! the call sites in `dashboard.rs` (handle_list_tokens / handle_create_token
//! / handle_revoke_token / validate_token) and `main.rs` (CLI `token`
//! subcommands).

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::UNIX_EPOCH;

use crate::mcphub::paths;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct TokenEntry {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allowed_servers: Option<Vec<String>>,
    #[serde(default)]
    pub created_at: u64,
}

#[derive(Serialize, Deserialize, Default)]
pub struct TokenStore {
    pub tokens: HashMap<String, TokenEntry>,
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Load the token store from `tokens.json`. Missing file / parse errors
/// degrade to an empty store rather than panicking.
pub fn load_tokens() -> TokenStore {
    let path = paths::tokens_path();
    if !path.exists() {
        return TokenStore::default();
    }
    match std::fs::read_to_string(&path) {
        Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
        Err(_) => TokenStore::default(),
    }
}

/// Persist the token store. Written with 0600 permissions on Unix.
pub fn save_tokens(store: &TokenStore) -> std::io::Result<()> {
    let path = paths::tokens_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_string_pretty(store)?;
    std::fs::write(&path, json)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let perms = std::fs::Permissions::from_mode(0o600);
        let _ = std::fs::set_permissions(&path, perms);
    }
    Ok(())
}

/// Create a new named token, persist it, and return the opaque token string.
pub fn create_token(name: &str, allowed_servers: Option<Vec<String>>) -> String {
    let token = format!("mcphub_{}", uuid::Uuid::new_v4());
    let entry = TokenEntry {
        name: name.to_string(),
        allowed_servers,
        created_at: now_secs(),
    };
    let mut store = load_tokens();
    store.tokens.insert(token.clone(), entry);
    if let Err(e) = save_tokens(&store) {
        eprintln!("[McpHub][WARN] Failed to save tokens: {}", e);
    }
    token
}

/// Remove a token by its opaque string. Returns true if it existed.
pub fn revoke_token(token: &str) -> bool {
    let mut store = load_tokens();
    if store.tokens.remove(token).is_some() {
        let _ = save_tokens(&store);
        true
    } else {
        false
    }
}

/// Whether any credential is configured, i.e. whether SSE clients must
/// authenticate. A fresh install with neither named tokens nor a legacy
/// `auth-token` file runs open so existing Cursor/Claude configs keep working;
/// once the user creates a token, every request must present one.
pub fn any_tokens_configured() -> bool {
    if !load_tokens().tokens.is_empty() {
        return true;
    }
    std::fs::read_to_string(paths::auth_token_path())
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false)
}

/// Validate an HTTP `Authorization` header value. Accepts both
/// `Bearer <token>` and a bare `<token>`. Returns the matching entry.
pub fn validate_authorization(header: &str) -> Option<TokenEntry> {
    let token = header
        .strip_prefix("Bearer ")
        .or_else(|| header.strip_prefix("bearer "))
        .unwrap_or(header)
        .trim();
    validate_token(token)
}

/// Validate a `Bearer` token. Checks the named-token store first, then falls
/// back to the legacy single-token file (so a fresh install with no named
/// tokens still authenticates the generated `auth-token`).
pub fn validate_token(bearer: &str) -> Option<TokenEntry> {
    if bearer.is_empty() {
        return None;
    }
    let store = load_tokens();
    if let Some(entry) = store.tokens.get(bearer) {
        return Some(entry.clone());
    }
    // Legacy fallback: the single `auth-token` file is active when the named
    // store has no entries.
    let path = paths::auth_token_path();
    if let Ok(content) = std::fs::read_to_string(&path) {
        let legacy = content.trim();
        if !legacy.is_empty() && legacy == bearer {
            return Some(TokenEntry {
                name: "legacy".to_string(),
                allowed_servers: None,
                created_at: 0,
            });
        }
    }
    None
}

/// Read (and lazily create) the legacy single-token file. Ported from
/// `dashboard.rs::get_auth_token`; the token format switches from the
/// upstream nanosecond timestamp to a UUID v4 for collision-free generation.
pub fn get_legacy_token() -> String {
    let path = paths::auth_token_path();
    if let Ok(token) = std::fs::read_to_string(&path) {
        let token = token.trim().to_string();
        if !token.is_empty() {
            return token;
        }
    }

    let token = format!("mcphub_{}", uuid::Uuid::new_v4());
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(&path, &token);

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(metadata) = std::fs::metadata(&path) {
            let mut perms = metadata.permissions();
            perms.set_mode(0o600);
            let _ = std::fs::set_permissions(&path, perms);
        }
    }

    token
}
