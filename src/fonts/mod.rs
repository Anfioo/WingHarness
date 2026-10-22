//! The font families installed on this machine.
//!
//! The interface-font and code-font pickers in settings are the only consumers,
//! and they are part of the template's own appearance settings — so this lives
//! in the app crate rather than in an engine crate. `local_shell_list_fonts`
//! (the editor's PTY-side list) and [`crate::theme::fonts`] (Google Fonts
//! downloads) are separate concerns and stay where they are.

use serde::Serialize;

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FontFamily {
    pub family: String,
    pub monospaced: bool,
}

/// Every distinct family installed locally, sorted case-insensitively.
///
/// A family counts as monospaced if *any* of its faces says so — some families
/// ship both a proportional and a mono face, and the picker only needs a hint.
pub fn list() -> Vec<FontFamily> {
    let mut db = fontdb::Database::new();
    db.load_system_fonts();
    let mut families: std::collections::HashMap<String, bool> = std::collections::HashMap::new();
    for face in db.faces() {
        let Some((name, _)) = face.families.first() else {
            continue;
        };
        if name.starts_with('.') || name.trim().is_empty() {
            continue;
        }
        let monospaced = families.entry(name.clone()).or_insert(false);
        *monospaced |= face.monospaced;
    }
    let mut out: Vec<FontFamily> = families
        .into_iter()
        .map(|(family, monospaced)| FontFamily { family, monospaced })
        .collect();
    out.sort_by_key(|f| f.family.to_lowercase());
    out
}

/// Enumerating system fonts touches the disk and can be slow on a cold cache,
/// so it runs off the async runtime's worker threads.
#[tauri::command]
pub async fn fonts_list() -> Result<Vec<FontFamily>, String> {
    tauri::async_runtime::spawn_blocking(list)
        .await
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_installed_families_sorted_with_a_monospace_flag() {
        let fonts = list();
        assert!(!fonts.is_empty());
        assert!(fonts.iter().any(|f| f.monospaced));
        assert!(fonts.iter().all(|f| !f.family.starts_with('.')));
        let names: Vec<String> = fonts.iter().map(|f| f.family.to_lowercase()).collect();
        let mut sorted = names.clone();
        sorted.sort();
        assert_eq!(names, sorted);
    }
}
