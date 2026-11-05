//! Windows' system proxy: on, off, and whose it is.
//!
//! mihomo routes traffic but never points Windows at itself. That is two values
//! under `Internet Settings` plus the notification WinINet needs to notice, and
//! Windows keeps the setting for the whole machine — shared with every other
//! proxy tool. A marker file records the address this app set, so only that one
//! is ever turned off again.

use serde::Serialize;

use crate::store;

#[cfg(not(windows))]
const UNSUPPORTED: &str = "System proxy control is only implemented on Windows";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SysProxyStatus {
    /// False where the platform has no implementation.
    pub supported: bool,
    /// Whether Windows is sending traffic through a proxy right now.
    pub enabled: bool,
    /// That proxy's address, e.g. `127.0.0.1:7890`.
    pub server: Option<String>,
}

pub fn status() -> SysProxyStatus {
    let server = imp::read().ok().flatten();
    SysProxyStatus {
        supported: cfg!(windows),
        enabled: server.is_some(),
        server,
    }
}

/// Point the system proxy at `port` on loopback and remember that we did.
pub fn enable(port: u16) -> Result<(), String> {
    if port == 0 {
        return Err("The core is not listening on a proxy port".to_string());
    }
    let server = format!("127.0.0.1:{port}");
    imp::write(&server)?;
    imp::notify()?;
    store::atomic_write(&store::sysproxy_marker_path()?, &server)
}

/// Turn the proxy off, unless another program replaced it since.
pub fn disable() -> Result<(), String> {
    let ours = marker();
    let active = imp::read()?;
    let result = if is_ours(ours.as_deref(), active.as_deref()) {
        imp::clear().and_then(|()| imp::notify())
    } else {
        Ok(())
    };
    if result.is_ok() {
        // Either it is off now, or it is someone else's and no longer ours to
        // track. A failed write keeps the marker so the next attempt retries.
        clear_marker();
    }
    result
}

/// Keep an enabled system proxy on the port the core uses now: a profile change
/// can move it, and an address pointing at a closed port takes every application
/// that honours the system proxy offline.
pub fn follow_core(port: u16) {
    let Some(ours) = marker() else {
        return;
    };
    if !is_ours(Some(&ours), imp::read().ok().flatten().as_deref()) {
        return;
    }
    let _ = enable(port);
}

/// Put the system proxy where the running core needs it.
///
/// A user who turned it on expects it back after the core restarts; that is what
/// `settings::sys_proxy` records. An already-enabled proxy is moved along even
/// when the intent says off, so a profile that changed its mixed port cannot
/// leave Windows pointing at a closed one.
pub fn on_core_start(port: u16) {
    if crate::settings::wants_sys_proxy() {
        let _ = enable(port);
        return;
    }
    follow_core(port);
}

/// A proxy left on by a crash points at a core that is not running. Called once
/// at startup, before the page can ask anything.
pub fn clean_leftover() {
    if marker().is_some() {
        let _ = disable();
    }
}

/// The active proxy is this app's exactly when it still names the address the
/// marker recorded.
fn is_ours(ours: Option<&str>, active: Option<&str>) -> bool {
    matches!((ours, active), (Some(ours), Some(active)) if ours == active)
}

fn marker() -> Option<String> {
    let path = store::sysproxy_marker_path().ok()?;
    let text = std::fs::read_to_string(path).ok()?;
    let text = text.trim().to_string();
    (!text.is_empty()).then_some(text)
}

fn clear_marker() {
    if let Ok(path) = store::sysproxy_marker_path() {
        let _ = std::fs::remove_file(path);
    }
}

#[cfg(windows)]
mod imp {
    use std::ffi::c_void;

    use winreg::enums::{HKEY_CURRENT_USER, KEY_SET_VALUE};
    use winreg::RegKey;

    const KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Internet Settings";
    /// Loopback and the private ranges — the same bypass list Clash clients
    /// write, so local services keep answering while the proxy is on.
    const BYPASS: &str = "<local>;localhost;127.*;10.*;172.16.*;172.17.*;172.18.*;172.19.*;\
172.20.*;172.21.*;172.22.*;172.23.*;172.24.*;172.25.*;172.26.*;172.27.*;172.28.*;172.29.*;\
172.30.*;172.31.*;192.168.*";

    const INTERNET_OPTION_REFRESH: u32 = 37;
    const INTERNET_OPTION_SETTINGS_CHANGED: u32 = 39;

    #[link(name = "wininet")]
    extern "system" {
        fn InternetSetOptionW(
            handle: *mut c_void,
            option: u32,
            buffer: *mut c_void,
            length: u32,
        ) -> i32;
    }

    pub fn read() -> Result<Option<String>, String> {
        let key = match RegKey::predef(HKEY_CURRENT_USER).open_subkey(KEY) {
            Ok(key) => key,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(format!("Cannot read the system proxy: {error}")),
        };
        let enabled: u32 = key.get_value("ProxyEnable").unwrap_or(0);
        if enabled != 1 {
            return Ok(None);
        }
        let server: String = key.get_value("ProxyServer").unwrap_or_default();
        Ok(Some(server).filter(|server| !server.is_empty()))
    }

    pub fn write(server: &str) -> Result<(), String> {
        let (key, _) = RegKey::predef(HKEY_CURRENT_USER)
            .create_subkey(KEY)
            .map_err(|e| format!("Cannot open the system proxy settings: {e}"))?;
        key.set_value("ProxyEnable", &1u32)
            .map_err(|e| format!("Cannot enable the system proxy: {e}"))?;
        key.set_value("ProxyServer", &server.to_string())
            .map_err(|e| format!("Cannot set the system proxy address: {e}"))?;
        key.set_value("ProxyOverride", &BYPASS.to_string())
            .map_err(|e| format!("Cannot set the system proxy bypass list: {e}"))?;
        Ok(())
    }

    pub fn clear() -> Result<(), String> {
        // `open_subkey` asks for read access, and setting a value on that handle
        // is an access-denied error.
        let key = RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey_with_flags(KEY, KEY_SET_VALUE)
            .map_err(|e| format!("Cannot open the system proxy settings: {e}"))?;
        key.set_value("ProxyEnable", &0u32)
            .map_err(|e| format!("Cannot disable the system proxy: {e}"))
    }

    /// Tell WinINet the setting moved; without it every running program keeps
    /// the values it read at startup.
    pub fn notify() -> Result<(), String> {
        // SAFETY: both calls take a null handle and a null buffer with a zero
        // length, which is the documented way to ask Windows to re-read its own
        // proxy settings.
        let changed = unsafe {
            InternetSetOptionW(
                std::ptr::null_mut(),
                INTERNET_OPTION_SETTINGS_CHANGED,
                std::ptr::null_mut(),
                0,
            )
        };
        let refreshed = unsafe {
            InternetSetOptionW(
                std::ptr::null_mut(),
                INTERNET_OPTION_REFRESH,
                std::ptr::null_mut(),
                0,
            )
        };
        if changed == 0 || refreshed == 0 {
            return Err("Windows did not accept the proxy change".to_string());
        }
        Ok(())
    }
}

#[cfg(not(windows))]
mod imp {
    use super::UNSUPPORTED;

    pub fn read() -> Result<Option<String>, String> {
        Ok(None)
    }

    pub fn write(_server: &str) -> Result<(), String> {
        Err(UNSUPPORTED.to_string())
    }

    pub fn clear() -> Result<(), String> {
        Err(UNSUPPORTED.to_string())
    }

    pub fn notify() -> Result<(), String> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_recorded_address_is_ours() {
        assert!(is_ours(Some("127.0.0.1:7890"), Some("127.0.0.1:7890")));
        // Another client set its own proxy after ours went off.
        assert!(!is_ours(Some("127.0.0.1:7890"), Some("127.0.0.1:1080")));
        // Nothing recorded: whatever is on is not ours to turn off.
        assert!(!is_ours(None, Some("127.0.0.1:7890")));
        // Already off.
        assert!(!is_ours(Some("127.0.0.1:7890"), None));
        assert!(!is_ours(None, None));
    }
}
