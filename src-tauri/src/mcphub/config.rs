// Adapted from Soflution1/McpHub (MIT)

use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

use crate::mcphub::paths;

#[derive(Debug, Clone, PartialEq)]
pub struct ServerConfig {
    pub command: String,
    pub args: Vec<String>,
    pub env: HashMap<String, String>,
    pub pool: usize,
    /// Per-server request timeout override (seconds). Falls back to the global default when None.
    pub request_timeout_secs: Option<u64>,
    /// Whether the user enabled this server. Persisted as the `enabled` key in
    /// config.json. Defaults to true; the legacy `disabled: true` key still
    /// skips a server entirely on load.
    pub enabled: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Mode {
    Discover,
    Passthrough,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Preload {
    All,
    None,
    Some(Vec<String>),
}

#[derive(Debug, Clone)]
pub struct ProxyConfig {
    pub servers: HashMap<String, ServerConfig>,
    pub mode: Mode,
    pub preload: Preload,
    pub idle_timeout_ms: u64,
    pub preload_delay_ms: u64,
    pub health_check_interval_secs: u64,
    pub health_auto_restart: bool,
    pub health_notifications: bool,
    /// Default request timeout in seconds for child MCP calls.
    /// Per-server overrides live on `ServerConfig.request_timeout_secs`.
    pub request_timeout_secs: u64,
}

impl Default for ProxyConfig {
    fn default() -> Self {
        Self {
            servers: HashMap::new(),
            mode: Mode::Discover,
            preload: Preload::All,
            idle_timeout_ms: 5 * 60 * 1000,
            preload_delay_ms: 200,
            health_check_interval_secs: 30,
            health_auto_restart: true,
            health_notifications: true,
            request_timeout_secs: 120,
        }
    }
}

fn is_self(name: &str, config: &Value) -> bool {
    let lower = name.to_lowercase();
    if lower == "mcphub" || lower == "mcp-hub" || lower == "mcp-on-demand" {
        return true;
    }
    if let Some(cmd) = config.get("command").and_then(|v| v.as_str()) {
        let cmd_lower = cmd.to_lowercase();
        if cmd_lower.contains("mcphub") || cmd_lower.contains("mcp-on-demand") {
            return true;
        }
    }
    if let Some(args) = config.get("args").and_then(|v| v.as_array()) {
        if args.iter().any(|a| {
            a.as_str()
                .map(|s| {
                    let s_lower = s.to_lowercase();
                    s_lower.contains("mcphub") || s_lower.contains("mcp-on-demand")
                })
                .unwrap_or(false)
        }) {
            return true;
        }
    }
    false
}

fn parse_servers(json: &Value) -> HashMap<String, ServerConfig> {
    let mut result = HashMap::new();
    let servers_obj = json
        .get("mcpServers")
        .or_else(|| json.get("servers"))
        .unwrap_or(json);
    let servers = match servers_obj.as_object() {
        Some(m) => m,
        None => return result,
    };

    for (name, config) in servers {
        if name.starts_with('_') {
            continue;
        }
        if is_self(name, config) {
            eprintln!("[McpHub][INFO] Skipped self: {}", name);
            continue;
        }
        if let Some(cmd) = config.get("command").and_then(|v| v.as_str()) {
            let args: Vec<String> = config
                .get("args")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|v| v.as_str().map(String::from))
                        .collect()
                })
                .unwrap_or_default();
            let env: HashMap<String, String> = config
                .get("env")
                .and_then(|v| v.as_object())
                .map(|obj| {
                    obj.iter()
                        .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                        .collect()
                })
                .unwrap_or_default();
            let pool = config.get("pool").and_then(|v| v.as_u64()).unwrap_or(1) as usize;
            let request_timeout_secs = config
                .get("requestTimeoutSecs")
                .or_else(|| config.get("request_timeout_secs"))
                .and_then(|v| v.as_u64());
            // On-disk toggle: upstream writes `disabled: true` to turn a server
            // off. Legacy dashboard writes `enabled: false`. We keep disabled
            // servers in the map (enabled=false) so the UI can list them and
            // re-enable; runtime routing skips them.
            let disabled_on_disk = config
                .get("disabled")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let enabled_on_disk = config.get("enabled").and_then(|v| v.as_bool());
            let enabled = match (disabled_on_disk, enabled_on_disk) {
                (true, _) => false,
                (false, Some(e)) => e,
                (false, None) => true,
            };
            result.insert(
                name.clone(),
                ServerConfig {
                    command: cmd.to_string(),
                    args,
                    env,
                    pool,
                    request_timeout_secs,
                    enabled,
                },
            );
        }
    }
    result
}

fn load_dedicated_config() -> Option<ProxyConfig> {
    let path = paths::config_path();
    if !path.exists() {
        return None;
    }
    let content = fs::read_to_string(&path).ok()?;
    let json: Value = serde_json::from_str(&content).ok()?;
    let servers = parse_servers(&json);
    if servers.is_empty() {
        return None;
    }
    eprintln!(
        "[McpHub][INFO] Loaded {} servers from {}",
        servers.len(),
        path.display()
    );

    let mut config = ProxyConfig {
        servers,
        ..Default::default()
    };
    if let Some(settings) = json.get("settings") {
        if let Some(mode) = settings.get("mode").and_then(|v| v.as_str()) {
            config.mode = match mode {
                "passthrough" => Mode::Passthrough,
                _ => Mode::Discover,
            };
        }
        if let Some(timeout) = settings.get("idleTimeout").and_then(|v| v.as_u64()) {
            config.idle_timeout_ms = timeout * 1000;
        }
        if let Some(timeout) = settings
            .get("requestTimeoutSecs")
            .or_else(|| settings.get("request_timeout_secs"))
            .and_then(|v| v.as_u64())
        {
            config.request_timeout_secs = timeout;
        }
        // Health monitor settings
        if let Some(health) = settings.get("health") {
            if let Some(interval) = health.get("checkInterval").and_then(|v| v.as_u64()) {
                config.health_check_interval_secs = interval;
            }
            if let Some(restart) = health.get("autoRestart").and_then(|v| v.as_bool()) {
                config.health_auto_restart = restart;
            }
            if let Some(notify) = health.get("notifications").and_then(|v| v.as_bool()) {
                config.health_notifications = notify;
            }
        }
    }
    Some(config)
}

fn get_config_paths() -> Vec<PathBuf> {
    let mut found = Vec::new();
    let home = paths::home_dir();
    found.push(home.join(".cursor").join("mcp.json"));
    if cfg!(target_os = "macos") {
        // On macOS the Claude Desktop config lives under ~/Library/Application Support.
        // (Upstream used dirs::data_dir(), which resolves to the same location; we
        // keep the home-relative path to avoid pulling in the `dirs` crate.)
        found.push(
            home.join("Library")
                .join("Application Support")
                .join("Claude")
                .join("claude_desktop_config.json"),
        );
    }
    found.push(
        home.join(".codeium")
            .join("windsurf")
            .join("mcp_config.json"),
    );
    found.push(home.join(".vscode").join("mcp.json"));
    found
}

pub fn auto_detect() -> ProxyConfig {
    if let Some(config) = load_dedicated_config() {
        let mode_str = match config.mode {
            Mode::Discover => "discover",
            Mode::Passthrough => "passthrough",
        };
        eprintln!(
            "[McpHub][INFO] Using dedicated config: {} servers, mode={}",
            config.servers.len(),
            mode_str
        );
        return apply_env_overrides(config);
    }

    let mut config = ProxyConfig::default();
    for path in &get_config_paths() {
        if path.exists() {
            if let Ok(content) = fs::read_to_string(path) {
                if let Ok(json) = serde_json::from_str::<Value>(&content) {
                    let servers = parse_servers(&json);
                    if !servers.is_empty() {
                        eprintln!(
                            "[McpHub][INFO] Found {} servers in {}",
                            servers.len(),
                            path.display()
                        );
                        config.servers.extend(servers);
                    }
                }
            }
        }
    }

    if config.servers.is_empty() {
        eprintln!("[McpHub][WARN] No MCP servers found.");
    } else {
        eprintln!(
            "[McpHub][INFO] Total: {} servers detected",
            config.servers.len()
        );
    }
    apply_env_overrides(config)
}

fn apply_env_overrides(mut config: ProxyConfig) -> ProxyConfig {
    if let Ok(mode) = std::env::var("MCP_ON_DEMAND_MODE") {
        config.mode = match mode.as_str() {
            "passthrough" => Mode::Passthrough,
            _ => Mode::Discover,
        };
    }
    if let Ok(preload) = std::env::var("MCP_ON_DEMAND_PRELOAD") {
        config.preload = match preload.as_str() {
            "none" => Preload::None,
            _ => Preload::All,
        };
    }
    if let Ok(timeout) = std::env::var("MCPHUB_REQUEST_TIMEOUT_SECS") {
        if let Ok(parsed) = timeout.parse::<u64>() {
            if parsed > 0 {
                config.request_timeout_secs = parsed;
            }
        }
    }
    config
}

// ─── config.json read-modify-write helpers (Phase 3 dashboard) ────────────────

/// Read config.json as a generic JSON value, preserving `settings` and any
/// unknown keys. If the file is missing, a minimal default
/// (`{"mcpServers":{},"settings":{"mode":"discover","idleTimeout":300}}`) is
/// written to disk so the rest of the module can assume it exists.
pub fn read_config_value() -> Value {
    let path = paths::config_path();
    let content = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(_) => {
            // Cold start: no config.json yet. Write a minimal default so the
            // UI opens to an empty-but-valid state instead of erroring.
            let default = serde_json::json!({
                "mcpServers": {},
                "settings": { "mode": "discover", "idleTimeout": 300 }
            });
            if write_config_value(&default).is_ok() {
                return default;
            }
            return serde_json::json!({});
        }
    };
    serde_json::from_str(&content).unwrap_or_else(|_| serde_json::json!({}))
}

/// Pretty-write config.json, creating the base directory if needed.
pub fn write_config_value(value: &Value) -> Result<(), String> {
    let path = paths::config_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let pretty = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    std::fs::write(&path, pretty).map_err(|e| e.to_string())?;
    Ok(())
}

/// The key under which servers live in config.json. Prefers the existing key
/// (`mcpServers` or `servers`), defaulting to `mcpServers`.
fn servers_key(root: &mut Value) -> &'static str {
    if root.get("servers").is_some() {
        "servers"
    } else {
        "mcpServers"
    }
}

fn ensure_object(root: &mut Value) -> &mut serde_json::Map<String, Value> {
    if !root.is_object() {
        *root = serde_json::json!({});
    }
    root.as_object_mut().expect("just ensured object")
}

/// Insert or update a server entry, preserving unknown keys (e.g.
/// `requestTimeoutSecs`) from the existing entry.
pub fn upsert_server_entry(
    name: &str,
    command: &str,
    args: &[String],
    env: &HashMap<String, String>,
    pool: u32,
    enabled: bool,
) -> Result<(), String> {
    let mut root = read_config_value();
    let key = {
        let k = servers_key(&mut root);
        k.to_string()
    };
    {
        let obj = ensure_object(&mut root);
        if obj.get(&key).is_none() {
            obj.insert(key.clone(), serde_json::json!({}));
        }
        if !obj[&key].is_object() {
            obj.insert(key.clone(), serde_json::json!({}));
        }
    }

    let entry = root[&key]
        .get_mut(name)
        .map(|e| {
            if !e.is_object() {
                *e = serde_json::json!({});
            }
            e
        })
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}));

    // Merge into existing entry so unknown keys survive. The on-disk toggle is
    // `disabled` (upstream convention); we keep the legacy `enabled` key out so
    // the file stays byte-compatible with the upstream McpHub format.
    if let Some(map) = entry.as_object() {
        let mut merged = map.clone();
        merged.insert("command".into(), serde_json::json!(command));
        merged.insert("args".into(), serde_json::json!(args));
        merged.insert("env".into(), serde_json::json!(env));
        // Only write pool when it deviates from the default of 1, to match the
        // upstream format (which omits it for single-process servers).
        if pool > 1 {
            merged.insert("pool".into(), serde_json::json!(pool));
        } else {
            merged.remove("pool");
        }
        // Drop any legacy `enabled` key and write the upstream `disabled` key.
        merged.remove("enabled");
        if enabled {
            merged.remove("disabled");
        } else {
            merged.insert("disabled".into(), serde_json::json!(true));
        }
        root[&key][name] = Value::Object(merged);
    }

    write_config_value(&root)
}

/// Remove a server entry. Returns Ok even if it did not exist.
pub fn remove_server_entry(name: &str) -> Result<(), String> {
    let mut root = read_config_value();
    let key = if root.get("servers").is_some() {
        "servers"
    } else {
        "mcpServers"
    };
    if let Some(obj) = root.get_mut(key).and_then(|v| v.as_object_mut()) {
        obj.remove(name);
    }
    write_config_value(&root)
}

/// Toggle the persisted enabled state of a server entry. Writes the upstream
/// `disabled` key (`!enabled`); clears it when enabling.
pub fn set_server_enabled_flag(name: &str, enabled: bool) -> Result<(), String> {
    let mut root = read_config_value();
    let key = servers_key(&mut root).to_string();
    if !root[&key].is_object() {
        root[&key] = serde_json::json!({});
    }
    if !root[&key][name].is_object() {
        root[&key][name] = serde_json::json!({});
    }
    let entry = &mut root[&key][name];
    // Drop legacy `enabled`; write upstream `disabled`.
    if let Some(obj) = entry.as_object_mut() {
        obj.remove("enabled");
        if enabled {
            obj.remove("disabled");
        } else {
            obj.insert("disabled".into(), serde_json::json!(true));
        }
    }
    write_config_value(&root)
}

/// Read the persisted enabled state of a server entry. Honors upstream
/// `disabled: true` and legacy `enabled: false`; absent → true.
pub fn get_server_enabled_flag(name: &str) -> bool {
    let root = read_config_value();
    let key = if root.get("servers").is_some() {
        "servers"
    } else {
        "mcpServers"
    };
    let entry = root.get(key).and_then(|s| s.get(name));
    let disabled = entry
        .and_then(|e| e.get("disabled"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    if disabled {
        return false;
    }
    // Legacy fallback: an explicit `enabled: false` still means off.
    entry
        .and_then(|e| e.get("enabled"))
        .and_then(|v| v.as_bool())
        .unwrap_or(true)
}

/// Key used in the `toolEnabled` override map.
fn tool_key(server: &str, tool: &str) -> String {
    format!("{}/{}", server, tool)
}

/// Persist a per-tool enabled override.
pub fn set_tool_enabled_override(server: &str, tool: &str, enabled: bool) -> Result<(), String> {
    let mut root = read_config_value();
    if !root.get("toolEnabled").is_some() {
        root["toolEnabled"] = serde_json::json!({});
    }
    if !root["toolEnabled"].is_object() {
        root["toolEnabled"] = serde_json::json!({});
    }
    root["toolEnabled"][tool_key(server, tool)] = serde_json::json!(enabled);
    write_config_value(&root)
}

/// Read the `toolEnabled` override map as `"<server>/<tool>" -> bool`.
pub fn tool_enabled_overrides() -> HashMap<String, bool> {
    let root = read_config_value();
    let mut map = HashMap::new();
    if let Some(obj) = root.get("toolEnabled").and_then(|v| v.as_object()) {
        for (k, v) in obj {
            if let Some(b) = v.as_bool() {
                map.insert(k.clone(), b);
            }
        }
    }
    map
}

/// Whether a server/tool pair is enabled. Absent override → enabled.
pub fn is_tool_enabled(server: &str, tool: &str) -> bool {
    tool_enabled_overrides()
        .get(&tool_key(server, tool))
        .copied()
        .unwrap_or(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_is_self() {
        assert!(is_self("McpHub", &json!({})));
        assert!(is_self("mcp-hub", &json!({})));
        assert!(!is_self("github", &json!({})));
        assert!(is_self("test", &json!({"command": "/path/to/mcphub"})));
        assert!(is_self(
            "test",
            &json!({"command": "node", "args": ["mcphub"]})
        ));
    }

    #[test]
    fn test_parse_servers() {
        let json = json!({
            "mcpServers": {
                "github": {
                    "command": "npx",
                    "args": ["-y", "@modelcontextprotocol/server-github"],
                    "env": {
                        "GITHUB_TOKEN": "123"
                    }
                },
                "disabled_server": {
                    "command": "test",
                    "disabled": true
                },
                "McpHub": {
                    "command": "mcphub"
                }
            }
        });

        let servers = parse_servers(&json);

        // Disabled servers are kept in the map (enabled=false) so the dashboard
        // can list and re-enable them; only self-referential ones are dropped.
        assert_eq!(servers.len(), 2);
        assert!(servers.contains_key("github"));
        assert!(servers.contains_key("disabled_server"));
        assert!(!servers.contains_key("McpHub")); // skipped self

        let github = &servers["github"];
        assert_eq!(github.command, "npx");
        assert_eq!(github.args.len(), 2);
        assert_eq!(github.env.get("GITHUB_TOKEN").unwrap(), "123");
        assert!(github.enabled);

        let disabled = &servers["disabled_server"];
        assert!(!disabled.enabled);
    }

    #[test]
    fn test_parse_servers_no_servers() {
        let json = json!({"otherKey": "value"});
        let servers = parse_servers(&json);
        assert!(servers.is_empty());
    }
}
