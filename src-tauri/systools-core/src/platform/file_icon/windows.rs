//! Batched icon extraction through Windows PowerShell and `System.Drawing`.
//!
//! The enabled `windows-sys` features intentionally do not include GDI or
//! `Win32_UI_WindowsAndMessaging`, so shell icon handles cannot be rasterized
//! natively here. One PowerShell process resolves every cache miss in a batch,
//! which keeps the cost at one interpreter start per icon IPC call instead of
//! one per file.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::platform::windows::child_process::hidden_command;

use super::cache;

/// Timeout for one batched extraction.
const EXTRACTION_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_PATHS: usize = 200;
const MAX_SOURCE_BYTES: u64 = 8 * 1024 * 1024;

/// Reads the batch from `paths.json` beside the script.
///
/// The script runs with `-File`: PowerShell's `-Command -` mode reads a raw
/// stdin pipe line by line and silently skips multi-line blocks, so the payload
/// travels through a file instead of stdin.
const EXTRACTION_SCRIPT: &str = "\
Add-Type -AssemblyName System.Drawing\r
$root = $PSScriptRoot\r
$items = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $root 'paths.json') | ConvertFrom-Json\r
foreach ($item in $items) {\r
  $target = Join-Path $root ('{0}.png' -f $item.i)\r
  try {\r
    $icon = [System.Drawing.Icon]::ExtractAssociatedIcon($item.p)\r
    if ($null -ne $icon) {\r
      $icon.ToBitmap().Save($target, [System.Drawing.Imaging.ImageFormat]::Png)\r
      $icon.Dispose()\r
    }\r
  } catch { }\r
}\r
";

/// Resolves icons for a batch of existing paths.
///
/// The returned vector is aligned with `paths`. Failures and missing files stay
/// `None`; one bad path never discards the rest of the batch.
pub(super) fn extract_icons_png(paths: &[PathBuf]) -> Vec<Option<Vec<u8>>> {
    let mut results = vec![None; paths.len()];
    let mut accepted = Vec::new();
    for (index, path) in paths.iter().enumerate().take(MAX_PATHS) {
        let Some(text) = path.to_str() else {
            continue;
        };
        if !path.is_absolute() || !path.is_file() {
            continue;
        }
        if let Some(png) = read_png_source(path) {
            results[index] = Some(png);
            continue;
        }
        accepted.push((index, text.to_string()));
    }
    if accepted.is_empty() {
        return results;
    }

    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let temporary_root = std::env::temp_dir().join(format!(
        "systools-icon-extract-{}-{nonce}",
        std::process::id()
    ));
    let items = accepted
        .iter()
        .map(|(index, path)| serde_json::json!({ "i": index, "p": path }))
        .collect::<Vec<_>>();
    let Ok(json) = serde_json::to_vec(&items) else {
        return results;
    };
    if fs::create_dir_all(&temporary_root).is_err() {
        log::debug!("systools_icon_extract_temp_failed");
        return results;
    }
    let script_path = temporary_root.join("extract.ps1");
    if fs::write(temporary_root.join("paths.json"), json).is_err()
        || fs::write(&script_path, EXTRACTION_SCRIPT.as_bytes()).is_err()
    {
        log::debug!("systools_icon_extract_write_failed");
        let _ = fs::remove_dir_all(&temporary_root);
        return results;
    }

    if run_powershell_script(&script_path) {
        for (index, _) in &accepted {
            let file = temporary_root.join(format!("{index}.png"));
            if let Ok(bytes) = fs::read(&file) {
                if cache::valid_png(&bytes) {
                    results[*index] = Some(bytes);
                }
            }
        }
    } else {
        log::debug!("systools_icon_extract_batch_failed count={}", accepted.len());
    }
    let _ = fs::remove_dir_all(&temporary_root);
    results
}

/// Returns the file itself when it already is a reasonably sized PNG.
///
/// Package assets and explicit `DisplayIcon` values often point straight at a
/// bitmap, and shell extraction would only fetch a generic placeholder for them.
fn read_png_source(path: &Path) -> Option<Vec<u8>> {
    let is_png = path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("png"));
    if !is_png {
        return None;
    }
    let metadata = fs::metadata(path).ok()?;
    if metadata.len() > MAX_SOURCE_BYTES {
        return None;
    }
    let bytes = fs::read(path).ok()?;
    cache::valid_png(&bytes).then_some(bytes)
}

fn run_powershell_script(script_path: &Path) -> bool {
    let working_directory = std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
    let mut child = match hidden_command("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
        ])
        .arg(script_path)
        .current_dir(working_directory)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(child) => child,
        Err(error) => {
            log::debug!("systools_icon_powershell_spawn_failed error={error}");
            return false;
        }
    };

    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status.success(),
            Ok(None) if started.elapsed() >= EXTRACTION_TIMEOUT => {
                let _ = child.kill();
                let _ = child.wait();
                log::warn!("systools_icon_powershell_timeout");
                return false;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(25)),
            Err(error) => {
                log::debug!("systools_icon_powershell_wait_failed error={error}");
                let _ = child.kill();
                let _ = child.wait();
                return false;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_paths_produce_no_icons_without_starting_a_helper() {
        let path = std::env::temp_dir().join("systools-missing-icon-fixture.exe");
        let start = Instant::now();
        let results = extract_icons_png(&[path]);

        assert_eq!(results.len(), 1);
        assert!(results[0].is_none());
        assert!(start.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn oversized_batches_stay_aligned() {
        let paths = (0..(MAX_PATHS + 5))
            .map(|index| {
                std::env::temp_dir().join(format!("systools-missing-icon-fixture-{index}.exe"))
            })
            .collect::<Vec<_>>();

        let results = extract_icons_png(&paths);

        assert_eq!(results.len(), paths.len());
        assert!(results.iter().all(Option::is_none));
    }

    #[test]
    fn png_assets_are_used_directly() {
        const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\
            \x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\
            \x1f\x15\xc4\x89\x00\x00\x00\x00IEND\xaeB`\x82";
        let path = std::env::temp_dir().join("systools-icon-source-fixture.png");
        fs::write(&path, PNG).expect("fixture write");

        let results = extract_icons_png(&[path.clone()]);

        let _ = fs::remove_file(&path);
        assert_eq!(results[0].as_deref(), Some(PNG));
    }
}
