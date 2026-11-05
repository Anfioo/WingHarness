//! 本地 AI CLI 版本检测。
//!
//! 执行 `<command> --version`（带超时），从输出中提取版本号。区分三种状态：
//! 未安装（命令找不到）、正常（解析出版本）、装了但损坏（命令存在但执行报错
//! 且无法解析版本）。

use serde::{Deserialize, Serialize};
use tokio::time::Duration;

use super::app_type::AppType;

/// 单个工具的版本探测结果。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolVersion {
    /// 应用标识。
    pub name: String,
    /// 探测到的版本号；未安装或无法解析时为 `None`。
    pub version: Option<String>,
    /// 探测失败时的错误信息。
    pub error: Option<String>,
    /// 命令存在但 `--version` 执行失败（装了但损坏）。
    #[serde(rename = "installedButBroken")]
    pub installed_but_broken: bool,
    /// 运行环境类型（windows / macos / linux）。
    #[serde(rename = "envType")]
    pub env_type: String,
}

fn env_type() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    }
}

/// 提取输出中的版本号。
///
/// 优先匹配语义化版本 `MAJOR.MINOR.PATCH`（可带 v 前缀和预发布/构建后缀），
/// 退而求其次匹配 `MAJOR.MINOR`。
fn extract_version(output: &str) -> Option<String> {
    // 完整语义化版本，如 1.2.3、v1.2.3、1.2.3-beta.1、2.0.0+build.5
    let semver = regex::Regex::new(r"v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.\-]+)?)").ok()?;
    if let Some(caps) = semver.captures(output) {
        return Some(caps.get(1).unwrap().as_str().to_string());
    }
    // 两段版本，如 1.2
    let two = regex::Regex::new(r"v?(\d+\.\d+)(?:\s|$)").ok()?;
    if let Some(caps) = two.captures(output) {
        return Some(caps.get(1).unwrap().as_str().to_string());
    }
    None
}

/// 判断「命令未找到」类错误/输出。
fn is_command_not_found(io_err: Option<&std::io::Error>, output: &str) -> bool {
    if let Some(err) = io_err {
        if err.kind() == std::io::ErrorKind::NotFound {
            return true;
        }
    }
    let lower = output.to_lowercase();
    lower.contains("not recognized")
        || lower.contains("command not found")
        || lower.contains("no such file")
        || lower.contains("not found")
}

/// 探测单个工具的版本。
pub async fn detect_version(app: AppType) -> ToolVersion {
    let command = app.meta().command;

    let output_result = run_version_command(command).await;

    let base = ToolVersion {
        name: app.as_str().to_string(),
        version: None,
        error: None,
        installed_but_broken: false,
        env_type: env_type().to_string(),
    };

    match output_result {
        Err(err) => {
            // spawn 阶段失败：多半是命令不存在。
            if is_command_not_found(Some(&err), &err.to_string()) {
                base
            } else {
                ToolVersion {
                    installed_but_broken: true,
                    error: Some(err.to_string()),
                    ..base
                }
            }
        }
        Ok(output) => {
            let combined = format!("{}\n{}", output.stdout, output.stderr);
            if let Some(version) = extract_version(&combined) {
                ToolVersion {
                    version: Some(version),
                    ..base
                }
            } else if is_command_not_found(None, &combined) {
                base
            } else {
                // 命令跑了但拿不到版本：视为损坏。
                ToolVersion {
                    installed_but_broken: true,
                    error: Some(combined.trim().to_string()),
                    ..base
                }
            }
        }
    }
}

struct CommandOutput {
    stdout: String,
    stderr: String,
}

/// 执行 `<command> --version`，10 秒超时。
///
/// Windows 下通过 `cmd /C` 调用（npm 全局安装的是 .cmd 脚本，直接 spawn 会
/// 找不到）；其他平台直接执行。子进程带 `CREATE_NO_WINDOW`，否则打包后的 GUI
/// 程序每探测一个工具都会闪出一个黑窗口。
async fn run_version_command(command: &str) -> std::io::Result<CommandOutput> {
    let mut cmd = if cfg!(target_os = "windows") {
        let mut c = tokio::process::Command::new("cmd");
        c.args(["/C", command, "--version"]);
        #[cfg(windows)]
        c.creation_flags(crate::proc::CREATE_NO_WINDOW);
        c
    } else {
        let mut c = tokio::process::Command::new(command);
        c.arg("--version");
        c
    };

    // 捕获输出（不继承控制台窗口，见上）。
    let child = cmd.output();
    match tokio::time::timeout(Duration::from_secs(10), child).await {
        Ok(Ok(output)) => Ok(CommandOutput {
            stdout: String::from_utf8_lossy(&output.stdout).to_string(),
            stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        }),
        Ok(Err(err)) => Err(err),
        Err(_) => Err(std::io::Error::new(
            std::io::ErrorKind::TimedOut,
            "version command timed out",
        )),
    }
}

/// 并发探测全部工具的版本。
pub async fn detect_all() -> Vec<ToolVersion> {
    let mut handles = Vec::new();
    for app in AppType::ALL {
        handles.push(tokio::spawn(async move { detect_version(app).await }));
    }
    let mut results = Vec::new();
    for handle in handles {
        if let Ok(version) = handle.await {
            results.push(version);
        }
    }
    results
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_semver_variants() {
        assert_eq!(extract_version("1.0.85").as_deref(), Some("1.0.85"));
        assert_eq!(extract_version("v2.1.3").as_deref(), Some("2.1.3"));
        assert_eq!(
            extract_version("claude 1.2.3-beta.1").as_deref(),
            Some("1.2.3-beta.1")
        );
        assert_eq!(
            extract_version("codex 0.1.24 (alpha)").as_deref(),
            Some("0.1.24")
        );
    }

    #[test]
    fn falls_back_to_two_part_version() {
        assert_eq!(extract_version("version 7.4 ").as_deref(), Some("7.4"));
    }

    #[test]
    fn returns_none_for_garbage() {
        assert!(extract_version("no version here").is_none());
    }

    #[test]
    fn detects_command_not_found_messages() {
        assert!(is_command_not_found(None, "'claude' is not recognized"));
        assert!(is_command_not_found(None, "bash: codex: command not found"));
    }

    #[tokio::test]
    async fn detects_nonexistent_command_as_uninstalled() {
        let v = detect_version(AppType::Pi).await;
        // 当前环境 pi 大概率未安装；若恰好安装则版本非空。两种都算合理。
        assert!(v.version.is_some() || v.error.is_none());
    }
}
