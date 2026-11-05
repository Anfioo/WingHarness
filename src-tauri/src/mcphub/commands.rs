// Adapted from Soflution1/McpHub (MIT)

//! Tauri commands exposed to the webview for the MCP Hub gateway.
//!
//! Phase 2 shipped the lifecycle commands (start / stop / status). Phase 3
//! completes the management surface: server CRUD + toggles, tool listing +
//! toggles, recent logs, cache rebuild, token CRUD and endpoint info. All
//! input/output field names follow the fixed frontend contract in
//! `src/commands/services/mcphub/types.ts`.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

use crate::mcphub::auth;
use crate::mcphub::cache;
use crate::mcphub::child::{ChildManager, ServerConfig};
use crate::mcphub::config;
use crate::mcphub::log_store::LogStore;
use crate::mcphub::protocol::ToolDef;
use crate::mcphub::state::{McpHubState, DEFAULT_SSE_PORT};

// ─── View types (outgoing; camelCase on the wire) ────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerView {
    name: String,
    command: String,
    args: Vec<String>,
    enabled: bool,
    running: bool,
    tool_count: usize,
    healthy: bool,
    last_latency_ms: Option<u64>,
    last_call_at: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolView {
    server: String,
    name: String,
    description: String,
    enabled: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntryView {
    ts: u64,
    level: String,
    server: Option<String>,
    message: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenView {
    token: String,
    name: String,
    allowed_servers: Option<Vec<String>>,
    created_at: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EndpointInfo {
    sse_url: String,
    stdio_available: bool,
}

// ─── Lifecycle (Phase 2, unchanged) ─────────────────────────────────────────

/// Start the MCP Hub gateway (detect servers, load cache, bind SSE port).
#[tauri::command]
pub async fn mcphub_start(state: tauri::State<'_, McpHubState>) -> Result<(), String> {
    state.start().await
}

/// Stop the MCP Hub gateway (kill child MCP processes, release the SSE port).
#[tauri::command]
pub async fn mcphub_stop(state: tauri::State<'_, McpHubState>) -> Result<(), String> {
    state.stop().await;
    Ok(())
}

/// Report whether the gateway is running and which port it is bound to.
#[tauri::command]
pub fn mcphub_status(state: tauri::State<'_, McpHubState>) -> serde_json::Value {
    let running = state.is_running();
    let port = state.port();

    // Prefer the live in-memory config while running (it tracks hot-reloads);
    // fall back to disk detection when the gateway is stopped. Either way the
    // cache file is the source of truth for tool counts.
    let cfg = match state.proxy() {
        Some(proxy) => {
            let store = proxy.config_store();
            // Sync command: try_lock avoids blocking the runtime thread. Fall
            // back to disk detection if another task holds the lock.
            let locked = store.try_lock().ok().map(|guard| (*guard).clone());
            locked.unwrap_or_else(config::auto_detect)
        }
        None => config::auto_detect(),
    };

    let mode_str = match cfg.mode {
        crate::mcphub::config::Mode::Passthrough => "passthrough",
        crate::mcphub::config::Mode::Discover => "discover",
    };
    let server_count = cfg.servers.values().filter(|s| s.enabled).count();
    let tool_count = cache::load_cache()
        .map(|c| c.servers.values().map(|v| v.len()).sum())
        .unwrap_or(0);

    serde_json::json!({
        "running": running,
        "port": port,
        "mode": mode_str,
        "serverCount": server_count,
        "toolCount": tool_count,
        "uptimeMs": state.uptime_ms(),
    })
}

/// Aggregate runtime metrics: total requests, active SSE sessions, uptime,
/// and per-server call/error/latency/health. Used by the dashboard stats panel.
#[tauri::command]
pub async fn mcphub_metrics(
    state: tauri::State<'_, McpHubState>,
) -> Result<serde_json::Value, String> {
    let proxy = state.proxy();

    let mut server_entries: Vec<serde_json::Value> = Vec::new();

    match &proxy {
        Some(p) => {
            // Snapshot per-server metrics under a short lock.
            let metrics = p.metrics.lock().await;
            // Build the union of configured names and names we have metrics for,
            // so a server that has never been called still shows up.
            let config_names: std::collections::BTreeSet<String> = p
                .config_store()
                .lock()
                .await
                .servers
                .keys()
                .cloned()
                .collect();
            let mut all_names: std::collections::BTreeSet<String> = config_names;
            for name in metrics.servers.keys() {
                all_names.insert(name.clone());
            }

            for name in all_names {
                let m = metrics.servers.get(&name);
                let requests = m.map(|x| x.call_count).unwrap_or(0);
                let errors = m.map(|x| x.error_count).unwrap_or(0);
                let avg_latency_ms = m
                    .filter(|x| x.call_count > 0)
                    .map(|x| x.total_latency_ms / x.call_count);
                let last_call_at = m
                    .and_then(|x| x.last_call_time)
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as u64);
                let running = p.child_manager().is_running(&name).await;
                // "Healthy" means no recorded call errors — NOT "currently
                // running". Child servers start lazily, so an idle server must
                // not be flagged unhealthy just because it is not spawned yet.
                let healthy = errors == 0;
                server_entries.push(serde_json::json!({
                    "name": name,
                    "requests": requests,
                    "errors": errors,
                    "avgLatencyMs": avg_latency_ms,
                    "lastCallAt": last_call_at,
                    "healthy": healthy,
                    "running": running,
                }));
            }
        }
        None => {
            // Gateway down: surface configured names with zeroed counters. Use
            // the same detection as the running path so self-like and
            // `_`-prefixed entries are filtered out identically.
            let cfg = config::auto_detect();
            let mut names: Vec<&String> = cfg.servers.keys().collect();
            names.sort();
            for name in names {
                server_entries.push(serde_json::json!({
                    "name": name,
                    "requests": 0u64,
                    "errors": 0u64,
                    "avgLatencyMs": serde_json::Value::Null,
                    "lastCallAt": serde_json::Value::Null,
                    "healthy": false,
                    "running": false,
                }));
            }
        }
    }

    let total_requests = proxy.as_ref().map(|p| p.total_requests()).unwrap_or(0);
    let active_sessions = proxy.as_ref().map(|p| p.active_sessions()).unwrap_or(0);
    // Anchor uptime to the state's start time so a UI reload mid-run still
    // reports a stable value (the proxy's own counter resets only on restart).
    let uptime_secs = match &proxy {
        Some(_) => state
            .started_wall()
            .and_then(|t| SystemTime::now().duration_since(t).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0),
        None => 0,
    };

    Ok(serde_json::json!({
        "totalRequests": total_requests,
        "activeSessions": active_sessions,
        "uptimeSecs": uptime_secs,
        "servers": server_entries,
    }))
}

/// Switch the gateway between `discover` (two meta-tools) and `passthrough`
/// (all tools prefixed with `server__`). Persists to config.json and hot-reloads.
#[tauri::command]
pub async fn mcphub_set_mode(
    state: tauri::State<'_, McpHubState>,
    mode: String,
) -> Result<(), String> {
    if mode != "discover" && mode != "passthrough" {
        return Err("mode must be \"discover\" or \"passthrough\"".into());
    }
    let mut root = config::read_config_value();
    if !root.is_object() {
        root = serde_json::json!({});
    }
    if let Some(obj) = root.as_object_mut() {
        obj.entry("settings".to_string())
            .or_insert_with(|| serde_json::json!({}));
        if let Some(settings) = obj.get_mut("settings").and_then(|v| v.as_object_mut()) {
            settings.insert("mode".to_string(), serde_json::json!(mode));
        }
    }
    config::write_config_value(&root)?;
    if let Some(proxy) = state.proxy() {
        proxy.reload_config().await;
    }
    Ok(())
}

// ─── Settings ────────────────────────────────────────────────────────────────

/// Outgoing settings snapshot for the dashboard. Field names are camelCase on
/// the wire to match the frontend `SettingsView`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsView {
    /// `"discover"` or `"passthrough"`.
    pub mode: String,
    /// Idle timeout in seconds (matches the on-disk `settings.idleTimeout`).
    pub idle_timeout: u64,
    /// Number of tools cached in schema-cache.json.
    pub cache_tools: u32,
    /// Number of servers cached in schema-cache.json.
    pub cache_servers: u32,
}

/// Read the current gateway settings plus cache inventory.
#[tauri::command]
pub fn mcphub_get_settings() -> Result<SettingsView, String> {
    let root = config::read_config_value();
    let settings = root
        .get("settings")
        .cloned()
        .unwrap_or(serde_json::json!({}));

    let mode = settings
        .get("mode")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| "discover".to_string());
    let idle_timeout = settings
        .get("idleTimeout")
        .and_then(|v| v.as_u64())
        .unwrap_or(300);

    let (cache_tools, cache_servers) = match cache::load_cache() {
        Some(c) => {
            let servers = c.servers.len() as u32;
            let tools = c.servers.values().map(|v| v.len() as u32).sum();
            (tools, servers)
        }
        None => (0, 0),
    };

    Ok(SettingsView {
        mode,
        idle_timeout,
        cache_tools,
        cache_servers,
    })
}

/// Update gateway settings. Only the provided fields are written; omitted ones
/// are left untouched. Hot-reloads the gateway if it is currently running.
#[tauri::command]
pub async fn mcphub_update_settings(
    state: tauri::State<'_, McpHubState>,
    mode: Option<String>,
    idle_timeout_secs: Option<u64>,
) -> Result<(), String> {
    if let Some(ref m) = mode {
        if m != "discover" && m != "passthrough" {
            return Err("mode must be \"discover\" or \"passthrough\"".into());
        }
    }
    if let Some(secs) = idle_timeout_secs {
        if secs == 0 {
            return Err("idle_timeout_secs must be > 0".into());
        }
    }

    let mut root = config::read_config_value();
    if !root.is_object() {
        root = serde_json::json!({});
    }
    if let Some(obj) = root.as_object_mut() {
        obj.entry("settings".to_string())
            .or_insert_with(|| serde_json::json!({}));
        if let Some(settings) = obj.get_mut("settings").and_then(|v| v.as_object_mut()) {
            if let Some(m) = mode {
                settings.insert("mode".to_string(), serde_json::json!(m));
            }
            if let Some(secs) = idle_timeout_secs {
                settings.insert("idleTimeout".to_string(), serde_json::json!(secs));
            }
        }
    }
    config::write_config_value(&root)?;

    if let Some(proxy) = state.proxy() {
        proxy.reload_config().await;
    }
    Ok(())
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/// Normalize free-form MCP / stderr log levels to the frontend's
/// "info" | "warn" | "error" vocabulary.
fn normalize_level(raw: &str) -> String {
    match raw {
        "error" | "critical" | "alert" | "emergency" | "fatal" => "error",
        "warn" | "warning" => "warn",
        _ => "info",
    }
    .to_string()
}

/// Read all persisted per-tool enabled overrides as `"<server>/<tool>" -> bool`.
fn tool_overrides() -> HashMap<String, bool> {
    config::tool_enabled_overrides()
}

fn is_self_like(name: &str, command: &str) -> bool {
    let lower = name.to_lowercase();
    if lower == "mcphub" || lower == "mcp-hub" || lower == "mcp-on-demand" {
        return true;
    }
    let cmd_lower = command.to_lowercase();
    cmd_lower.contains("mcphub") || cmd_lower.contains("mcp-on-demand")
}

// ─── Servers ─────────────────────────────────────────────────────────────────

/// List every configured server with its runtime state. When the gateway is
/// running the view comes from live in-memory state; otherwise it falls back
/// to config.json (+ cache.json tool counts).
#[tauri::command]
pub async fn mcphub_list_servers(
    state: tauri::State<'_, McpHubState>,
) -> Result<Vec<ServerView>, String> {
    let proxy = state.proxy();

    let configs: HashMap<String, ServerConfig> = match &proxy {
        Some(p) => p.config_store().lock().await.servers.clone(),
        None => HashMap::new(),
    };

    let mut views = Vec::new();

    if let Some(p) = &proxy {
        for (name, sc) in configs {
            let running = p.child_manager().is_running(&name).await;
            // Prefer the live process tool list when running, else the search
            // index catalog.
            let tool_count = if running {
                p.child_manager().running_tools(&name).await.len()
            } else {
                p.search_engine()
                    .lock()
                    .await
                    .get_catalog()
                    .iter()
                    .filter(|c| c.server == name)
                    .count()
            };
            let (healthy, avg_latency, last_call) = {
                let metrics = p.metrics.lock().await;
                match metrics.servers.get(&name) {
                    // Healthy = no recorded errors (see mcphub_metrics for why
                    // idleness is not treated as unhealthy).
                    Some(m) => (
                        m.error_count == 0,
                        if m.call_count > 0 {
                            Some(m.total_latency_ms / m.call_count)
                        } else {
                            None
                        },
                        m.last_call_time
                            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                            .map(|d| d.as_millis() as u64),
                    ),
                    None => (true, None, None),
                }
            };
            views.push(ServerView {
                name,
                command: sc.command,
                args: sc.args,
                enabled: sc.enabled,
                running,
                tool_count,
                healthy,
                last_latency_ms: avg_latency,
                last_call_at: last_call,
            });
        }
    } else {
        // Gateway down: read config.json directly.
        let root = config::read_config_value();
        let key = if root.get("servers").is_some() {
            "servers"
        } else {
            "mcpServers"
        };
        let servers_obj = root.get(key).cloned().unwrap_or(serde_json::json!({}));
        let cache = cache::load_cache();

        if let Some(obj) = servers_obj.as_object() {
            for (name, entry) in obj {
                if name.starts_with('_') {
                    continue;
                }
                let command = entry
                    .get("command")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                if is_self_like(name, &command) {
                    continue;
                }
                let args: Vec<String> = entry
                    .get("args")
                    .and_then(|v| v.as_array())
                    .map(|a| {
                        a.iter()
                            .filter_map(|v| v.as_str().map(String::from))
                            .collect()
                    })
                    .unwrap_or_default();
                // Upstream `disabled: true` → off; legacy `enabled: false` → off.
                let disabled_on_disk = entry
                    .get("disabled")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                let enabled = if disabled_on_disk {
                    false
                } else {
                    entry
                        .get("enabled")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(true)
                };
                let tool_count = cache
                    .as_ref()
                    .and_then(|c| c.servers.get(name))
                    .map(|t| t.len())
                    .unwrap_or(0);
                views.push(ServerView {
                    name: name.clone(),
                    command,
                    args,
                    enabled,
                    running: false,
                    tool_count,
                    healthy: false,
                    last_latency_ms: None,
                    last_call_at: None,
                });
            }
        }
    }

    views.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(views)
}

/// Add a new server to config.json. Persists immediately and hot-reloads the
/// gateway if it is currently running.
#[tauri::command]
pub async fn mcphub_add_server(
    state: tauri::State<'_, McpHubState>,
    name: String,
    command: String,
    args: Vec<String>,
    env: HashMap<String, String>,
    pool: u32,
) -> Result<(), String> {
    if name.trim().is_empty() {
        return Err("server name is required".into());
    }
    if command.trim().is_empty() {
        return Err("command is required".into());
    }
    if is_self_like(&name, &command) {
        return Err("refusing to add McpHub as its own child server".into());
    }

    config::upsert_server_entry(&name, &command, &args, &env, pool, true)?;
    if let Some(proxy) = state.proxy() {
        proxy.reload_config().await;
    }
    Ok(())
}

/// Result of a JSON paste import. `tools` is a best-effort count from the
/// current schema-cache for the servers that were imported.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub ok: u32,
    pub failed: u32,
    pub tools: u32,
}

/// Derive a fallback server name from a server entry's command (last path
/// segment, `.exe` stripped). Used when a pasted single-server JSON has no
/// `name` field.
fn derive_name_from_command(entry: &serde_json::Value) -> String {
    let cmd = entry
        .get("command")
        .and_then(|v| v.as_str())
        .unwrap_or("server");
    let base = cmd.rsplit(['/', '\\']).next().unwrap_or(cmd);
    let base = base.strip_suffix(".exe").unwrap_or(base);
    if base.trim().is_empty() {
        "server".to_string()
    } else {
        base.to_string()
    }
}

/// Import servers from a pasted JSON blob. Accepts two shapes:
/// - `{"mcpServers": { "<name>": { "command": ..., "args": ..., "env": ... } }}` — batch.
/// - `{"command": "npx", "args": [...], "env": {...}}` — single server (an
///   optional `"name"` field is honored; otherwise a name is derived from the
///   command).
///
/// Each valid entry is merged into config.json's `mcpServers` (unknown keys
/// preserved; legacy `enabled` keys dropped in favor of upstream `disabled`).
#[tauri::command]
pub async fn mcphub_import_servers(
    state: tauri::State<'_, McpHubState>,
    json: String,
) -> Result<ImportResult, String> {
    let parsed: serde_json::Value =
        serde_json::from_str(&json).map_err(|e| format!("invalid JSON: {e}"))?;

    // Flatten either shape into (name, entry) pairs.
    let mut pending: Vec<(String, serde_json::Value)> = Vec::new();
    if let Some(servers_obj) = parsed.get("mcpServers").or_else(|| parsed.get("servers")) {
        if let Some(obj) = servers_obj.as_object() {
            for (name, entry) in obj {
                pending.push((name.clone(), entry.clone()));
            }
        }
    } else if parsed.get("command").is_some() {
        let name = parsed
            .get("name")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| derive_name_from_command(&parsed));
        pending.push((name, parsed.clone()));
    } else {
        return Err("JSON must contain either \"mcpServers\" or a \"command\" field".into());
    }

    if pending.is_empty() {
        return Err("no servers found in the pasted JSON".into());
    }

    let mut root = config::read_config_value();
    if !root.is_object() {
        root = serde_json::json!({});
    }
    let key = if root.get("servers").is_some() {
        "servers".to_string()
    } else {
        "mcpServers".to_string()
    };
    if !root.get(&key).map(|v| v.is_object()).unwrap_or(false) {
        root[&key] = serde_json::json!({});
    }

    let mut ok = 0u32;
    let mut failed = 0u32;
    let mut imported_names: Vec<String> = Vec::new();

    for (mut name, entry) in pending {
        let command = entry.get("command").and_then(|v| v.as_str()).unwrap_or("");
        if command.trim().is_empty() {
            failed += 1;
            continue;
        }
        if name.trim().is_empty() || name.starts_with('_') {
            name = derive_name_from_command(&entry);
        }
        if is_self_like(&name, command) {
            failed += 1;
            continue;
        }

        // Merge into the existing entry so hand-tuned keys survive.
        let existing = root[&key]
            .get(&name)
            .cloned()
            .unwrap_or(serde_json::json!({}));
        let mut merged = existing
            .as_object()
            .cloned()
            .unwrap_or_else(|| serde_json::Map::new());
        if let Some(obj) = entry.as_object() {
            for (k, v) in obj {
                if k == "name" {
                    continue; // transient; never persisted
                }
                merged.insert(k.clone(), v.clone());
            }
        }
        // Imported servers default to enabled: drop any legacy `enabled` key.
        merged.remove("enabled");
        root[&key][name.clone()] = serde_json::Value::Object(merged);
        ok += 1;
        imported_names.push(name);
    }

    config::write_config_value(&root)?;
    if let Some(proxy) = state.proxy() {
        proxy.reload_config().await;
    }

    // Best-effort tool inventory from the current cache for the imported names.
    let mut tools = 0u32;
    if let Some(cache) = cache::load_cache() {
        for name in &imported_names {
            if let Some(list) = cache.servers.get(name) {
                tools += list.len() as u32;
            }
        }
    }

    Ok(ImportResult { ok, failed, tools })
}

/// Update an existing server's command / args / env / pool. Preserves the
/// current `enabled` flag.
#[tauri::command]
pub async fn mcphub_update_server(
    state: tauri::State<'_, McpHubState>,
    name: String,
    command: String,
    args: Vec<String>,
    env: HashMap<String, String>,
    pool: u32,
) -> Result<(), String> {
    if command.trim().is_empty() {
        return Err("command is required".into());
    }
    let enabled = config::get_server_enabled_flag(&name);
    config::upsert_server_entry(&name, &command, &args, &env, pool, enabled)?;
    if let Some(proxy) = state.proxy() {
        proxy.reload_config().await;
    }
    Ok(())
}

/// Remove a server from config.json (and stop its process pool if running).
#[tauri::command]
pub async fn mcphub_remove_server(
    state: tauri::State<'_, McpHubState>,
    name: String,
) -> Result<(), String> {
    if let Some(proxy) = state.proxy() {
        proxy.child_manager().stop_server(&name).await;
    }
    config::remove_server_entry(&name)?;
    if let Some(proxy) = state.proxy() {
        proxy.reload_config().await;
    }
    Ok(())
}

/// Toggle a server on/off. Disabling also tears down its running process pool.
#[tauri::command]
pub async fn mcphub_set_server_enabled(
    state: tauri::State<'_, McpHubState>,
    name: String,
    enabled: bool,
) -> Result<(), String> {
    config::set_server_enabled_flag(&name, enabled)?;
    if let Some(proxy) = state.proxy() {
        if !enabled {
            proxy.child_manager().stop_server(&name).await;
        }
        proxy.reload_config().await;
    }
    Ok(())
}

// ─── Tools ──────────────────────────────────────────────────────────────────

/// List known tools across servers (optionally filtered by server). Uses the
/// live search index when the gateway is running, otherwise cache.json.
#[tauri::command]
pub async fn mcphub_list_tools(
    state: tauri::State<'_, McpHubState>,
    server_name: Option<String>,
) -> Result<Vec<ToolView>, String> {
    let proxy = state.proxy();
    let overrides = tool_overrides();

    let mut views = Vec::new();

    if let Some(p) = &proxy {
        let catalog = p.search_engine().lock().await.get_catalog();
        for entry in catalog {
            if let Some(f) = &server_name {
                if entry.server != *f {
                    continue;
                }
            }
            let key = format!("{}/{}", entry.server, entry.name);
            views.push(ToolView {
                enabled: overrides.get(&key).copied().unwrap_or(true),
                server: entry.server,
                name: entry.name,
                description: entry.description,
            });
        }
    } else if let Some(cache) = cache::load_cache() {
        for (srv, tools) in cache.servers {
            if let Some(f) = &server_name {
                if srv != *f {
                    continue;
                }
            }
            for t in tools {
                let key = format!("{}/{}", srv, t.name);
                views.push(ToolView {
                    enabled: overrides.get(&key).copied().unwrap_or(true),
                    server: srv.clone(),
                    name: t.name,
                    description: t.description,
                });
            }
        }
    }

    views.sort_by(|a, b| a.server.cmp(&b.server).then(a.name.cmp(&b.name)));
    Ok(views)
}

/// Persist a per-tool enabled toggle. Disabled tools are hidden from
/// `tools/list` / `discover` and rejected at call time.
#[tauri::command]
pub async fn mcphub_set_tool_enabled(
    _state: tauri::State<'_, McpHubState>,
    server: String,
    tool: String,
    enabled: bool,
) -> Result<(), String> {
    config::set_tool_enabled_override(&server, &tool, enabled)
}

// ─── Logs & cache ────────────────────────────────────────────────────────────

/// Recent child-server logs (newest first). Reads the persisted log file
/// (which every entry is appended to, so it holds the full history across
/// restarts) and falls back to the live in-memory ring buffer if the file is
/// unavailable.
#[tauri::command]
pub async fn mcphub_recent_logs(
    state: tauri::State<'_, McpHubState>,
    server: Option<String>,
    level: Option<String>,
    limit: u32,
) -> Result<Vec<LogEntryView>, String> {
    let server_filter = server.as_deref();
    let level_filter = level.as_deref();

    let mut entries = read_log_file(limit, server_filter, level_filter);
    if entries.is_empty() {
        if let Some(proxy) = state.proxy() {
            entries = proxy
                .log_store()
                .recent(limit as usize, server_filter, level_filter, None)
                .await;
        }
    }

    Ok(entries
        .into_iter()
        .map(|e| LogEntryView {
            ts: e.ts_ms,
            level: normalize_level(&e.level),
            server: if e.server.is_empty() {
                None
            } else {
                Some(e.server)
            },
            message: e.message,
        })
        .collect())
}

/// Read the persisted JSON-lines log file, applying the tab's filters.
fn read_log_file(
    limit: u32,
    server: Option<&str>,
    level: Option<&str>,
) -> Vec<crate::mcphub::log_store::LogEntry> {
    let path = crate::mcphub::paths::logs_dir().join("mcphub.log");
    crate::mcphub::log_store::read_file_recent(&path, limit as usize, server, level)
}

/// (Re)discover tools from every enabled server and write schema-cache.json.
/// Works standalone — spins up a temporary ChildManager, collects tools, then
/// shuts it down. The running gateway (if any) picks up the new cache file via
/// its 2s watcher.
#[tauri::command]
pub async fn mcphub_regenerate_cache() -> Result<(), String> {
    let cfg = config::auto_detect();
    let log_store = Arc::new(LogStore::new());
    let manager = Arc::new(ChildManager::with_full_options(
        cfg.servers.clone(),
        cfg.idle_timeout_ms,
        cfg.request_timeout_secs,
        log_store,
    ));

    let mut servers: HashMap<String, Vec<ToolDef>> = HashMap::new();
    let mut errors: HashMap<String, String> = HashMap::new();
    let enabled: Vec<String> = cfg
        .servers
        .iter()
        .filter(|(_, sc)| sc.enabled)
        .map(|(n, _)| n.clone())
        .collect();

    for name in enabled {
        match manager.start_server(&name).await {
            Ok(tools) => {
                servers.insert(name, tools);
            }
            Err(e) => {
                eprintln!("[McpHub][ERROR] cache rebuild: '{}' failed: {}", name, e);
                errors.insert(name, e);
            }
        }
    }

    let total: usize = servers.values().map(|v| v.len()).sum();
    cache::save_cache_with_errors(&servers, &errors);
    manager.stop_all().await;
    eprintln!(
        "[McpHub] Cache regenerated: {} servers, {} tools, {} errors",
        servers.len(),
        total,
        errors.len()
    );
    Ok(())
}

// ─── Tokens ──────────────────────────────────────────────────────────────────

/// List all API tokens (SSE client auth). Independent of gateway state.
#[tauri::command]
pub async fn mcphub_list_tokens() -> Result<Vec<TokenView>, String> {
    let store = auth::load_tokens();
    let mut views: Vec<TokenView> = store
        .tokens
        .into_iter()
        .map(|(token, entry)| TokenView {
            token,
            name: entry.name,
            allowed_servers: entry.allowed_servers,
            // auth.rs stores epoch seconds; the frontend treats created_at as
            // epoch milliseconds (see the mock), so convert here.
            created_at: entry.created_at * 1000,
        })
        .collect();
    views.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(views)
}

/// Create a new named token and return its opaque string.
#[tauri::command]
pub async fn mcphub_create_token(
    name: String,
    allowed_servers: Option<Vec<String>>,
) -> Result<serde_json::Value, String> {
    if name.trim().is_empty() {
        return Err("token name is required".into());
    }
    let token = auth::create_token(&name, allowed_servers);
    Ok(serde_json::json!({ "token": token }))
}

/// Revoke an existing token by its opaque string.
#[tauri::command]
pub async fn mcphub_revoke_token(token: String) -> Result<(), String> {
    if !auth::revoke_token(&token) {
        return Err("token not found".into());
    }
    Ok(())
}

// ─── Endpoint ─────────────────────────────────────────────────────────────────

/// SSE endpoint info for connecting external clients (Cursor / Claude Desktop).
#[tauri::command]
pub async fn mcphub_endpoint_info(
    state: tauri::State<'_, McpHubState>,
) -> Result<EndpointInfo, String> {
    let port = state.port().unwrap_or(DEFAULT_SSE_PORT);
    Ok(EndpointInfo {
        sse_url: format!("http://127.0.0.1:{}/sse", port),
        // Tauri drives the gateway via SSE only; stdio transport is not exposed.
        stdio_available: false,
    })
}
