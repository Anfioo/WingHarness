//! Runs the `svn` CLI.
//!
//! Everything the rest of the crate does goes through [`execute_svn`]: build an
//! argument vector, run `svn --non-interactive <args>` in the working copy, and
//! hand back stdout. The executable is configurable at runtime because a user
//! may have it somewhere `PATH` does not reach.

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{OnceLock, RwLock};
use std::time::Duration;

use tokio::process::Command;
use tokio::time::timeout;

use crate::error::SvnError;
use crate::proc;

/// Every call is bounded. `svn` talks to the network, so a hung server must not
/// pin a working copy's refresh forever.
pub const SVN_TIMEOUT: Duration = Duration::from_secs(120);

static SVN_EXECUTABLE: OnceLock<RwLock<PathBuf>> = OnceLock::new();

/// Point the engine at a specific `svn` binary (or `None` for the plain name
/// `svn`), verifying it runs before adopting it. Returns the version string the
/// binary reports, which the settings page shows as confirmation.
pub async fn configure_svn_executable(executable: Option<&str>) -> Result<String, SvnError> {
    let executable = normalize_svn_executable(executable);
    let version = execute_svn_inner(executable.clone(), &["--version", "--quiet"], None).await?;

    let mut configured = svn_executable_lock()
        .write()
        .map_err(|_| SvnError::CommandFailed("the svn executable lock is poisoned".to_string()))?;
    *configured = executable;
    Ok(version.trim().to_string())
}

/// Run `svn` with `args`, optionally inside `path` (`-C`-style: it becomes the
/// child's working directory, which is how the CLI scopes a target).
pub async fn execute_svn(args: &[&str], path: Option<&str>) -> Result<String, SvnError> {
    let executable = current_svn_executable()?;
    execute_svn_inner(executable, args, path).await
}

fn svn_executable_lock() -> &'static RwLock<PathBuf> {
    SVN_EXECUTABLE.get_or_init(|| RwLock::new(PathBuf::from("svn")))
}

fn normalize_svn_executable(executable: Option<&str>) -> PathBuf {
    executable
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("svn"))
}

/// The executable the engine will spawn. Shared with the status snapshot and
/// the USN reader, which fingerprint a working copy against it.
pub(crate) fn current_svn_executable() -> Result<PathBuf, SvnError> {
    svn_executable_lock()
        .read()
        .map(|path| path.clone())
        .map_err(|_| SvnError::CommandFailed("the svn executable lock is poisoned".to_string()))
}

/// `--non-interactive` goes first, before the subcommand, so no invocation can
/// block on a prompt (a credential prompt or an unknown-certificate question):
/// the whole app drives `svn` with no terminal attached.
fn build_command_args(args: &[String]) -> Vec<String> {
    let mut command_args = vec!["--non-interactive".to_string()];
    command_args.extend(args.iter().cloned());
    command_args
}

async fn execute_svn_inner(
    executable: PathBuf,
    args: &[&str],
    path: Option<&str>,
) -> Result<String, SvnError> {
    let args_vec: Vec<String> = args.iter().map(|arg| arg.to_string()).collect();
    let mut command = Command::new(&executable);
    command.args(build_command_args(&args_vec));
    // SVN converts paths and messages using the process locale. A desktop launch
    // may inherit no locale, an ASCII locale, or a non-UTF-8 locale even though
    // Rust hands the child UTF-8 arguments. Override LC_ALL for the child only
    // (it outranks LANG and LC_CTYPE) so its output comes back UTF-8 too.
    #[cfg(unix)]
    {
        #[cfg(target_os = "macos")]
        const SVN_LOCALE: &str = "en_US.UTF-8";
        #[cfg(not(target_os = "macos"))]
        const SVN_LOCALE: &str = "C.UTF-8";
        command.env("LC_ALL", SVN_LOCALE);
    }
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());
    // Dropping the output future on timeout kills the child instead of leaving
    // an `svn` process running. Tokio drains stdout and stderr concurrently.
    command.kill_on_drop(true);
    if let Some(path) = path {
        command.current_dir(path);
    }
    proc::hide_console(&mut command);

    collect_command_output(&mut command, SVN_TIMEOUT).await
}

async fn collect_command_output(
    command: &mut Command,
    deadline: Duration,
) -> Result<String, SvnError> {
    let output = timeout(deadline, command.output())
        .await
        .map_err(|_| SvnError::Timeout)?
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                SvnError::SvnNotFound
            } else {
                SvnError::CommandFailed(error.to_string())
            }
        })?;
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    if output.status.success() {
        Ok(stdout)
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(SvnError::CommandFailed(format!("{stdout}\n{stderr}")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    /// The engine overrides `LC_ALL` for the child so a desktop launch that
    /// inherits no locale, an ASCII locale, or a broken locale still gets UTF-8
    /// output. This re-enters the test binary once per parent locale to prove a
    /// working copy under a non-ASCII path survives the round trip.
    #[cfg(unix)]
    #[test]
    fn non_ascii_paths_work_without_a_utf8_parent_locale() {
        const CHILD_MARKER: &str = "SVNCORE_ENCODING_TEST_CHILD";
        if std::env::var_os(CHILD_MARKER).is_none() {
            for executable in ["svn", "svnadmin"] {
                if std::process::Command::new(executable)
                    .arg("--version")
                    .output()
                    .is_err()
                {
                    eprintln!("Skipping encoding regression test: {executable} is unavailable");
                    return;
                }
            }
            // Isolate parent locale changes from other tests running in parallel.
            for locale in [None, Some("C"), Some("invalid_SVNCORE_locale")] {
                let mut child = std::process::Command::new(std::env::current_exe().unwrap());
                child.args([
                    "--exact",
                    "svn_core::executor::tests::non_ascii_paths_work_without_a_utf8_parent_locale",
                    "--nocapture",
                ]);
                child.env(CHILD_MARKER, "1");
                for variable in ["LC_ALL", "LC_CTYPE", "LANG"] {
                    match locale {
                        Some(value) => {
                            child.env(variable, value);
                        }
                        None => {
                            child.env_remove(variable);
                        }
                    }
                }
                let output = child.output().unwrap();
                assert!(
                    output.status.success(),
                    "encoding regression failed with parent locale {locale:?}:
{}
{}",
                    String::from_utf8_lossy(&output.stdout),
                    String::from_utf8_lossy(&output.stderr)
                );
            }
            return;
        }

        let directory = std::env::temp_dir().join(format!(
            "svn-core-encoding-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        struct Cleanup(PathBuf);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        let _cleanup = Cleanup(directory.clone());
        let repository = directory.join("repository");
        let created = std::process::Command::new("svnadmin")
            .arg("create")
            .arg(&repository)
            .output()
            .unwrap();
        assert!(created.status.success());
        let url = format!("file://{}", repository.to_str().unwrap());
        let wc = directory.join("工作副本");
        let runtime = runtime();
        let run = |args: &[&str], path: Option<&str>| {
            runtime
                .block_on(execute_svn_inner(PathBuf::from("svn"), args, path))
                .unwrap()
        };
        run(&["checkout", &url, wc.to_str().unwrap()], None);
        std::fs::create_dir(wc.join("子目录")).unwrap();
        std::fs::write(wc.join("子目录/文件.xlsx"), "中文内容")
            .unwrap();
        run(&["add", "子目录"], Some(wc.to_str().unwrap()));
        run(
            &[
                "commit",
                "-m",
                "提交中文文件",
                "子目录/文件.xlsx",
                "子目录",
            ],
            Some(wc.to_str().unwrap()),
        );
        let log = run(&["log", "--xml", "-v", &url], None);
        assert!(log.contains("提交中文文件"));
        assert!(log.contains("/子目录/文件.xlsx"));
        let second_wc = directory.join("第二副本");
        run(
            &[
                "checkout",
                &format!("{url}/子目录"),
                second_wc.to_str().unwrap(),
            ],
            None,
        );
        assert_eq!(
            std::fs::read_to_string(second_wc.join("文件.xlsx")).unwrap(),
            "中文内容"
        );
    }

    fn runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("failed to build tokio runtime")
    }

    #[test]
    fn captures_svn_stdout() {
        let result = runtime().block_on(execute_svn(&["--version", "--quiet"], None));
        match result {
            Ok(output) => assert!(!output.trim().is_empty()),
            // A machine without `svn` is a supported state, not a test failure.
            Err(SvnError::SvnNotFound) => {}
            Err(error) => panic!("unexpected svn executor error: {error}"),
        }
    }

    #[cfg(unix)]
    #[test]
    fn drains_large_stdout_and_stderr_without_blocking() {
        let mut command = Command::new("sh");
        command.args([
            "-c",
            "i=0; while [ $i -lt 10000 ]; do echo output; echo error >&2; i=$((i+1)); done",
        ]);
        command.kill_on_drop(true);
        let output = runtime()
            .block_on(collect_command_output(&mut command, Duration::from_secs(10)))
            .unwrap();
        assert_eq!(output.lines().count(), 10000);
    }

    #[cfg(unix)]
    #[test]
    fn timeout_kills_the_child() {
        let mut command = Command::new("sh");
        command.args(["-c", "echo $$; exec sleep 10"]);
        command.kill_on_drop(true);
        // Spawn explicitly so the test can check the timed-out PID is gone.
        command.stdout(Stdio::piped());
        runtime().block_on(async {
            let child = command.spawn().unwrap();
            let pid = child.id().unwrap();
            assert!(timeout(Duration::from_millis(30), child.wait_with_output())
                .await
                .is_err());
            for _ in 0..100 {
                let alive = std::process::Command::new("kill")
                    .args(["-0", &pid.to_string()])
                    .output()
                    .unwrap()
                    .status
                    .success();
                if !alive {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            panic!("timed-out child is still alive");
        });
    }

    #[test]
    fn empty_executable_uses_default_command() {
        assert_eq!(normalize_svn_executable(Some("   ")), Path::new("svn"));
        assert_eq!(normalize_svn_executable(None), Path::new("svn"));
    }

    #[test]
    fn configured_executable_is_trimmed() {
        assert_eq!(
            normalize_svn_executable(Some("  C:\\Tools\\svn.exe  ")),
            Path::new("C:\\Tools\\svn.exe")
        );
    }

    #[test]
    fn global_options_precede_target_separator() {
        let args = vec![
            "diff".to_string(),
            "-c".to_string(),
            "12".to_string(),
            "--".to_string(),
            "https://example.test/repo/file@12".to_string(),
        ];
        assert_eq!(
            build_command_args(&args),
            [
                "--non-interactive",
                "diff",
                "-c",
                "12",
                "--",
                "https://example.test/repo/file@12"
            ]
        );
    }
}