//! Every command the Clash page calls.

use std::sync::{Arc, Mutex};

use clash_prism_extension::{
    ApplyOptions, CompileStats, PrismExtension, PrismStatus, TraceView,
};
use serde::Serialize;
use tauri::State;

use crate::connections::{self, ConnectionsView};
use crate::core::{self, CoreProbe, CoreStatus};
use crate::host::ClashHost;
use crate::ipinfo::{self, IpInfo};
use crate::logs::{self, LogsView};
use crate::metrics::{self, CoreMetrics};
use crate::profiles::{self, ClashProfile};
use crate::proxies::{self, ProxiesView};
use crate::routing::{self, RoutingRulesView};
use crate::rules::{self, RuleFileInfo, RuleGroups};
use crate::runtime::{self, RuntimeView};
use crate::settings;
use crate::sitecheck::{self, TestResult, TestSite};
use crate::store;
use crate::subscriptions::{self, Subscription};
use crate::sysproxy::{self, SysProxyStatus};
use crate::ClashState;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub root: String,
    pub prism_dir: String,
    pub profiles_dir: String,
    pub run_dir: String,
    pub active_profile: Option<String>,
    pub profiles: Vec<ClashProfile>,
    pub rules: Vec<RuleFileInfo>,
    pub groups: RuleGroups,
    pub core: CoreStatus,
    pub status: StatusView,
    pub output_ready: bool,
}

/// The engine's own status, in the wire casing the rest of the app uses.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusView {
    pub watching: bool,
    pub watching_count: usize,
    pub last_compile_time: Option<String>,
    pub last_compile_success: bool,
    pub patch_count: usize,
    pub script_count: usize,
    pub plugin_count: usize,
}

impl From<PrismStatus> for StatusView {
    fn from(status: PrismStatus) -> Self {
        Self {
            watching: status.watching,
            watching_count: status.watching_count,
            last_compile_time: status.last_compile_time,
            last_compile_success: status.last_compile_success,
            patch_count: status.patch_count,
            script_count: status.script_count,
            plugin_count: status.plugin_count,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsView {
    pub total_patches: usize,
    pub succeeded: usize,
    pub skipped: usize,
    pub total_added: usize,
    pub total_removed: usize,
    pub total_modified: usize,
    pub total_duration_us: u64,
    pub avg_duration_us: u64,
}

impl From<CompileStats> for StatsView {
    fn from(stats: CompileStats) -> Self {
        Self {
            total_patches: stats.total_patches,
            succeeded: stats.succeeded,
            skipped: stats.skipped,
            total_added: stats.total_added,
            total_removed: stats.total_removed,
            total_modified: stats.total_modified,
            total_duration_us: stats.total_duration_us,
            avg_duration_us: stats.avg_duration_us,
        }
    }
}

/// One row of the compile report.
///
/// The engine's `TraceView` carries the same data nested under `summary` and
/// `diff`; flattening it keeps the page's table flat and the wire convention
/// camelCase throughout.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceEntry {
    pub patch_id: String,
    pub source_file: Option<String>,
    pub op_name: String,
    pub duration_us: u64,
    pub condition_matched: bool,
    pub added: usize,
    pub removed: usize,
    pub modified: usize,
    pub total_before: usize,
    pub total_after: usize,
    pub diff_added: Vec<String>,
    pub diff_removed: Vec<String>,
}

impl From<TraceView> for TraceEntry {
    fn from(view: TraceView) -> Self {
        Self {
            patch_id: view.patch_id,
            source_file: view.source_file,
            op_name: view.op_name,
            duration_us: view.duration_us,
            condition_matched: view.condition_matched,
            added: view.summary.added,
            removed: view.summary.removed,
            modified: view.summary.modified,
            total_before: view.summary.total_before,
            total_after: view.summary.total_after,
            diff_added: view.diff.added,
            diff_removed: view.diff.removed,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompileView {
    pub output: String,
    pub stats: StatsView,
    pub trace: Vec<TraceEntry>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyView {
    pub output: String,
    pub stats: StatsView,
    pub trace: Vec<TraceEntry>,
    pub message: String,
    pub hot_reload: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidateView {
    pub valid: bool,
    pub output: String,
}

// ── Overview ────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn clash_summary(state: State<'_, ClashState>) -> Result<Summary, String> {
    let status = state.compiler().status();

    Ok(Summary {
        root: path_string(store::root()?),
        prism_dir: path_string(store::prism_dir()?),
        profiles_dir: path_string(store::profiles_dir()?),
        run_dir: path_string(store::run_dir()?),
        active_profile: profiles::active_id()?,
        profiles: profiles::list()?,
        rules: rules::list()?,
        groups: rules::read_groups()?,
        core: core::status(&state.core),
        status: status.into(),
        output_ready: store::run_config_path()?.is_file(),
    })
}

#[tauri::command]
pub fn clash_status(state: State<'_, ClashState>) -> Result<StatusView, String> {
    let status = state.compiler().status();
    Ok(status.into())
}

// ── Profiles ────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn clash_profile_list() -> Result<Vec<ClashProfile>, String> {
    profiles::list()
}

#[tauri::command]
pub fn clash_profile_read(id: String) -> Result<String, String> {
    profiles::read(&id)
}

#[tauri::command]
pub fn clash_profile_write(id: String, content: String) -> Result<(), String> {
    profiles::write(&id, &content)
}

#[tauri::command]
pub fn clash_profile_create(name: String) -> Result<String, String> {
    profiles::create(&name)
}

#[tauri::command]
pub fn clash_profile_delete(id: String) -> Result<(), String> {
    profiles::delete(&id)
}

#[tauri::command]
pub fn clash_profile_select(id: String) -> Result<(), String> {
    profiles::select(&id)
}

#[tauri::command]
pub fn clash_profile_import(path: String) -> Result<String, String> {
    profiles::import_file(&path)
}

// ── Prism rule files ────────────────────────────────────────────────────────

#[tauri::command]
pub fn clash_rule_list() -> Result<Vec<RuleFileInfo>, String> {
    rules::list()
}

#[tauri::command]
pub fn clash_rule_read(filename: String) -> Result<String, String> {
    rules::read(&filename)
}

#[tauri::command]
pub fn clash_rule_write(filename: String, content: String) -> Result<(), String> {
    rules::write(&filename, &content)
}

#[tauri::command]
pub fn clash_rule_create(name: String) -> Result<String, String> {
    rules::create(&name)
}

#[tauri::command]
pub fn clash_rule_delete(filename: String) -> Result<(), String> {
    rules::delete(&filename)
}

#[tauri::command]
pub fn clash_rule_rename(filename: String, new_name: String) -> Result<String, String> {
    rules::rename(&filename, &new_name)
}

#[tauri::command]
pub fn clash_rule_toggle(filename: String, enabled: bool) -> Result<bool, String> {
    rules::toggle(&filename, enabled)
}

/// Turn pasted Surge / Clash rule lines into a new patch file.
#[tauri::command]
pub fn clash_rule_import_text(name: String, content: String) -> Result<String, String> {
    rules::import_text(&name, &content)
}

#[tauri::command]
pub fn clash_group_list() -> Result<RuleGroups, String> {
    rules::read_groups()
}

#[tauri::command]
pub fn clash_group_save(groups: RuleGroups) -> Result<(), String> {
    rules::save_groups(&groups)
}

// ── Compile ─────────────────────────────────────────────────────────────────

/// Compile without touching the output file or the core.
#[tauri::command]
pub fn clash_preview(state: State<'_, ClashState>) -> Result<CompileView, String> {
    let captured = Arc::new(Mutex::new(None));
    let host = ClashHost::preview(state.app.clone(), captured.clone());
    let extension = PrismExtension::new(host);

    let result = extension.apply(ApplyOptions::default())?;
    let output = captured
        .lock()
        .ok()
        .and_then(|slot| slot.clone())
        .unwrap_or(result.output_config);
    // Show what apply would write, controller address included.
    let output = core::own_controller(&output)?;

    Ok(CompileView {
        output,
        stats: result.stats.into(),
        trace: result.trace.into_iter().map(TraceEntry::from).collect(),
    })
}

/// Compile, write `run/config.yaml`, and hot reload if a core is running.
#[tauri::command]
pub async fn clash_apply(state: State<'_, ClashState>, validate: bool) -> Result<ApplyView, String> {
    // Compiling writes files and hot-reloads through a blocking HTTP client.
    // That client cannot be created or dropped on an async worker: reqwest's
    // blocking entry point probes for a runtime there and tokio panics when the
    // shell runtime it builds is dropped back inside it. The blocking pool is
    // the one place this work may run.
    let compiler = state.inner().clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        if let Ok(mut slot) = compiler.validation.lock() {
            *slot = None;
        }
        // A panic inside the engine unwinds through the shared lock, which both
        // poisons it and leaves this command without a reply. Catch it so the UI
        // gets a failed apply it can retry; `compiler()` rebuilds for the retry.
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            compiler.compiler().apply(ApplyOptions {
                skip_disabled_patches: true,
                validate_output: validate,
            })
        }))
        .map_err(|_| "The compiler crashed and was reset; see clash/panic.log".to_string())?;

        // The engine refuses a rejected output with a fixed sentence that names
        // neither the rule nor the proxy at fault. The host kept what mihomo
        // actually said; append it so the page can show a fixable problem.
        result.map_err(|error| {
            match compiler.validation.lock().ok().and_then(|slot| slot.clone()) {
                Some(reason) => format!("{error}: {reason}"),
                None => error,
            }
        })
    })
    .await
    .map_err(|error| format!("Apply task failed: {error}"))??;

    let (message, hot_reload) = state
        .last_status
        .lock()
        .ok()
        .and_then(|slot| slot.clone())
        .map(|status| (status.message, status.hot_reload_success))
        .unwrap_or_else(|| ("Config written".to_string(), false));

    // A reload takes the mode from the file it just loaded, which is the
    // profile's own — the user's choice has to go back on top of it.
    if hot_reload {
        runtime::restore_saved_mode().await;
    }

    Ok(ApplyView {
        output: core::own_controller(&result.output_config)?,
        stats: result.stats.into(),
        trace: result.trace.into_iter().map(TraceEntry::from).collect(),
        message,
        hot_reload,
    })
}

#[tauri::command]
pub fn clash_output_read() -> Result<String, String> {
    let path = store::run_config_path()?;
    std::fs::read_to_string(&path).map_err(|e| format!("Failed to read compiled output: {e}"))
}

// ── Core ────────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn clash_core_status(state: State<'_, ClashState>) -> Result<CoreStatus, String> {
    Ok(core::status(&state.core))
}

#[tauri::command]
pub async fn clash_core_start(state: State<'_, ClashState>) -> Result<u32, String> {
    let pid = core::start(&state.core)?;
    // The core starts in whatever mode its file names; the user's choice is what
    // should be in force, so it goes back on as soon as the controller answers.
    runtime::restore_saved_mode().await;
    // A profile change can move the mixed port, which would leave an enabled
    // system proxy pointing at a closed one. This also puts the proxy back on
    // when the user had it on before the last stop.
    if let Ok(view) = runtime::view().await {
        if let Some(port) = view.http_port {
            sysproxy::on_core_start(port);
        }
    }
    Ok(pid)
}

#[tauri::command]
pub async fn clash_core_stop(state: State<'_, ClashState>) -> Result<(), String> {
    // Killing and reaping the child blocks until the process is gone. On the
    // main thread that freezes the webview, which is why the tray popup showed
    // no "stopping" state at all; off the runtime it stays repaintable.
    let slot = state.core.clone();
    tauri::async_runtime::spawn_blocking(move || {
        // The system proxy must not outlive the port it names.
        let _ = sysproxy::disable();
        core::stop(&slot)
    })
    .await
    .map_err(|error| format!("Failed to stop the core: {error}"))?
}

#[tauri::command]
pub fn clash_core_validate(content: String) -> Result<ValidateView, String> {
    let (valid, output) = core::validate(&content)?;
    Ok(ValidateView { valid, output })
}

#[tauri::command]
pub fn clash_core_version() -> Result<CoreProbe, String> {
    Ok(core::probe())
}

/// Uptime and memory of the core process, read from the OS rather than the
/// controller: the home page asks for these every couple of seconds.
#[tauri::command]
pub fn clash_core_metrics(state: State<'_, ClashState>) -> CoreMetrics {
    metrics::read(&state.core)
}

/// The address the current proxy configuration exits from, as a geo lookup
/// service sees it. The request goes through the running core when there is one.
#[tauri::command]
pub async fn clash_ip_info() -> Result<IpInfo, String> {
    ipinfo::fetch().await
}

// ── Subscriptions ───────────────────────────────────────────────────────────

#[tauri::command]
pub fn clash_subscription_list() -> Result<Vec<Subscription>, String> {
    subscriptions::list()
}

#[tauri::command]
pub fn clash_subscription_add(name: String, url: String) -> Result<Subscription, String> {
    subscriptions::add(&name, &url)
}

#[tauri::command]
pub async fn clash_subscription_update(name: String) -> Result<Subscription, String> {
    subscriptions::update(&name).await
}

#[tauri::command]
pub fn clash_subscription_remove(name: String) -> Result<(), String> {
    subscriptions::remove(&name)
}

// ── Connections ─────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn clash_connections() -> Result<ConnectionsView, String> {
    connections::list().await
}

#[tauri::command]
pub async fn clash_connection_close(id: String) -> Result<(), String> {
    connections::close(&id).await
}

#[tauri::command]
pub async fn clash_connections_close_all() -> Result<(), String> {
    connections::close_all().await
}

// ── Proxies ─────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn clash_proxies() -> Result<ProxiesView, String> {
    proxies::list().await
}

#[tauri::command]
pub async fn clash_proxy_select(group: String, name: String) -> Result<(), String> {
    proxies::select(&group, &name).await
}

#[tauri::command]
pub async fn clash_proxy_delay(name: String) -> Result<u32, String> {
    proxies::delay_test(&name).await
}

// ── Routing rules ───────────────────────────────────────────────────────────

/// The rules the running core evaluates, in order, as it holds them now.
#[tauri::command]
pub async fn clash_rules() -> Result<RoutingRulesView, String> {
    routing::list().await
}

// ── Runtime ─────────────────────────────────────────────────────────────────

/// The core's routing mode and the ports it listens on, straight from the
/// controller — so the page shows what is actually in force, not what was asked
/// for.
#[tauri::command]
pub async fn clash_runtime() -> Result<RuntimeView, String> {
    runtime::view().await
}

#[tauri::command]
pub async fn clash_set_mode(mode: String) -> Result<(), String> {
    runtime::set_mode(&mode).await
}

#[tauri::command]
pub fn clash_sys_proxy() -> Result<SysProxyStatus, String> {
    Ok(sysproxy::status())
}

/// Point Windows at the core's mixed port, or stop pointing it there.
#[tauri::command]
pub async fn clash_sys_proxy_set(enabled: bool) -> Result<(), String> {
    if !enabled {
        sysproxy::disable()?;
        return settings::set_sys_proxy(false);
    }
    let view = runtime::view().await?;
    let port = view.http_port.ok_or_else(|| {
        "The core is not listening on an HTTP port; set mixed-port or port in the profile"
            .to_string()
    })?;
    sysproxy::enable(port)?;
    // Remembered only after Windows took the change, so the next core start
    // repeats something that actually worked.
    settings::set_sys_proxy(true)
}

// ── Logs ────────────────────────────────────────────────────────────────────

/// The last lines the core wrote, newest last.
#[tauri::command]
pub fn clash_logs(limit: Option<usize>) -> Result<LogsView, String> {
    logs::tail(limit.unwrap_or(300))
}

// ── Site tests ──────────────────────────────────────────────────────────────

/// The sites the test tab checks, or the defaults until the user edits them.
#[tauri::command]
pub fn clash_test_list() -> Result<Vec<TestSite>, String> {
    sitecheck::list()
}

/// Replace the saved list; the page owns the order and the identifiers.
#[tauri::command]
pub fn clash_test_save(sites: Vec<TestSite>) -> Result<(), String> {
    sitecheck::save(sites)
}

/// Fetch one site through the running core and report how long it took.
#[tauri::command]
pub async fn clash_test_url(url: String) -> Result<TestResult, String> {
    sitecheck::probe(&url).await
}

fn path_string(path: std::path::PathBuf) -> String {
    path.to_string_lossy().to_string()
}
