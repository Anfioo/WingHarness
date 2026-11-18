// Ported from Argus (https://github.com/Ray-lea/Argus), AGPL-3.0-or-later.
// See UPSTREAM.md for the porting record.

//! On-demand details for a single process (too costly to collect for all).

use serde::Serialize;
use windows::Wdk::System::Threading::{NtQueryInformationProcess, ProcessCommandLineInformation};
use windows::Win32::Foundation::{CloseHandle, ERROR_INVALID_PARAMETER, HANDLE};
use windows::Win32::Security::{
    GetSidSubAuthority, GetSidSubAuthorityCount, GetTokenInformation, LookupAccountSidW, PSID,
    SID_NAME_USE, TOKEN_ELEVATION, TOKEN_INFORMATION_CLASS, TOKEN_MANDATORY_LABEL, TOKEN_QUERY,
    TOKEN_USER, TokenElevation, TokenIntegrityLevel, TokenUser,
};
use windows::Win32::Storage::FileSystem::{
    GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW,
};
use windows::Win32::System::SystemInformation::{
    IMAGE_FILE_MACHINE, IMAGE_FILE_MACHINE_AMD64, IMAGE_FILE_MACHINE_ARM64,
    IMAGE_FILE_MACHINE_ARMNT, IMAGE_FILE_MACHINE_I386, IMAGE_FILE_MACHINE_UNKNOWN,
};
use windows::Win32::System::Threading::{
    GetPriorityClass, IsWow64Process2, OpenProcess, OpenProcessToken, PROCESS_NAME_WIN32,
    PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW,
};
use windows::core::{PCWSTR, PWSTR};

const STATUS_INFO_LENGTH_MISMATCH: i32 = 0xC000_0004_u32 as i32;
const STATUS_BUFFER_TOO_SMALL: i32 = 0xC000_0023_u32 as i32;
const STATUS_BUFFER_OVERFLOW: i32 = 0x8000_0005_u32 as i32;

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionInfo {
    pub description: Option<String>,
    pub company: Option<String>,
    pub product_name: Option<String>,
    pub file_version: Option<String>,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessDetails {
    pub pid: u32,
    /// False when the process could not be opened (usually needs admin).
    pub accessible: bool,
    pub command_line: Option<String>,
    pub user: Option<String>,
    /// `untrusted` | `low` | `medium` | `mediumPlus` | `high` | `system` | `protected`
    pub integrity: Option<&'static str>,
    pub elevated: Option<bool>,
    /// `x64` | `x86` | `arm64` | `arm`
    pub architecture: Option<&'static str>,
    /// `idle` | `belowNormal` | `normal` | `aboveNormal` | `high` | `realtime`
    pub priority_class: Option<&'static str>,
    pub version: VersionInfo,
}

/// Closes the wrapped handle on drop.
struct OwnedHandle(HANDLE);

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        if !self.0.is_invalid() {
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }
}

/// Null-terminated UTF-16 copy of `s`.
fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Lossy UTF-16 to `String`, stopping at the first NUL.
fn from_wide(buf: &[u16]) -> String {
    let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..end])
}

/// A heap buffer with 8-byte alignment, suitable for NT structures.
struct AlignedBuf {
    data: Vec<u64>,
}

impl AlignedBuf {
    fn with_capacity(bytes: usize) -> Self {
        Self {
            data: vec![0; bytes.div_ceil(8)],
        }
    }

    fn len(&self) -> usize {
        self.data.len() * 8
    }

    fn grow_to(&mut self, bytes: usize) {
        if bytes > self.len() {
            self.data.resize(bytes.div_ceil(8), 0);
        }
    }

    fn as_mut_ptr(&mut self) -> *mut core::ffi::c_void {
        self.data.as_mut_ptr().cast()
    }

    fn as_ptr(&self) -> *const u8 {
        self.data.as_ptr().cast()
    }
}

#[repr(C)]
struct UnicodeString {
    length: u16,
    maximum_length: u16,
    buffer: *mut u16,
}

impl UnicodeString {
    /// # Safety
    /// `buffer` must point to at least `length` valid bytes.
    unsafe fn to_string_lossy(&self) -> String {
        if self.buffer.is_null() || self.length == 0 {
            return String::new();
        }
        let s = unsafe { std::slice::from_raw_parts(self.buffer, self.length as usize / 2) };
        String::from_utf16_lossy(s)
    }
}

pub fn query(pid: u32, path: Option<&str>) -> ProcessDetails {
    let mut d = ProcessDetails {
        pid,
        version: path.map(version_info).unwrap_or_default(),
        ..Default::default()
    };
    let Ok(handle) = (unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }) else {
        return d;
    };
    let handle = OwnedHandle(handle);
    d.accessible = true;
    d.command_line = command_line(handle.0);
    d.architecture = architecture(handle.0);
    d.priority_class = priority_class(handle.0);

    let mut token = HANDLE::default();
    if unsafe { OpenProcessToken(handle.0, TOKEN_QUERY, &mut token) }.is_ok() {
        let token = OwnedHandle(token);
        d.user = token_user(token.0);
        d.integrity = token_integrity(token.0);
        d.elevated = token_elevated(token.0);
    }
    d
}

/// Whether a process with this PID exists. A process this app may not open
/// still exists; only an invalid parameter means the PID is gone.
pub fn exists(pid: u32) -> bool {
    match unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) } {
        Ok(handle) => {
            let _ = OwnedHandle(handle);
            true
        }
        Err(error) => error.code() != ERROR_INVALID_PARAMETER.to_hresult(),
    }
}

/// One process's command line, on its own (no other details).
pub fn command_line_of(pid: u32) -> Option<String> {
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }.ok()?;
    let handle = OwnedHandle(handle);
    command_line(handle.0)
}

/// One process's executable path, on its own.
pub fn image_path_of(pid: u32) -> Option<String> {
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }.ok()?;
    let handle = OwnedHandle(handle);
    let mut image = vec![0u16; 32768];
    let mut len = image.len() as u32;
    unsafe {
        QueryFullProcessImageNameW(
            handle.0,
            PROCESS_NAME_WIN32,
            PWSTR(image.as_mut_ptr()),
            &mut len,
        )
    }
    .ok()?;
    Some(String::from_utf16_lossy(&image[..len as usize]))
}

pub(crate) fn command_line(process: HANDLE) -> Option<String> {
    let mut buf = AlignedBuf::with_capacity(1024);
    for _ in 0..3 {
        let mut needed = 0u32;
        let status = unsafe {
            NtQueryInformationProcess(
                process,
                ProcessCommandLineInformation,
                buf.as_mut_ptr(),
                buf.len() as u32,
                &mut needed,
            )
        };
        match status.0 {
            STATUS_INFO_LENGTH_MISMATCH | STATUS_BUFFER_TOO_SMALL | STATUS_BUFFER_OVERFLOW => {
                if needed > 128 * 1024 {
                    return None;
                }
                buf.grow_to(needed as usize + 16);
            }
            s if s < 0 => return None,
            _ => {
                // The result is a UNICODE_STRING pointing into the same buffer.
                let us = unsafe { &*(buf.as_ptr() as *const UnicodeString) };
                let s = unsafe { us.to_string_lossy() };
                return (!s.is_empty()).then_some(s);
            }
        }
    }
    None
}

fn architecture(process: HANDLE) -> Option<&'static str> {
    let mut proc_machine = IMAGE_FILE_MACHINE::default();
    let mut native_machine = IMAGE_FILE_MACHINE::default();
    unsafe { IsWow64Process2(process, &mut proc_machine, Some(&mut native_machine)) }.ok()?;
    let machine = if proc_machine == IMAGE_FILE_MACHINE_UNKNOWN {
        native_machine
    } else {
        proc_machine
    };
    Some(match machine {
        IMAGE_FILE_MACHINE_AMD64 => "x64",
        IMAGE_FILE_MACHINE_I386 => "x86",
        IMAGE_FILE_MACHINE_ARM64 => "arm64",
        IMAGE_FILE_MACHINE_ARMNT => "arm",
        _ => return None,
    })
}

fn priority_class(process: HANDLE) -> Option<&'static str> {
    Some(match unsafe { GetPriorityClass(process) } {
        0x40 => "idle",
        0x4000 => "belowNormal",
        0x20 => "normal",
        0x8000 => "aboveNormal",
        0x80 => "high",
        0x100 => "realtime",
        _ => return None,
    })
}

fn token_info(token: HANDLE, class: TOKEN_INFORMATION_CLASS) -> Option<AlignedBuf> {
    let mut len = 0u32;
    let _ = unsafe { GetTokenInformation(token, class, None, 0, &mut len) };
    if len == 0 {
        return None;
    }
    let mut buf = AlignedBuf::with_capacity(len as usize);
    unsafe { GetTokenInformation(token, class, Some(buf.as_mut_ptr()), len, &mut len) }.ok()?;
    Some(buf)
}

fn token_user(token: HANDLE) -> Option<String> {
    let buf = token_info(token, TokenUser)?;
    let user = unsafe { &*(buf.as_ptr() as *const TOKEN_USER) };
    account_name(user.User.Sid)
}

fn account_name(sid: PSID) -> Option<String> {
    let mut name = [0u16; 256];
    let mut domain = [0u16; 256];
    let (mut name_len, mut domain_len) = (name.len() as u32, domain.len() as u32);
    let mut use_ = SID_NAME_USE::default();
    unsafe {
        LookupAccountSidW(
            PCWSTR::null(),
            sid,
            Some(PWSTR(name.as_mut_ptr())),
            &mut name_len,
            Some(PWSTR(domain.as_mut_ptr())),
            &mut domain_len,
            &mut use_,
        )
    }
    .ok()?;
    let (name, domain) = (from_wide(&name), from_wide(&domain));
    Some(if domain.is_empty() {
        name
    } else {
        format!(r"{domain}\{name}")
    })
}

fn token_integrity(token: HANDLE) -> Option<&'static str> {
    let buf = token_info(token, TokenIntegrityLevel)?;
    let label = unsafe { &*(buf.as_ptr() as *const TOKEN_MANDATORY_LABEL) };
    let sid = label.Label.Sid;
    let rid = unsafe {
        let count = *GetSidSubAuthorityCount(sid);
        if count == 0 {
            return None;
        }
        *GetSidSubAuthority(sid, count as u32 - 1)
    };
    Some(match rid {
        r if r < 0x1000 => "untrusted",
        r if r < 0x2000 => "low",
        r if r < 0x2100 => "medium",
        r if r < 0x3000 => "mediumPlus",
        r if r < 0x4000 => "high",
        r if r < 0x5000 => "system",
        _ => "protected",
    })
}

fn token_elevated(token: HANDLE) -> Option<bool> {
    let buf = token_info(token, TokenElevation)?;
    let e = unsafe { &*(buf.as_ptr() as *const TOKEN_ELEVATION) };
    Some(e.TokenIsElevated != 0)
}

/// The version resource of the executable at `path`, resolved on demand.
pub fn version_info(path: &str) -> VersionInfo {
    let wpath = wide(path);
    let size = unsafe { GetFileVersionInfoSizeW(PCWSTR(wpath.as_ptr()), None) };
    if size == 0 {
        return VersionInfo::default();
    }
    let mut data = vec![0u8; size as usize];
    if unsafe { GetFileVersionInfoW(PCWSTR(wpath.as_ptr()), None, size, data.as_mut_ptr().cast()) }
        .is_err()
    {
        return VersionInfo::default();
    }

    // Prefer the first declared translation, then the common English fallbacks.
    let mut prefixes = Vec::new();
    unsafe {
        let mut ptr = std::ptr::null_mut();
        let mut len = 0u32;
        let sub = wide(r"\VarFileInfo\Translation");
        if VerQueryValueW(
            data.as_ptr().cast(),
            PCWSTR(sub.as_ptr()),
            &mut ptr,
            &mut len,
        )
        .as_bool()
            && len >= 4
        {
            let pairs = std::slice::from_raw_parts(ptr as *const u16, len as usize / 2);
            for pair in pairs.as_chunks::<2>().0 {
                prefixes.push(format!(r"\StringFileInfo\{:04x}{:04x}\", pair[0], pair[1]));
            }
        }
    }
    prefixes.push(r"\StringFileInfo\040904b0\".into());
    prefixes.push(r"\StringFileInfo\040904e4\".into());

    let query = |field: &str| -> Option<String> {
        prefixes.iter().find_map(|prefix| unsafe {
            let sub = wide(&format!("{prefix}{field}"));
            let mut ptr = std::ptr::null_mut();
            let mut len = 0u32;
            if !VerQueryValueW(
                data.as_ptr().cast(),
                PCWSTR(sub.as_ptr()),
                &mut ptr,
                &mut len,
            )
            .as_bool()
                || len == 0
            {
                return None;
            }
            let s = std::slice::from_raw_parts(ptr as *const u16, len as usize);
            let s = String::from_utf16_lossy(s);
            let s = s.trim_matches(|c: char| c == '\0' || c.is_whitespace());
            (!s.is_empty()).then(|| s.to_owned())
        })
    };

    VersionInfo {
        description: query("FileDescription"),
        company: query("CompanyName"),
        product_name: query("ProductName"),
        file_version: query("FileVersion"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pid_that_cannot_be_opened_reports_only_the_pid() {
        // PID 0 is the idle process; OpenProcess always refuses it.
        let details = query(0, None);
        assert_eq!(details.pid, 0);
        assert!(!details.accessible);
        assert!(details.command_line.is_none());
        assert!(details.version.description.is_none());
    }

    #[test]
    fn a_missing_executable_has_no_version_resource() {
        assert!(
            version_info("Z:\\definitely-missing\\nothing.exe")
                .description
                .is_none()
        );
    }

    #[test]
    fn this_process_exists_and_pid_zero_does_not() {
        assert!(exists(std::process::id()));
        assert!(!exists(0));
    }
}
