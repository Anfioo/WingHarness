//! Application configuration commands.

use serde::Serialize;
use tauri::Manager;

use crate::config::{self, Config, ProxyMode};

/// One switch in the settings page's agent list.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentOptionView {
    pub id: String,
    pub name: String,
}

/// The configuration plus the context the settings UI needs to render it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigView {
    pub config: Config,
    /// Where the file lives, shown in the UI so it can be edited by hand.
    pub path: String,
    /// Directory everything is stored in right now.
    pub data_dir: String,
    /// Directory the pointer names, which a restart would switch to. Unset when
    /// the data directory is at its default.
    pub data_dir_configured: Option<String>,
    /// Directory used when no data directory is configured.
    pub data_dir_default: String,
    /// The pointer file, shown so it can be edited by hand.
    pub data_dir_pointer: String,
    /// Agents the AI config sync page can manage, in the registry's order.
    ///
    /// Read from the registry rather than a hard-coded list, so adding an agent
    /// to `shaic-core` makes a switch appear here without touching the UI.
    pub ai_agents: Vec<AgentOptionView>,
}

fn view() -> ConfigView {
    ConfigView {
        config: config::load(),
        path: config::path().display().to_string(),
        data_dir: config::dir().display().to_string(),
        data_dir_configured: config::configured_data_dir().map(|dir| dir.display().to_string()),
        data_dir_default: config::default_dir().display().to_string(),
        data_dir_pointer: config::pointer_path().display().to_string(),
        ai_agents: shaic_core::adapters::registry()
            .iter()
            .map(|agent| AgentOptionView {
                id: agent.id().as_str().to_string(),
                name: agent.display_name().to_string(),
            })
            .collect(),
    }
}

#[tauri::command]
pub fn get_config() -> ConfigView {
    view()
}

/// The proxy requests currently use, for pages that only display it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyStatusView {
    pub mode: ProxyMode,
    /// The address requests actually go through, when one is known.
    pub url: Option<String>,
    /// The bypass list exported as `NO_PROXY`.
    pub no_proxy: String,
}

/// Read-only proxy status for the moin settings tab.
///
/// The proxy is configured in Settings → Proxy; this only reports what that
/// setting resolves to, including the address read from Windows in system mode.
#[tauri::command]
pub fn proxy_status() -> ProxyStatusView {
    let proxy = config::load().proxy;
    let mode = proxy.resolved_mode();
    let url = match mode {
        ProxyMode::None => None,
        ProxyMode::Custom => {
            let url = proxy.url.trim();
            (!url.is_empty()).then(|| url.to_string())
        }
        ProxyMode::System => config::system_proxy_url(),
    };

    ProxyStatusView {
        mode,
        url,
        no_proxy: config::bypass_list(&proxy),
    }
}

/// Saves the configuration and returns the reloaded view.
///
/// The proxy is pushed into the process environment here as well: requests made
/// after this call use the new setting without a restart.
#[tauri::command]
pub fn save_config(app: tauri::AppHandle, config: Config) -> Result<ConfigView, String> {
    let previous_proxy = config::load().proxy;
    config::save(&config)?;
    // Read back rather than use the argument: `save` normalizes the values.
    let proxy = config::load().proxy;
    config::apply_proxy_env(&proxy);

    // The download engine captures the proxy when it builds its client, so a
    // mode/address change has to rebuild it. Other already-built clients still
    // need a restart, which the settings page says.
    if proxy != previous_proxy {
        if let Some(state) = app.try_state::<moin_core::MoinState>() {
            let state = state.inner().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(error) = state.refresh_network().await {
                    eprintln!("Could not rebuild the download client: {}", error.message);
                }
            });
        }
    }

    Ok(view())
}

/// Points the data directory at `dir`, or clears it when `None`.
///
/// Only the pointer file changes here: the running app keeps using the
/// directory it resolved at startup, so the change takes effect on the next
/// launch. That is deliberate — moving state out from under open log handles,
/// running plugins, and the config auto-save would split data across two roots.
#[tauri::command]
pub fn set_data_dir(dir: Option<String>) -> Result<ConfigView, String> {
    let target = dir
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .map(std::path::PathBuf::from);

    if let Some(path) = &target {
        if !path.is_absolute() {
            return Err(format!(
                "The data directory must be an absolute path: {}",
                path.display()
            ));
        }
    }

    config::write_pointer_at(&config::default_dir(), target.as_deref())?;
    Ok(view())
}
