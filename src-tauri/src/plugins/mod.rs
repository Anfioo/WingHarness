//! User-installed plugins: zips dropped onto the settings page.
//!
//! Not to be confused with Tauri plugins (see [`system_tray`]), which are Rust
//! crates compiled into the app. These are data: a folder, a `plugin.json` and
//! a script the user supplies.

pub mod browser;
pub mod config_files;
pub mod log;
pub mod manifest;
pub mod probe;
pub mod registry;
pub mod runner;
pub mod system_tray;
/// Windows only: the tray's themed right-click menu. Everywhere else the
/// native menu is the platform-correct form — see the module docs.
#[cfg(target_os = "windows")]
pub mod tray_popup;

/// Encodes a plugin id for use inside a window or webview label.
///
/// Tauri labels allow only alphanumerics and `-`, `/`, `:`, `_`, but a plugin
/// id may also contain `.` — a versioned folder like `dsh-0.2.1-win-x64` is
/// normal, and [`manifest::validate_id`] allows it. A raw id in a label is
/// rejected by the window system outright, so `.` is mapped to `:` — the one
/// label character an id can never contain, since `validate_id` forbids it. The
/// mapping is therefore collision-free and reversible ([`decode_label_id`]).
pub fn encode_label_id(id: &str) -> String {
    id.replace('.', ":")
}

/// Recovers a plugin id from its [`encode_label_id`] form.
pub fn decode_label_id(encoded: &str) -> String {
    encoded.replace(':', ".")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_label_id_round_trips_and_clears_the_forbidden_character() {
        // A versioned id — the shape that first hit the window system's rule.
        let id = "dsh-portable-0.2.1-alpha.1-win-x64";
        let encoded = encode_label_id(id);
        assert!(!encoded.contains('.'), "{encoded}");

        // Every character left is one Tauri accepts in a label.
        assert!(encoded
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '/' | ':' | '_')));
        assert_eq!(decode_label_id(&encoded), id);

        // An id with nothing to encode is left exactly as it is.
        assert_eq!(encode_label_id("python-web"), "python-web");
        assert_eq!(decode_label_id("python-web"), "python-web");
    }
}
