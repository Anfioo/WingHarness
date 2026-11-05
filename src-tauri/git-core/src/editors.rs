use std::path::Path;
use std::process::{Command, Stdio};

use serde::Serialize;

use crate::ai_cli::search_path;
use crate::error::{AppError, AppResult};
use crate::proc;

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EditorInfo {
    pub id: String,
    pub label: String,
    pub path: String,
    pub launch: String,
}

struct EditorSpec {
    id: &'static str,
    label: &'static str,
    bins: &'static [&'static str],
    app: Option<&'static str>,
    flatpak: Option<&'static str>,
}

const EDITORS: &[EditorSpec] = &[
    EditorSpec {
        id: "vscode",
        label: "Visual Studio Code",
        bins: &["code"],
        app: Some("Visual Studio Code"),
        flatpak: Some("com.visualstudio.code"),
    },
    EditorSpec {
        id: "vscode-insiders",
        label: "VS Code Insiders",
        bins: &["code-insiders"],
        app: Some("Visual Studio Code - Insiders"),
        flatpak: Some("com.visualstudio.code.insiders"),
    },
    EditorSpec {
        id: "cursor",
        label: "Cursor",
        bins: &["cursor"],
        app: Some("Cursor"),
        flatpak: None,
    },
    EditorSpec {
        id: "windsurf",
        label: "Windsurf",
        bins: &["windsurf"],
        app: Some("Windsurf"),
        flatpak: None,
    },
    EditorSpec {
        id: "zed",
        label: "Zed",
        bins: &["zed", "zeditor", "zed-editor"],
        app: Some("Zed"),
        flatpak: Some("dev.zed.Zed"),
    },
    EditorSpec {
        id: "sublime",
        label: "Sublime Text",
        bins: &["subl"],
        app: Some("Sublime Text"),
        flatpak: Some("com.sublimetext.three"),
    },
    EditorSpec {
        id: "idea",
        label: "IntelliJ IDEA",
        bins: &["idea"],
        app: Some("IntelliJ IDEA"),
        flatpak: None,
    },
    EditorSpec {
        id: "webstorm",
        label: "WebStorm",
        bins: &["webstorm"],
        app: Some("WebStorm"),
        flatpak: None,
    },
    EditorSpec {
        id: "pycharm",
        label: "PyCharm",
        bins: &["pycharm"],
        app: Some("PyCharm"),
        flatpak: None,
    },
    EditorSpec {
        id: "rider",
        label: "Rider",
        bins: &["rider"],
        app: Some("Rider"),
        flatpak: None,
    },
    EditorSpec {
        id: "fleet",
        label: "Fleet",
        bins: &["fleet"],
        app: Some("Fleet"),
        flatpak: None,
    },
    EditorSpec {
        id: "nova",
        label: "Nova",
        bins: &["nova"],
        app: Some("Nova"),
        flatpak: None,
    },
    EditorSpec {
        id: "xcode",
        label: "Xcode",
        bins: &["xed"],
        app: Some("Xcode"),
        flatpak: None,
    },
    EditorSpec {
        id: "gnome-builder",
        label: "GNOME Builder",
        bins: &["gnome-builder"],
        app: None,
        flatpak: Some("org.gnome.Builder"),
    },
    EditorSpec {
        id: "kate",
        label: "Kate",
        bins: &["kate"],
        app: None,
        flatpak: Some("org.kde.kate"),
    },
];

const LAUNCH_BINARY: &str = "binary";
const LAUNCH_APP: &str = "app";

pub fn detect() -> Vec<EditorInfo> {
    let mut dirs: Vec<std::path::PathBuf> = std::env::split_paths(&search_path(None)).collect();
    for dir in editor_dirs() {
        if !dirs.contains(&dir) {
            dirs.push(dir);
        }
    }
    let path_env = std::env::join_paths(dirs).unwrap_or_default();
    let cwd = std::env::current_dir().unwrap_or_else(|_| std::env::temp_dir());
    EDITORS
        .iter()
        .filter_map(|spec| locate(spec, &path_env, &cwd))
        .collect()
}

fn locate(spec: &EditorSpec, path_env: &std::ffi::OsStr, cwd: &Path) -> Option<EditorInfo> {
    for bin in spec.bins {
        if let Ok(path) = which::which_in(bin, Some(path_env), cwd) {
            return Some(info(spec, &path, LAUNCH_BINARY));
        }
    }
    #[cfg(target_os = "macos")]
    if let Some(app) = spec.app {
        for root in app_roots() {
            let bundle = root.join(format!("{app}.app"));
            if bundle.is_dir() {
                return Some(info(spec, &bundle, LAUNCH_APP));
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = spec.app;
    #[cfg(target_os = "linux")]
    if let Some(app_id) = spec.flatpak {
        for root in flatpak_export_roots() {
            let wrapper = root.join(app_id);
            if wrapper.is_file() {
                return Some(info(spec, &wrapper, LAUNCH_BINARY));
            }
        }
    }
    #[cfg(not(target_os = "linux"))]
    let _ = spec.flatpak;
    None
}

#[cfg(target_os = "linux")]
fn flatpak_export_roots() -> Vec<std::path::PathBuf> {
    let mut roots = vec![std::path::PathBuf::from("/var/lib/flatpak/exports/bin")];
    if let Some(home) = crate::ai_cli::home_dir() {
        roots.push(home.join(".local/share/flatpak/exports/bin"));
    }
    roots
}

fn editor_dirs() -> Vec<std::path::PathBuf> {
    let mut dirs = Vec::new();
    let home = crate::ai_cli::home_dir();
    #[cfg(windows)]
    {
        if let Some(local) = std::env::var_os("LOCALAPPDATA").map(std::path::PathBuf::from) {
            for rel in [
                "Programs\\Microsoft VS Code\\bin",
                "Programs\\Microsoft VS Code Insiders\\bin",
                "Programs\\cursor\\resources\\app\\bin",
                "Programs\\Windsurf\\bin",
                "Programs\\Zed",
                "JetBrains\\Toolbox\\scripts",
            ] {
                dirs.push(local.join(rel));
            }
        }
        if let Some(programs) = std::env::var_os("ProgramFiles").map(std::path::PathBuf::from) {
            dirs.push(programs.join("Microsoft VS Code\\bin"));
            dirs.push(programs.join("Sublime Text"));
        }
    }
    #[cfg(target_os = "macos")]
    if let Some(home) = &home {
        dirs.push(home.join("Library/Application Support/JetBrains/Toolbox/scripts"));
    }
    #[cfg(target_os = "linux")]
    {
        if let Some(home) = &home {
            dirs.push(home.join(".local/share/JetBrains/Toolbox/scripts"));
        }
        dirs.push(std::path::PathBuf::from("/opt/sublime_text"));
        dirs.push(std::path::PathBuf::from("/snap/bin"));
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    let _ = home;
    dirs
}

fn info(spec: &EditorSpec, path: &Path, launch: &str) -> EditorInfo {
    EditorInfo {
        id: spec.id.to_string(),
        label: spec.label.to_string(),
        path: path.to_string_lossy().into_owned(),
        launch: launch.to_string(),
    }
}

#[cfg(target_os = "macos")]
fn app_roots() -> Vec<std::path::PathBuf> {
    let mut roots = vec![std::path::PathBuf::from("/Applications")];
    if let Some(home) = crate::ai_cli::home_dir() {
        roots.push(home.join("Applications"));
    }
    roots
}

pub fn open(editor_id: &str, target: &str) -> AppResult<EditorInfo> {
    let editor = detect()
        .into_iter()
        .find(|editor| editor.id == editor_id)
        .ok_or_else(|| {
            AppError::other(format!(
                "{editor_id} is not installed on this machine any more — pick another editor in Settings → Git"
            ))
        })?;
    launch(&editor, Path::new(target))?;
    Ok(editor)
}

fn command_for(editor: &EditorInfo, target: &Path) -> Command {
    if editor.launch == LAUNCH_APP {
        let mut command = proc::hidden("open");
        command.arg("-a").arg(&editor.path).arg(target);
        command
    } else {
        let mut command = proc::hidden(&editor.path);
        command.arg(target);
        command
    }
}

fn launch(editor: &EditorInfo, target: &Path) -> AppResult<()> {
    let mut command = command_for(editor, target);
    command
        .env("PATH", search_path(Path::new(&editor.path).parent()))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    command.spawn()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn editor(path: &str, launch: &str) -> EditorInfo {
        EditorInfo {
            id: "test".into(),
            label: "Test".into(),
            path: path.into(),
            launch: launch.into(),
        }
    }

    #[test]
    fn editor_ids_and_binaries_are_unique() {
        let mut ids: Vec<&str> = EDITORS.iter().map(|spec| spec.id).collect();
        let all_bins: Vec<&str> = EDITORS
            .iter()
            .flat_map(|spec| spec.bins.iter().copied())
            .collect();
        let mut bins = all_bins.clone();
        ids.sort();
        bins.sort();
        ids.dedup();
        bins.dedup();
        assert_eq!(ids.len(), EDITORS.len());
        assert_eq!(bins.len(), all_bins.len());
        assert!(EDITORS.iter().all(|spec| !spec.bins.is_empty()));
    }

    #[test]
    fn editor_dirs_are_absolute() {
        assert!(editor_dirs().iter().all(|dir| dir.is_absolute()));
    }

    #[test]
    fn binary_editor_receives_the_target_as_its_only_argument() {
        let command = command_for(
            &editor("/usr/local/bin/code", LAUNCH_BINARY),
            Path::new("/repo"),
        );
        assert_eq!(command.get_program(), "/usr/local/bin/code");
        let args: Vec<_> = command.get_args().collect();
        assert_eq!(args, ["/repo"]);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn app_editor_goes_through_open() {
        let command = command_for(
            &editor("/Applications/Zed.app", LAUNCH_APP),
            Path::new("/repo"),
        );
        assert_eq!(command.get_program(), "open");
        let args: Vec<_> = command.get_args().collect();
        assert_eq!(args, ["-a", "/Applications/Zed.app", "/repo"]);
    }

    #[cfg(unix)]
    #[test]
    fn launch_runs_the_binary_with_the_target() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("angkorgit-editor-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let log = dir.join("launched.log");
        let script = dir.join("fake-editor");
        std::fs::write(
            &script,
            format!("#!/bin/sh\necho \"$@\" > '{}'\n", log.display()),
        )
        .unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        launch(
            &editor(script.to_str().unwrap(), LAUNCH_BINARY),
            Path::new("/some/repo"),
        )
        .unwrap();
        let mut waited = 0;
        while !log.exists() && waited < 60 {
            std::thread::sleep(std::time::Duration::from_millis(50));
            waited += 1;
        }
        assert_eq!(std::fs::read_to_string(&log).unwrap().trim(), "/some/repo");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
