//! PowerPoint detection and conversion to PDF.
//!
//! PowerPoint has no open renderer, so a presentation is converted through the
//! locally installed application over COM, in a PowerShell helper, and the
//! resulting PDF is cached. When PowerPoint is not installed the probe returns
//! `false` and conversion is reported as unsupported; the viewer then falls back
//! to its own slide renderer.

use std::path::{Path, PathBuf};

use crate::error::SpacePreviewResult;

/// The PowerPoint file types that carry slides.
const EXTENSIONS: &[&str] = &[
    "pptx", "pptm", "ppsx", "ppsm", "potx", "potm", "ppt", "pps", "pot",
];

/// Whether `path` names a presentation this module can convert.
pub fn is_supported(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| EXTENSIONS.contains(&extension.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

/// Whether a local PowerPoint can be driven over COM on this machine.
#[cfg(windows)]
pub fn available() -> bool {
    windows::available()
}

/// Whether a local PowerPoint can be driven over COM on this machine.
#[cfg(not(windows))]
pub fn available() -> bool {
    false
}

/// Convert `source` into a PDF below `cache_dir` and return the PDF's path.
///
/// The cache file is keyed by the source path, size and modification time, so a
/// repeated preview reuses the previous conversion and an edited presentation
/// converts again. A non-presentation, a missing PowerPoint and a failed
/// conversion are all reported as structured errors, never panics.
pub fn render(source: &Path, cache_dir: &Path) -> SpacePreviewResult<PathBuf> {
    if !is_supported(source) {
        return Err(crate::error::SpacePreviewError::unsupported(
            "This file is not a supported PowerPoint presentation.",
        ));
    }

    #[cfg(windows)]
    {
        windows::render(source, cache_dir)
    }
    #[cfg(not(windows))]
    {
        let _ = cache_dir;
        Err(crate::error::SpacePreviewError::unsupported(
            "PowerPoint conversion is only available on Windows.",
        ))
    }
}

#[cfg(windows)]
mod windows {
    use std::fs;
    use std::io::Read;
    use std::os::windows::process::CommandExt;
    use std::path::{Path, PathBuf};
    use std::process::{Command, Stdio};
    use std::sync::Mutex;
    use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

    use crate::error::{SpacePreviewError, SpacePreviewResult};

    /// Conversions run one at a time: COM and PowerPoint itself are both
    /// single-instance in practice, and a second WScript shell would only queue.
    static CONVERSION: Mutex<()> = Mutex::new(());

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const TIMEOUT: Duration = Duration::from_secs(60);
    const SCRIPT_NAME: &str = "render-presentation.ps1";
    const SCRIPT: &str = include_str!("presentation.ps1");

    /// Probe the PowerPoint progid: it is registered exactly when the COM server
    /// is installed, and querying it does not start PowerPoint.
    pub(super) fn available() -> bool {
        let Some(system_root) = std::env::var_os("SystemRoot") else {
            return false;
        };
        let reg = PathBuf::from(system_root).join("System32/reg.exe");
        Command::new(reg)
            .args(["query", r"HKCR\PowerPoint.Application"])
            .creation_flags(CREATE_NO_WINDOW)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    }

    pub(super) fn render(source: &Path, cache_dir: &Path) -> SpacePreviewResult<PathBuf> {
        if !available() {
            return Err(SpacePreviewError::unsupported(
                "PowerPoint is not available on this system.",
            ));
        }

        let _guard = CONVERSION
            .lock()
            .map_err(|_| SpacePreviewError::internal("The conversion queue is poisoned."))?;

        let info = fs::metadata(source).map_err(|error| crate::io::file_error(source, error))?;
        let modified = info.modified().map_err(|error| {
            SpacePreviewError::internal(format!(
                "The presentation's modification time could not be read: {error}"
            ))
        })?;
        let key = cache_key(source, info.len(), modified);

        fs::create_dir_all(cache_dir).map_err(|error| {
            SpacePreviewError::internal(format!(
                "The presentation cache could not be created: {error}"
            ))
        })?;
        let output = cache_dir.join(format!("{key}.pdf"));
        if valid_pdf(&output) {
            return Ok(output);
        }

        let pending = cache_dir.join(format!("{key}.pending.pdf"));
        let script = cache_dir.join(SCRIPT_NAME);
        fs::write(&script, SCRIPT).map_err(|error| {
            SpacePreviewError::internal(format!(
                "The presentation helper could not be written: {error}"
            ))
        })?;

        let Some(shell) = system_binary("System32/WindowsPowerShell/v1.0/powershell.exe") else {
            return Err(SpacePreviewError::internal(
                "The Windows PowerShell directory could not be located.",
            ));
        };
        // Paths travel as environment values, never interpolated into the script.
        let mut child = Command::new(shell)
            .args([
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
            ])
            .arg(&script)
            .env("SPACEPREVIEW_PPT_SOURCE", office_path(source))
            .env("SPACEPREVIEW_PPT_OUTPUT", office_path(&pending))
            .creation_flags(CREATE_NO_WINDOW)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| {
                SpacePreviewError::internal(format!(
                    "The PowerPoint helper could not start: {error}"
                ))
            })?;

        let started = Instant::now();
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break Some(status),
                Ok(None) => {}
                Err(error) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    let _ = fs::remove_file(&pending);
                    return Err(SpacePreviewError::internal(format!(
                        "The PowerPoint helper could not be observed: {error}"
                    )));
                }
            }
            if started.elapsed() > TIMEOUT {
                break None;
            }
            std::thread::sleep(Duration::from_millis(100));
        };

        let Some(status) = status else {
            // Stop only our helper; never terminate the user's PowerPoint.
            let _ = child.kill();
            let _ = child.wait();
            let _ = fs::remove_file(&pending);
            log::warn!("space_preview_presentation_timeout");
            return Err(SpacePreviewError::internal(
                "The presentation conversion timed out.",
            ));
        };

        if !status.success() || !valid_pdf(&pending) {
            let _ = fs::remove_file(&pending);
            // The helper's output is not logged: it may quote the document.
            log::warn!(
                "space_preview_presentation_failed exit={}",
                status.code().unwrap_or(-1)
            );
            return Err(SpacePreviewError::unsupported(
                "PowerPoint could not convert the presentation. Check that it is installed, activated and not password protected.",
            ));
        }

        let updated = fs::metadata(source).map_err(|error| crate::io::file_error(source, error))?;
        if updated.len() != info.len() || updated.modified().ok() != Some(modified) {
            let _ = fs::remove_file(&pending);
            return Err(SpacePreviewError::internal(
                "The presentation changed while it was being converted.",
            ));
        }
        if output.exists() {
            fs::remove_file(&output).map_err(|error| {
                SpacePreviewError::internal(format!(
                    "The stale presentation cache could not be removed: {error}"
                ))
            })?;
        }
        fs::rename(&pending, &output).map_err(|error| {
            SpacePreviewError::internal(format!(
                "The converted presentation could not be stored: {error}"
            ))
        })?;
        Ok(output)
    }

    fn system_binary(relative: &str) -> Option<PathBuf> {
        std::env::var_os("SystemRoot").map(|root| PathBuf::from(root).join(relative))
    }

    /// The cache key covers everything that makes a conversion stale.
    fn cache_key(path: &Path, size: u64, modified: SystemTime) -> String {
        let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
        let mut feed = |bytes: &[u8]| {
            for byte in bytes {
                hash ^= u64::from(*byte);
                hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
            }
        };
        feed(path.to_string_lossy().as_bytes());
        feed(&size.to_le_bytes());
        let stamps = modified
            .duration_since(UNIX_EPOCH)
            .map(|elapsed| elapsed.as_nanos())
            .unwrap_or(0);
        feed(&stamps.to_le_bytes());
        format!("{hash:016x}")
    }

    fn valid_pdf(path: &Path) -> bool {
        let mut header = [0; 5];
        fs::File::open(path)
            .and_then(|mut file| file.read_exact(&mut header))
            .is_ok()
            && &header == b"%PDF-"
    }

    /// COM opens the verbatim `\\?\` form badly; hand it the plain path.
    fn office_path(path: &Path) -> String {
        let path = path.to_string_lossy();
        if let Some(unc) = path.strip_prefix(r"\\?\UNC\") {
            format!(r"\\{unc}")
        } else {
            path.strip_prefix(r"\\?\").unwrap_or(&path).to_string()
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn cache_tracks_source_and_changes() {
            let path = Path::new("deck.pptx");
            let time = SystemTime::UNIX_EPOCH;
            let key = cache_key(path, 1, time);
            assert_eq!(key, cache_key(path, 1, time));
            assert_ne!(key, cache_key(Path::new("other.pptx"), 1, time));
            assert_ne!(key, cache_key(path, 2, time));
            assert_ne!(key, cache_key(path, 1, time + Duration::from_nanos(100)));
        }

        #[test]
        fn com_paths_preserve_local_and_unc_names() {
            assert_eq!(office_path(Path::new(r"\\?\E:\deck.pptx")), r"E:\deck.pptx");
            assert_eq!(
                office_path(Path::new(r"\\?\UNC\server\share\deck.pptx")),
                r"\\server\share\deck.pptx"
            );
        }

        #[test]
        fn valid_pdf_checks_the_signature() {
            let directory = std::env::temp_dir().join(format!(
                "space-preview-b3-presentation-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map(|elapsed| elapsed.as_nanos())
                    .unwrap_or_default()
            ));
            fs::create_dir_all(&directory).unwrap();
            let pdf = directory.join("deck.pdf");
            fs::write(&pdf, b"%PDF-1.7").unwrap();
            assert!(valid_pdf(&pdf));
            fs::write(&pdf, b"not a pdf").unwrap();
            assert!(!valid_pdf(&pdf));
            assert!(!valid_pdf(&directory.join("absent.pdf")));
            let _ = fs::remove_dir_all(&directory);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(label: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|elapsed| elapsed.as_nanos())
            .unwrap_or_default();
        let directory = std::env::temp_dir().join(format!(
            "space-preview-b3-{label}-{}-{stamp}",
            std::process::id()
        ));
        fs::create_dir_all(&directory).unwrap();
        directory
    }

    #[test]
    fn presentation_extensions_are_supported() {
        for name in [
            "deck.pptx",
            "deck.pptm",
            "slides.ppsx",
            "slides.ppsm",
            "template.potx",
            "old.ppt",
            "old.pps",
            "old.pot",
            "UPPER.PPTX",
        ] {
            assert!(is_supported(Path::new(name)), "{name}");
        }
        for name in ["deck.pdf", "deck.docx", "deck", "deck.pptx.txt"] {
            assert!(!is_supported(Path::new(name)), "{name}");
        }
    }

    #[test]
    fn non_presentation_is_rejected_before_conversion() {
        let directory = temp_dir("reject");
        let path = directory.join("deck.pdf");
        fs::write(&path, b"%PDF-1.7").unwrap();

        let error = render(&path, &directory.join("cache")).unwrap_err();

        assert_eq!(error.code, "unsupported");
        assert!(!directory.join("cache").exists());
        let _ = fs::remove_dir_all(&directory);
    }

    #[cfg(windows)]
    #[test]
    fn render_without_powerpoint_is_unsupported() {
        // A machine that does have PowerPoint would start it here, so only the
        // negative case is asserted.
        if available() {
            return;
        }
        let directory = temp_dir("unavailable");
        let path = directory.join("deck.pptx");
        fs::write(&path, b"not a real presentation").unwrap();

        let error = render(&path, &directory.join("cache")).unwrap_err();

        let _ = fs::remove_dir_all(&directory);
        assert_eq!(error.code, "unsupported");
    }

    #[cfg(not(windows))]
    #[test]
    fn conversion_is_unsupported_off_windows() {
        assert!(!available());
        let directory = temp_dir("off-windows");
        let path = directory.join("deck.pptx");
        fs::write(&path, b"not a real presentation").unwrap();

        let error = render(&path, &directory.join("cache")).unwrap_err();

        let _ = fs::remove_dir_all(&directory);
        assert_eq!(error.code, "unsupported");
    }
}
