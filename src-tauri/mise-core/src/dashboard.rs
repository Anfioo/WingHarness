// Adapted from mise_gui (https://github.com/likaia/mise_gui), MIT License.
// See ../UPSTREAM.md for the porting record.

//! The overview tab's single payload: the runtime probe, the machine's system
//! information, tool and project counts, environment signals and the newest
//! history entries.
//!
//! Every block degrades on its own. A missing mise binary still produces a
//! dashboard with zero counts and a notice; a failed `mise env` turns its
//! signal into a warning instead of failing the command.

use std::collections::BTreeSet;
use std::path::Path;
use std::time::Duration;

use serde_json::Value;
use sysinfo::{Disks, System};

use crate::error::{MiseError, MiseResult};
use crate::models::{
    MiseDashboard, MiseEnvironmentSignal, MiseHealthLevel, MiseNotice, MiseNoticeCode,
    MiseProjectSummary, MiseRuntimeInfo, MiseSignalCode, MiseSystemInfo, MiseToolSummaryCounts,
    MiseVersionInfo,
};
use crate::{history, paths, process, projects, runtime, tools};

const QUERY_TIMEOUT: Duration = Duration::from_secs(30);
const RECENT_HISTORY: usize = 3;

/// Aggregate the runtime probe, system information, tool and project counts,
/// environment signals and the newest history entries for the overview tab.
pub async fn load_dashboard(app: &tauri::AppHandle) -> MiseResult<MiseDashboard> {
    // System collection is slow and local; start it before the mise calls.
    let system_task = tokio::task::spawn_blocking(collect_system_info);

    let runtime_info = match runtime::probe_runtime().await {
        Ok(info) => info,
        Err(error) => {
            log::warn!("mise_dashboard_runtime_probe_failed error={error}");
            unavailable_runtime(&error)
        }
    };

    let mut notices = Vec::new();

    let tool_summary = match tools::list_tools().await {
        Ok(list) => MiseToolSummaryCounts {
            installed_tool_count: list.len(),
            active_tool_count: list
                .iter()
                .filter(|tool| tool.installed_versions.iter().any(|version| version.active))
                .count(),
        },
        Err(error) => {
            log::warn!("mise_dashboard_tool_summary_failed error={error}");
            notices.push(MiseNotice {
                code: MiseNoticeCode::Other,
                level: MiseHealthLevel::Warning,
                detail: Some(error.message),
                command: Some("mise ls --json".to_string()),
            });
            MiseToolSummaryCounts::default()
        }
    };

    let project_summary = match projects::scan_projects(app).await {
        Ok(coverage) => MiseProjectSummary {
            project_count: coverage.projects.len(),
            declared_tool_count: coverage
                .projects
                .iter()
                .map(|project| project.declared_tool_count)
                .sum(),
            override_project_count: coverage
                .projects
                .iter()
                .filter(|project| project.override_count > 0)
                .count(),
            override_binding_count: coverage
                .projects
                .iter()
                .map(|project| project.override_count)
                .sum(),
        },
        Err(error) => {
            log::warn!("mise_dashboard_project_summary_failed error={error}");
            notices.push(MiseNotice {
                code: MiseNoticeCode::Other,
                level: MiseHealthLevel::Warning,
                detail: Some(error.message),
                command: Some("mise ls --json".to_string()),
            });
            MiseProjectSummary::default()
        }
    };

    let (current, environment, settings) = tokio::join!(
        run_text(&["current"]),
        run_json(&["env", "-J"]),
        run_json(&["settings", "ls", "--json-extended"]),
    );

    let signals = vec![
        runtime_signal(&runtime_info),
        active_tools_signal(current),
        path_export_signal(environment.as_ref()),
        java_home_signal(environment.as_ref()),
        config_source_signal(settings.as_ref()),
    ];

    if !runtime_info.available {
        notices.push(MiseNotice {
            code: MiseNoticeCode::Other,
            level: MiseHealthLevel::Warning,
            detail: runtime_info.detail.clone(),
            command: Some(runtime_info.install_hint.clone()),
        });
    }

    let remaining_history = match history::list(RECENT_HISTORY) {
        Ok(entries) => entries,
        Err(error) => {
            log::warn!("mise_dashboard_history_failed error={error}");
            Vec::new()
        }
    };

    let system = system_task.await.unwrap_or_default();

    Ok(MiseDashboard {
        version_info: MiseVersionInfo {
            version: runtime_info.version.clone(),
            executable: runtime_info.executable.clone(),
            source: runtime_info.source,
        },
        runtime: runtime_info,
        system,
        tool_summary,
        project_summary,
        signals,
        recent_history: remaining_history,
        notices,
    })
}

/// A probe failure still shows an instal guidance instead of failing the page.
fn unavailable_runtime(error: &MiseError) -> MiseRuntimeInfo {
    MiseRuntimeInfo {
        available: false,
        executable: None,
        version: None,
        source: None,
        install_hint: install_hint().to_string(),
        detail: Some(error.message.clone()),
        shims: None,
    }
}

fn install_hint() -> &'static str {
    if cfg!(target_os = "windows") {
        "winget install jdx.mise"
    } else if cfg!(target_os = "macos") {
        "brew install mise"
    } else {
        "curl https://mise.run | sh"
    }
}

async fn run_text(args: &[&str]) -> MiseResult<String> {
    let owned: Vec<String> = args.iter().map(|argument| argument.to_string()).collect();
    let result = process::run_command(&owned, None, QUERY_TIMEOUT, true, None, None).await?;
    Ok(result.stdout)
}

async fn run_json(args: &[&str]) -> MiseResult<Value> {
    let stdout = run_text(args).await?;
    serde_json::from_str(&stdout).map_err(|error| {
        log::warn!(
            "mise_dashboard_command_parse_failed command={} error={error}",
            args.join(" ")
        );
        MiseError::internal("The mise command returned data that could not be parsed.")
    })
}

fn runtime_signal(runtime_info: &MiseRuntimeInfo) -> MiseEnvironmentSignal {
    MiseEnvironmentSignal {
        code: MiseSignalCode::Runtime,
        level: if runtime_info.available {
            MiseHealthLevel::Healthy
        } else {
            MiseHealthLevel::Critical
        },
        value: runtime_info
            .version
            .clone()
            .unwrap_or_else(|| "missing".to_string()),
        detail: runtime_info
            .detail
            .clone()
            .or_else(|| runtime_info.executable.clone()),
    }
}

fn active_tools_signal(current: MiseResult<String>) -> MiseEnvironmentSignal {
    match current {
        Ok(output) => {
            let lines: Vec<&str> = output
                .lines()
                .map(str::trim)
                .filter(|line| !line.is_empty())
                .collect();
            let summary = lines
                .iter()
                .filter_map(|line| {
                    let mut parts = line.split_whitespace();
                    match (parts.next(), parts.next()) {
                        (Some(tool), Some(version)) => Some(format!("{tool} {version}")),
                        _ => None,
                    }
                })
                .collect::<Vec<_>>()
                .join(" / ");

            MiseEnvironmentSignal {
                code: MiseSignalCode::ActiveTools,
                level: if lines.is_empty() {
                    MiseHealthLevel::Warning
                } else {
                    MiseHealthLevel::Healthy
                },
                value: format!("{} active", lines.len()),
                detail: if summary.is_empty() {
                    Some("No tool is active in the current directory.".to_string())
                } else {
                    Some(summary)
                },
            }
        }
        Err(error) => warning_signal(MiseSignalCode::ActiveTools, "unavailable", &error),
    }
}

fn path_export_signal(environment: Result<&Value, &MiseError>) -> MiseEnvironmentSignal {
    match environment {
        Ok(value) => {
            let path = value
                .get("PATH")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let count = split_path_entries(path)
                .into_iter()
                .filter(|entry| is_mise_install_entry(entry))
                .count();

            MiseEnvironmentSignal {
                code: MiseSignalCode::PathExport,
                level: if count == 0 {
                    MiseHealthLevel::Warning
                } else {
                    MiseHealthLevel::Healthy
                },
                value: format!("{count} segments"),
                detail: Some(if count == 0 {
                    "mise env -J exports no install directory; tool resolution may be unstable."
                        .to_string()
                } else {
                    format!("The exported PATH contains {count} mise install directories.")
                }),
            }
        }
        Err(error) => warning_signal(MiseSignalCode::PathExport, "unavailable", error),
    }
}

fn java_home_signal(environment: Result<&Value, &MiseError>) -> MiseEnvironmentSignal {
    match environment {
        Ok(value) => {
            let java_home = value
                .get("JAVA_HOME")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|path| !path.is_empty());

            MiseEnvironmentSignal {
                code: MiseSignalCode::JavaHome,
                level: if java_home.is_some() {
                    MiseHealthLevel::Healthy
                } else {
                    MiseHealthLevel::Warning
                },
                value: if java_home.is_some() {
                    "exported".to_string()
                } else {
                    "missing".to_string()
                },
                detail: java_home.map(str::to_string).or_else(|| {
                    Some("JAVA_HOME is not exported for mise-managed Java.".to_string())
                }),
            }
        }
        Err(error) => warning_signal(MiseSignalCode::JavaHome, "unavailable", error),
    }
}

fn config_source_signal(settings: Result<&Value, &MiseError>) -> MiseEnvironmentSignal {
    match settings {
        Ok(value) => {
            let mut sources = BTreeSet::new();
            collect_setting_sources(value, &mut sources);

            MiseEnvironmentSignal {
                code: MiseSignalCode::ConfigSource,
                level: MiseHealthLevel::Info,
                value: if sources.is_empty() {
                    "none".to_string()
                } else {
                    "detected".to_string()
                },
                detail: Some(if sources.is_empty() {
                    "No explicit setting source was reported.".to_string()
                } else {
                    sources.into_iter().collect::<Vec<_>>().join(" / ")
                }),
            }
        }
        Err(error) => warning_signal(MiseSignalCode::ConfigSource, "unavailable", error),
    }
}

fn warning_signal(code: MiseSignalCode, value: &str, error: &MiseError) -> MiseEnvironmentSignal {
    MiseEnvironmentSignal {
        code,
        level: MiseHealthLevel::Warning,
        value: value.to_string(),
        detail: Some(error.message.clone()),
    }
}

/// Every `source` string anywhere in the settings document.
fn collect_setting_sources(value: &Value, sources: &mut BTreeSet<String>) {
    match value {
        Value::Object(map) => {
            if let Some(source) = map.get("source").and_then(Value::as_str) {
                let trimmed = source.trim();
                if !trimmed.is_empty() {
                    sources.insert(trimmed.to_string());
                }
            }
            for child in map.values() {
                collect_setting_sources(child, sources);
            }
        }
        Value::Array(items) => {
            for child in items {
                collect_setting_sources(child, sources);
            }
        }
        _ => {}
    }
}

fn split_path_entries(path: &str) -> Vec<&str> {
    let separator = if cfg!(windows) { ';' } else { ':' };
    path.split(separator)
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .collect()
}

fn is_mise_install_entry(entry: &str) -> bool {
    let normalized = entry.replace('\\', "/").to_ascii_lowercase();
    normalized.contains("/mise/installs/")
}

/// OS, CPU, memory and disk details. Each field is optional: a machine that
/// hides one of them still gets the rest.
fn collect_system_info() -> MiseSystemInfo {
    let home = paths::home_dir();
    let mut info = MiseSystemInfo {
        os_name: clean_value(System::name()),
        os_version: clean_value(System::os_version()),
        kernel_version: clean_value(System::kernel_version()),
        host_name: clean_value(System::host_name()),
        arch: System::cpu_arch(),
        ..MiseSystemInfo::default()
    };

    match System::new() {
        Ok(mut system) => {
            system.refresh_memory();
            system.refresh_cpu_all();
            info.cpu_count = system.cpus().len();
            info.cpu_brand = system
                .cpus()
                .first()
                .map(|cpu| cpu.brand().trim().to_string())
                .filter(|brand| !brand.is_empty());
            info.memory_total_bytes = system.total_memory();
            info.memory_available_bytes = system.available_memory();
        }
        Err(error) => log::warn!("mise_system_info_failed error={error}"),
    }

    let (disk_total, disk_available, disk_mount) = disk_info(home.as_deref());
    info.disk_total_bytes = disk_total;
    info.disk_available_bytes = disk_available;
    info.disk_mount = disk_mount;
    info
}

fn clean_value(value: Result<String, impl std::fmt::Display>) -> Option<String> {
    value
        .ok()
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty())
}

/// The disk holding the home directory, or the first one when no mount point
/// contains it.
fn disk_info(home: Option<&Path>) -> (Option<u64>, Option<u64>, Option<String>) {
    let Ok(disks) = Disks::new_with_refreshed_list() else {
        return (None, None, None);
    };

    let selected = home
        .and_then(|home| {
            let home_path = normalize_mount(home);
            disks
                .iter()
                .filter(|disk| {
                    let mount = normalize_mount(disk.mount_point());
                    !mount.is_empty() && home_path.starts_with(&mount)
                })
                .max_by_key(|disk| normalize_mount(disk.mount_point()).len())
        })
        .or_else(|| disks.iter().next());

    match selected {
        Some(disk) => (
            Some(disk.total_space()),
            Some(disk.available_space()),
            Some(disk.mount_point().to_string_lossy().into_owned()),
        ),
        None => (None, None, None),
    }
}

fn normalize_mount(path: &Path) -> String {
    let mut text = path
        .to_string_lossy()
        .replace('\\', "/")
        .to_ascii_lowercase();
    while text.len() > 1 && text.ends_with('/') {
        text.pop();
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::MiseError;

    fn error() -> MiseError {
        MiseError::internal("boom")
    }

    #[test]
    fn an_available_runtime_reports_its_version() {
        let info = MiseRuntimeInfo {
            available: true,
            executable: Some("C:/mise.exe".to_string()),
            version: Some("2026.11.10".to_string()),
            source: None,
            install_hint: String::new(),
            detail: None,
            shims: None,
        };
        let signal = runtime_signal(&info);
        assert_eq!(signal.level, MiseHealthLevel::Healthy);
        assert_eq!(signal.value, "2026.11.10");
    }

    #[test]
    fn a_missing_runtime_says_missing() {
        let info = MiseRuntimeInfo {
            available: false,
            executable: None,
            version: None,
            source: None,
            install_hint: "winget install jdx.mise".to_string(),
            detail: None,
            shims: None,
        };
        let signal = runtime_signal(&info);
        assert_eq!(signal.level, MiseHealthLevel::Critical);
        assert_eq!(signal.value, "missing");
    }

    #[test]
    fn active_tools_are_counted_and_joined() {
        let signal = active_tools_signal(Ok("node 26.13.1\npython 3.12.4\n".to_string()));
        assert_eq!(signal.level, MiseHealthLevel::Healthy);
        assert_eq!(signal.value, "2 active");
        assert_eq!(
            signal.detail.as_deref(),
            Some("node 26.13.1 / python 3.12.4")
        );
    }

    #[test]
    fn an_empty_active_list_is_a_warning() {
        let signal = active_tools_signal(Ok(String::new()));
        assert_eq!(signal.level, MiseHealthLevel::Warning);
        assert_eq!(signal.value, "0 active");
    }

    #[test]
    fn a_failed_command_becomes_a_warning_signal() {
        let signal = active_tools_signal(Err(error()));
        assert_eq!(signal.level, MiseHealthLevel::Warning);
        assert_eq!(signal.detail.as_deref(), Some("boom"));
    }

    #[test]
    fn mise_install_entries_are_counted() {
        let value = serde_json::json!({
            "PATH": "C:\\Users\\me\\AppData\\Local\\mise\\installs\\node\\26;C:\\Windows;/home/me/.local/share/mise/installs/python/3.12;/usr/bin"
        });
        let signal = path_export_signal(Ok(&value));
        assert_eq!(signal.value, "2 segments");
        assert_eq!(signal.level, MiseHealthLevel::Healthy);
    }

    #[test]
    fn an_empty_install_path_is_a_warning() {
        let value = serde_json::json!({ "PATH": "/usr/bin:/bin" });
        let signal = path_export_signal(Ok(&value));
        assert_eq!(signal.level, MiseHealthLevel::Warning);
    }

    #[test]
    fn java_home_is_reported_when_exported() {
        let value = serde_json::json!({ "JAVA_HOME": "C:\\Java\\21" });
        let signal = java_home_signal(Ok(&value));
        assert_eq!(signal.value, "exported");
        assert_eq!(signal.detail.as_deref(), Some("C:\\Java\\21"));
    }

    #[test]
    fn a_missing_java_home_is_a_warning() {
        let value = serde_json::json!({ "JAVA_HOME": "" });
        let signal = java_home_signal(Ok(&value));
        assert_eq!(signal.level, MiseHealthLevel::Warning);
        assert_eq!(signal.value, "missing");
    }

    #[test]
    fn setting_sources_are_collected_recursively() {
        let value = serde_json::json!({
            "node": { "mirror_url": { "source": "C:\\Users\\me\\.config\\mise\\config.toml" } },
            "python": { "source": "C:\\Users\\me\\.config\\mise\\config.toml" }
        });
        let signal = config_source_signal(Ok(&value));
        assert_eq!(signal.value, "detected");
        assert_eq!(
            signal.detail.as_deref(),
            Some("C:\\Users\\me\\.config\\mise\\config.toml")
        );
    }

    #[test]
    fn no_settings_sources_is_not_an_error() {
        let value = serde_json::json!({});
        let signal = config_source_signal(Ok(&value));
        assert_eq!(signal.value, "none");
        assert_eq!(signal.level, MiseHealthLevel::Info);
    }

    #[test]
    fn a_probe_failure_still_returns_an_install_hint() {
        let info = unavailable_runtime(&error());
        assert!(!info.available);
        assert!(!info.install_hint.is_empty());
    }
}
