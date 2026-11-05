//! `frpc --version` probing and version parsing.
//!
//! A probe runs the binary and reports what it said; nothing is persisted here.
//! Import and discovery both go through [`probe`], so the parsing rules live in
//! exactly one place.

use std::path::Path;
use std::process::Stdio;
use std::time::{Duration, Instant};

use crate::models::RuntimeProbe;
use crate::proc::hidden;

/// `frpc --version` must answer within this window or it is killed.
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(20);

/// The host platform, spelled the way runtime records store it.
pub fn platform() -> &'static str {
    std::env::consts::OS
}

/// The host CPU architecture, spelled the way runtime records store it.
pub fn architecture() -> &'static str {
    std::env::consts::ARCH
}

/// Run `frpc --version` and report what it printed.
///
/// A missing file, a directory, an unexecutable file, a timeout and a non-zero
/// exit all come back as `valid = false` with an English `error`; the caller
/// decides whether the output still looks like `frpc`.
pub fn probe(path: &str) -> RuntimeProbe {
    if path.trim().is_empty() {
        return failure(path, "No frpc path was given.");
    }

    let candidate = Path::new(path);
    if !candidate.exists() {
        return failure(path, "The file does not exist.");
    }
    if !candidate.is_file() {
        return failure(path, "The path is not a file.");
    }

    run(candidate)
}

/// Extract a version from `frpc --version` output.
///
/// Accepts the three shapes seen in the wild: `frpc version 0.69.0`,
/// `v0.68.1-custom` and a bare `0.70.1`. The leading `v` is dropped so records
/// compare numerically later. Text without a version returns `None`.
pub fn parse_version(output: &str) -> Option<String> {
    output.split_whitespace().find_map(version_token)
}

/// Whether output mentions frp at all.
///
/// A build whose banner does not match [`parse_version`] is still importable
/// when it says "frp"; its version is then recorded as unknown.
pub fn looks_like_frpc(output: &str) -> bool {
    output.to_ascii_lowercase().contains("frp")
}

fn version_token(word: &str) -> Option<String> {
    // Trim surrounding punctuation: "0.70.1," and "(v0.68.1)" both appear.
    let trimmed = word.trim_matches(|character: char| {
        !character.is_ascii_alphanumeric() && character != '.' && character != '-' && character != '+'
    });
    let candidate = trimmed
        .strip_prefix('v')
        .or_else(|| trimmed.strip_prefix('V'))
        .unwrap_or(trimmed);

    let mut segments = candidate.split('.');
    let major = segments.next()?;
    let minor = segments.next()?;
    if major.is_empty() || !major.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    if !minor.starts_with(|character: char| character.is_ascii_digit()) {
        return None;
    }
    let shaped = candidate
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '+' | '_'));
    shaped.then(|| candidate.to_string())
}

fn run(candidate: &Path) -> RuntimeProbe {
    let display = candidate.to_string_lossy().into_owned();

    let mut child = match hidden(candidate)
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(error) => {
            log::warn!("frp_runtime_probe_spawn_failed path={display} error={error}");
            return failure(&display, format!("The file could not be executed: {error}"));
        }
    };

    let deadline = Instant::now() + PROBE_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(50));
            }
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                log::warn!("frp_runtime_probe_timeout path={display}");
                return failure(
                    &display,
                    format!(
                        "frpc --version timed out after {} seconds.",
                        PROBE_TIMEOUT.as_secs()
                    ),
                );
            }
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                log::warn!("frp_runtime_probe_wait_failed path={display} error={error}");
                return failure(
                    &display,
                    format!("frpc --version could not be awaited: {error}"),
                );
            }
        }
    }

    let output = match child.wait_with_output() {
        Ok(output) => output,
        Err(error) => {
            log::warn!("frp_runtime_probe_output_failed path={display} error={error}");
            return failure(
                &display,
                format!("The frpc output could not be read: {error}"),
            );
        }
    };

    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    let raw_output = combine(&stdout, &stderr);
    let version = parse_version(&stdout).or_else(|| parse_version(&stderr));

    let error = if !output.status.success() {
        Some(format!(
            "frpc --version failed with exit code {:?}.",
            output.status.code()
        ))
    } else if version.is_none() {
        Some("No version could be parsed from the frpc output.".to_string())
    } else {
        None
    };

    RuntimeProbe {
        path: display,
        valid: output.status.success() && version.is_some(),
        version,
        platform: Some(platform().to_string()),
        architecture: Some(architecture().to_string()),
        raw_output: (!raw_output.is_empty()).then_some(raw_output),
        error,
    }
}

fn combine(stdout: &str, stderr: &str) -> String {
    let stdout = stdout.trim();
    let stderr = stderr.trim();
    match (stdout.is_empty(), stderr.is_empty()) {
        (false, false) => format!("{stdout}\n{stderr}"),
        (false, true) => stdout.to_string(),
        (true, false) => stderr.to_string(),
        (true, true) => String::new(),
    }
}

fn failure(path: &str, message: impl Into<String>) -> RuntimeProbe {
    RuntimeProbe {
        path: path.to_string(),
        valid: false,
        version: None,
        platform: None,
        architecture: None,
        raw_output: None,
        error: Some(message.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_banner_forms_in_the_wild() {
        assert_eq!(
            parse_version("frpc version 0.69.0").as_deref(),
            Some("0.69.0")
        );
        assert_eq!(parse_version("v0.68.1-custom").as_deref(), Some("0.68.1-custom"));
        assert_eq!(parse_version("0.70.1").as_deref(), Some("0.70.1"));
        assert_eq!(
            parse_version("frpc version 0.61.0\nbuild: go1.21").as_deref(),
            Some("0.61.0")
        );
        assert_eq!(
            parse_version("frpc version v0.68.1-custom").as_deref(),
            Some("0.68.1-custom")
        );
        assert_eq!(parse_version("frpc version 0.70.1,").as_deref(), Some("0.70.1"));
    }

    #[test]
    fn plain_text_has_no_version() {
        assert!(parse_version("frpc is a fast reverse proxy").is_none());
        assert!(parse_version("version").is_none());
        assert!(parse_version("").is_none());
        assert!(parse_version("2026-11-04").is_none());
    }

    #[test]
    fn frp_mention_detection_ignores_case() {
        assert!(looks_like_frpc("frpc version 0.69.0"));
        assert!(looks_like_frpc("FRP client"));
        assert!(!looks_like_frpc("nginx: unrecognized option"));
        assert!(!looks_like_frpc(""));
    }

    #[test]
    fn missing_path_is_reported_without_running_anything() {
        let path = std::env::temp_dir().join(format!("missing-frpc-{}.exe", uuid::Uuid::new_v4()));
        let probe = probe(&path.to_string_lossy());
        assert!(!probe.valid);
        assert!(probe.version.is_none());
        assert_eq!(probe.error.as_deref(), Some("The file does not exist."));
    }

    #[test]
    fn directory_is_not_a_binary() {
        let probe = probe(&std::env::temp_dir().to_string_lossy());
        assert!(!probe.valid);
        assert_eq!(probe.error.as_deref(), Some("The path is not a file."));
    }

    #[test]
    fn empty_path_is_rejected() {
        let probe = probe("   ");
        assert!(!probe.valid);
        assert_eq!(probe.error.as_deref(), Some("No frpc path was given."));
    }

    /// Needs a real `frpc` binary: `set FRPC_PATH=...` and run with `--ignored`.
    #[test]
    #[ignore]
    fn probes_a_real_binary() {
        let path = std::env::var("FRPC_PATH").expect("set FRPC_PATH to a real frpc binary");
        let probe = probe(&path);
        assert!(probe.valid, "probe error: {:?}", probe.error);
        assert!(probe.version.is_some());
        assert_eq!(probe.platform.as_deref(), Some(platform()));
    }
}
