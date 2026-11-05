//! Opens a working copy in an external program (Explorer / VS Code / a terminal).
//!
//! Nothing here goes through `svn`: these are plain process launches, and on
//! Windows they must not flash a console window (see [`crate::proc`]).

use std::env;
use std::path::PathBuf;

use tokio::process::Command;

use crate::error::SvnError;
use crate::models::OpenTarget;
use crate::unversioned::resolve_workspace_child;

/// Launch a detached helper process, hiding its console on Windows. We never
/// wait: the program is the user's, and the app only needs it to have started.
fn spawn(mut command: Command) -> Result<(), SvnError> {
    crate::proc::hide_console(&mut command);
    command
        .spawn()
        .map(|_| ())
        .map_err(|error| SvnError::CommandFailed(format!("failed to open the working copy: {error}")))
}

/// Open the working copy itself in `target`.
pub async fn open_target(path: &str, target: OpenTarget) -> Result<(), SvnError> {
    match target {
        OpenTarget::Explorer => open_file_manager(path),
        OpenTarget::Vscode => {
            let mut code_command = Command::new("code");
            code_command.arg(path);
            if spawn(code_command).is_ok() {
                return Ok(());
            }

            for executable in vscode_candidates() {
                let mut command = Command::new(executable);
                command.arg(path);
                if spawn(command).is_ok() {
                    return Ok(());
                }
            }

            #[cfg(target_os = "macos")]
            {
                let mut command = Command::new("open");
                command.args(["-a", "Visual Studio Code", path]);
                if spawn(command).is_ok() {
                    return Ok(());
                }
            }

            Err(SvnError::CommandFailed(
                "failed to open the working copy: the VS Code executable was not found".to_string(),
            ))
        }
        OpenTarget::Terminal => open_terminal(path),
    }
}

fn open_file_manager(path: &str) -> Result<(), SvnError> {
    #[cfg(target_os = "windows")]
    let mut command = Command::new("explorer");
    #[cfg(target_os = "macos")]
    let mut command = Command::new("open");
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    let mut command = Command::new("xdg-open");

    command.arg(path);
    spawn(command)
}

/// Reveal one file inside the working copy in the platform file manager.
pub async fn reveal(workspace: &str, file: &str) -> Result<(), SvnError> {
    let workspace = std::fs::canonicalize(workspace).map_err(|error| {
        SvnError::InvalidArguments(format!("invalid working copy path: {error}"))
    })?;
    let target = resolve_workspace_child(&workspace, file)?;

    #[cfg(target_os = "windows")]
    {
        let reveal_target = if target.exists() {
            target
        } else {
            target.parent().unwrap_or(&workspace).to_path_buf()
        };
        let mut command = Command::new("explorer");
        if reveal_target.is_file() {
            command.arg(format!("/select,{}", reveal_target.display()));
        } else {
            command.arg(reveal_target);
        }
        return spawn(command);
    }

    #[cfg(target_os = "macos")]
    {
        let mut command = Command::new("open");
        if target.exists() {
            command.arg("-R").arg(target);
        } else {
            command.arg(target.parent().unwrap_or(&workspace));
        }
        return spawn(command);
    }

    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        let directory = if target.is_dir() {
            target.as_path()
        } else {
            target.parent().unwrap_or(&workspace)
        };
        let mut command = Command::new("xdg-open");
        command.arg(directory);
        spawn(command)
    }
}

/// The known install locations of VS Code, tried when the bare `code` name does
/// not resolve (Windows resolves only `.exe` against PATH, so `.cmd` shims are
/// invisible to a bare-name launch).
fn vscode_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    if let Ok(local_app_data) = env::var("LOCALAPPDATA") {
        candidates
            .push(PathBuf::from(&local_app_data).join("Programs\\Microsoft VS Code\\Code.exe"));
        candidates.push(
            PathBuf::from(&local_app_data)
                .join("Programs\\Microsoft VS Code Insiders\\Code - Insiders.exe"),
        );
    }

    if let Ok(program_files) = env::var("ProgramFiles") {
        candidates.push(PathBuf::from(&program_files).join("Microsoft VS Code\\Code.exe"));
        candidates.push(
            PathBuf::from(&program_files).join("Microsoft VS Code Insiders\\Code - Insiders.exe"),
        );
    }

    if let Ok(program_files_x86) = env::var("ProgramFiles(x86)") {
        candidates.push(PathBuf::from(&program_files_x86).join("Microsoft VS Code\\Code.exe"));
        candidates.push(
            PathBuf::from(&program_files_x86)
                .join("Microsoft VS Code Insiders\\Code - Insiders.exe"),
        );
    }

    candidates
}

#[cfg(target_os = "windows")]
fn open_terminal(path: &str) -> Result<(), SvnError> {
    let workspace = PathBuf::from(path);
    let mut errors = Vec::new();

    let mut windows_terminal = Command::new("wt");
    windows_terminal.args(["-d", path]);
    match spawn(windows_terminal) {
        Ok(()) => return Ok(()),
        Err(error) => errors.push(format!("wt: {error}")),
    }

    let mut pwsh = Command::new("pwsh");
    pwsh.arg("-NoExit").current_dir(&workspace);
    match spawn(pwsh) {
        Ok(()) => return Ok(()),
        Err(error) => errors.push(format!("pwsh: {error}")),
    }

    let mut powershell = Command::new("powershell");
    powershell.arg("-NoExit").current_dir(&workspace);
    match spawn(powershell) {
        Ok(()) => return Ok(()),
        Err(error) => errors.push(format!("powershell: {error}")),
    }

    let mut cmd = Command::new("cmd");
    cmd.arg("/K").current_dir(&workspace);
    match spawn(cmd) {
        Ok(()) => Ok(()),
        Err(error) => {
            errors.push(format!("cmd: {error}"));
            Err(SvnError::CommandFailed(format!(
                "failed to open terminal: {}",
                errors.join("; ")
            )))
        }
    }
}

#[cfg(target_os = "macos")]
fn open_terminal(path: &str) -> Result<(), SvnError> {
    let mut command = Command::new("open");
    command.args(["-a", "Terminal", path]);
    spawn(command)
}

#[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
fn open_terminal(path: &str) -> Result<(), SvnError> {
    let candidates: [(&str, &[&str]); 4] = [
        ("x-terminal-emulator", &["--working-directory", path]),
        ("gnome-terminal", &["--working-directory", path]),
        ("konsole", &["--workdir", path]),
        ("xfce4-terminal", &["--working-directory", path]),
    ];
    let mut errors = Vec::new();
    for (executable, args) in candidates {
        let mut command = Command::new(executable);
        command.args(args);
        match spawn(command) {
            Ok(()) => return Ok(()),
            Err(error) => errors.push(format!("{executable}: {error}")),
        }
    }
    Err(SvnError::CommandFailed(format!(
        "failed to open terminal: {}",
        errors.join("; ")
    )))
}