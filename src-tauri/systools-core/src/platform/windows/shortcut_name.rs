//! Human-readable shortcut names and targets resolved from `.lnk` files.
//!
//! Windows has no single portable "display name" field for a shortcut. The
//! file stem is what Explorer shows, while the link description is an optional
//! tooltip. Callers therefore get both: a target plus arguments, and a display
//! name that prefers the description and falls back to the file stem.

use std::path::{Path, PathBuf};

use windows::Win32::Storage::FileSystem::WIN32_FIND_DATAW;
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, IPersistFile, CLSCTX_INPROC_SERVER,
    COINIT_APARTMENTTHREADED, STGM_READ,
};
use windows::Win32::UI::Shell::{IShellLinkW, ShellLink, SLGP_RAWPATH};
use windows_core::{Interface, HSTRING};

const BUFFER_LENGTH: usize = 32_768;
const DESCRIPTION_LENGTH: usize = 4_096;

struct ComGuard;

impl ComGuard {
    /// Initializes COM for the current thread when possible.
    ///
    /// `RPC_E_CHANGED_MODE` means another component already initialized this
    /// thread in a different apartment. Shell links remain usable there, so the
    /// guard is skipped instead of failing the whole lookup.
    fn initialize() -> Option<Self> {
        let result = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
        result.is_ok().then_some(Self)
    }
}

impl Drop for ComGuard {
    fn drop(&mut self) {
        unsafe {
            CoUninitialize();
        }
    }
}

struct ResolvedShortcut {
    target: PathBuf,
    arguments: String,
    description: Option<String>,
}

/// Returns the shortcut target and its argument string.
///
/// The pair is `None` when the file is not a readable shell link or the target
/// buffer cannot be decoded.
pub(crate) fn shortcut_target(path: &Path) -> Option<(PathBuf, String)> {
    let resolved = resolve(path)?;
    Some((resolved.target, resolved.arguments))
}

/// Returns a human-readable name for a shortcut.
///
/// The link description wins when present; the file stem is the documented
/// fallback because it is the label Explorer displays.
pub(crate) fn shortcut_display_name(path: &Path) -> Option<String> {
    let description = resolve(path).and_then(|resolved| resolved.description);
    display_name_from(description, path)
}

fn display_name_from(description: Option<String>, path: &Path) -> Option<String> {
    description
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .or_else(|| {
            path.file_stem()
                .map(|value| value.to_string_lossy().trim().to_owned())
                .filter(|value| !value.is_empty())
        })
}

fn resolve(path: &Path) -> Option<ResolvedShortcut> {
    if !path.is_file() {
        return None;
    }
    let _guard = ComGuard::initialize();
    resolve_inner(path)
}

fn resolve_inner(path: &Path) -> Option<ResolvedShortcut> {
    // SAFETY: `ShellLink` is an in-process COM class; the returned interface is
    // released when it goes out of scope.
    let link: IShellLinkW =
        unsafe { CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER) }.ok()?;
    let persist: IPersistFile = link.cast().ok()?;
    // SAFETY: the path is a valid wide string and `persist` owns the loaded file.
    unsafe { persist.Load(&HSTRING::from(path.as_os_str()), STGM_READ) }.ok()?;

    let mut target_buffer = vec![0_u16; BUFFER_LENGTH];
    let mut find_data = WIN32_FIND_DATAW::default();
    // SAFETY: both buffers are writable for their reported capacity.
    unsafe {
        link.GetPath(
            &mut target_buffer,
            &mut find_data,
            SLGP_RAWPATH.0 as u32,
        )
    }
    .ok()?;
    let target = wide_buffer_string(&target_buffer)?;

    let mut argument_buffer = vec![0_u16; BUFFER_LENGTH];
    let arguments = unsafe { link.GetArguments(&mut argument_buffer) }
        .ok()
        .and_then(|()| wide_buffer_string(&argument_buffer))
        .unwrap_or_default();

    let mut description_buffer = vec![0_u16; DESCRIPTION_LENGTH];
    let description = unsafe { link.GetDescription(&mut description_buffer) }
        .ok()
        .and_then(|()| wide_buffer_string(&description_buffer));

    Some(ResolvedShortcut {
        target: PathBuf::from(target),
        arguments,
        description,
    })
}

fn wide_buffer_string(buffer: &[u16]) -> Option<String> {
    let end = buffer
        .iter()
        .position(|value| *value == 0)
        .unwrap_or(buffer.len());
    let value = String::from_utf16_lossy(&buffer[..end]);
    let value = value.trim().to_owned();
    (!value.is_empty()).then_some(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn description_wins_over_the_file_stem() {
        assert_eq!(
            display_name_from(
                Some("  Example Tool  ".to_string()),
                Path::new(r"C:\Start Menu\Example.lnk")
            )
            .as_deref(),
            Some("Example Tool")
        );
    }

    #[test]
    fn missing_description_falls_back_to_the_file_stem() {
        assert_eq!(
            display_name_from(None, Path::new(r"C:\Start Menu\Example Tool.lnk")).as_deref(),
            Some("Example Tool")
        );
        assert_eq!(
            display_name_from(Some("   ".to_string()), Path::new("Example.lnk")).as_deref(),
            Some("Example")
        );
    }

    #[test]
    fn display_name_is_none_without_a_usable_stem() {
        assert!(display_name_from(None, Path::new(r"C:\")).is_none());
    }

    #[test]
    fn wide_buffer_ignores_unused_capacity() {
        let buffer = [b'a' as u16, b'b' as u16, 0, b'c' as u16];
        assert_eq!(wide_buffer_string(&buffer).as_deref(), Some("ab"));
    }
}
