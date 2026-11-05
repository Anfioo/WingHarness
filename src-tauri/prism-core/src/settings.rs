//! What this feature remembers between runs: the active profile, the port its
//! own core listens on, and the routing mode the user picked.

use serde::{Deserialize, Serialize};

use crate::store;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ClashSettings {
    /// File name of the active profile inside `profiles/`, e.g. `default.yaml`.
    pub active_profile: Option<String>,
    /// Port the managed core exposes its REST controller on. Every other Clash
    /// client on the machine wants mihomo's default 9090, and the one that
    /// starts second ends up with no API at all — so this app takes its own.
    pub controller_port: Option<u16>,
    /// Routing mode the user last picked: `rule`, `global` or `direct`. The
    /// profile's own `mode:` is only the starting point — a core restarted or
    /// reloaded from that file would otherwise forget the choice.
    pub mode: Option<String>,
    /// Whether the user wants Windows pointed at the core. Only an intent: the
    /// system proxy itself is still switched off whenever no core is running,
    /// and turned back on by the next start.
    pub sys_proxy: Option<bool>,
}

pub fn load() -> ClashSettings {
    let Ok(path) = store::settings_path() else {
        return ClashSettings::default();
    };
    let Ok(text) = std::fs::read_to_string(path) else {
        return ClashSettings::default();
    };
    serde_json::from_str(&text).unwrap_or_default()
}

pub fn save(settings: &ClashSettings) -> Result<(), String> {
    let path = store::settings_path()?;
    let text =
        serde_json::to_string_pretty(settings).map_err(|e| format!("Failed to serialize settings: {e}"))?;
    store::atomic_write(&path, &text)
}

pub fn set_active(id: Option<String>) -> Result<(), String> {
    let mut settings = load();
    settings.active_profile = id;
    save(&settings)
}

pub fn set_mode(mode: Option<String>) -> Result<(), String> {
    let mut settings = load();
    settings.mode = mode;
    save(&settings)
}

pub fn set_sys_proxy(enabled: bool) -> Result<(), String> {
    let mut settings = load();
    settings.sys_proxy = Some(enabled);
    save(&settings)
}

/// The user asked for the system proxy, so a core that starts should claim it.
pub fn wants_sys_proxy() -> bool {
    load().sys_proxy.unwrap_or(false)
}

/// The controller port, chosen on first use and then kept: the compiled output
/// has to keep naming the same address across every apply.
pub fn controller_port() -> Result<u16, String> {
    let mut settings = load();
    if let Some(port) = settings.controller_port {
        return Ok(port);
    }
    let port = free_port()?;
    settings.controller_port = Some(port);
    save(&settings)?;
    Ok(port)
}

/// Prefer the 19000s, which no Clash client reserves; fall back to whatever the
/// OS hands out if some other program is camping there too.
fn free_port() -> Result<u16, String> {
    for port in 19090..19100u16 {
        if std::net::TcpListener::bind(("127.0.0.1", port)).is_ok() {
            return Ok(port);
        }
    }
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0))
        .map_err(|e| format!("Cannot pick a controller port: {e}"))?;
    listener
        .local_addr()
        .map(|addr| addr.port())
        .map_err(|e| format!("Cannot pick a controller port: {e}"))
}
