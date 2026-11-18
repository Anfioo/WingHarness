// Ported from Argus (https://github.com/Ray-lea/Argus), AGPL-3.0-or-later.
// See UPSTREAM.md for the porting record.

//! Fixed error codes, diagnostics staging and the single `HANDLE` wrapper.

use windows::Win32::Foundation::{CloseHandle, HANDLE};

pub type Result<T> = std::result::Result<T, u32>;
pub const UNSAFE_PATH: u32 = 0x2000_0001;
pub const OTHER_OWNER: u32 = 0x2000_0002;
pub const INCOMPATIBLE: u32 = 0x2000_0003;
pub const FOREIGN_SERVICE: u32 = 0x2000_0004;

/// The host renders these English strings; the page translates by error code
/// where it can. No accounting or process metadata is included.
pub fn message(code: u32) -> String {
    match code {
        UNSAFE_PATH => "The service directory is not protected from other accounts.".into(),
        OTHER_OWNER => "The privileged service belongs to another account.".into(),
        INCOMPATIBLE => "The privileged service speaks an incompatible protocol; update it.".into(),
        FOREIGN_SERVICE => "Another program's service uses this name.".into(),
        1223 => "The elevation prompt was cancelled.".into(),
        1460 => "The operation timed out.".into(),
        _ => format!("Windows error {code}"),
    }
}

pub fn win(e: windows::core::Error) -> u32 {
    let code = e.code().0 as u32;
    if code >> 16 == 0x8007 {
        code & 0xffff
    } else {
        code
    }
}

#[track_caller]
pub fn stage<T>(name: &'static str, result: Result<T>) -> Result<T> {
    if let Err(code) = &result {
        argus_core::diagnostics::warn(name, argus_core::diagnostics::code(*code));
    }
    result
}

#[track_caller]
pub fn file_stage<T>(name: &'static str, path: &std::path::Path, result: Result<T>) -> Result<T> {
    if let Err(code) = &result {
        argus_core::diagnostics::warn(
            name,
            format!(
                "{}; path={}",
                argus_core::diagnostics::code(*code),
                argus_core::diagnostics::path(path)
            ),
        );
    }
    result
}

pub fn io(e: std::io::Error) -> u32 {
    e.raw_os_error().unwrap_or(31) as u32
}

pub fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(Some(0)).collect()
}

pub struct Handle(pub HANDLE);
unsafe impl Send for Handle {}
unsafe impl Sync for Handle {}
impl Drop for Handle {
    fn drop(&mut self) {
        if !self.0.is_invalid() {
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn non_win32_hresult_is_not_misreported_as_access_denied() {
        for (hresult, expected) in [
            (0x80070005u32, 5),
            (0x80070715, 1813),
            (0x80004005, 0x80004005),
            (0xc0000022, 0xc0000022),
        ] {
            assert_eq!(
                win(windows::core::Error::from_hresult(windows::core::HRESULT(
                    hresult as i32
                ))),
                expected
            );
        }
    }

    #[test]
    fn messages_are_fixed_english_text() {
        assert!(message(INCOMPATIBLE).contains("incompatible protocol"));
        assert_eq!(message(87), "Windows error 87");
    }
}
