//! The applications the tray's second-level menu offers, and the user's
//! curation of them.
//!
//! Scoop writes one Start Menu shortcut per installed app that provides one, and
//! that shortcut already carries everything a launch needs — the target, its
//! arguments, the working directory and the icon — so this lists those
//! shortcuts rather than walking manifests. Launching is a shell open of the
//! `.lnk` (`open_path`, which every Windows window already has), so nothing here
//! spawns a process itself.
//!
//! Pinned, hidden and order are app ids from this list, kept in
//! `<data dir>/tray.json` next to the rest of the app's state.

use std::collections::{BTreeSet, HashMap};
use std::env;
use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::config;

const FILE_NAME: &str = "tray.json";

/// Scoop's own Start Menu folder. Apps Scoop installs land here, one shortcut
/// each; the folder is absent until the first such app is installed.
const SHORTCUT_FOLDER: [&str; 5] = [
    "Microsoft",
    "Windows",
    "Start Menu",
    "Programs",
    "Scoop Apps",
];

/// One shortcut of that folder.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TrayAppView {
    /// The shortcut's file stem. Stable across restarts, and what the pin and
    /// hide lists store.
    pub id: String,
    /// The stem with underscores as spaces, which is how Scoop names the files
    /// of apps whose display name has spaces in it.
    pub display_name: String,
    /// The `.lnk` itself; the shell resolves target, arguments and icon.
    pub path: String,
}

/// The list, the curation, and the folder the list came from.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TrayAppsView {
    pub apps: Vec<TrayAppView>,
    pub pinned: Vec<String>,
    pub hidden: Vec<String>,
    /// The order the user dragged the rows into. Empty means "never reordered",
    /// in which case both sections are alphabetical.
    pub order: Vec<String>,
    /// Empty when the folder does not exist, which is what the settings page
    /// says out loud instead of showing a list that looks broken.
    pub folder: String,
}

#[derive(Serialize, Deserialize, Default, Clone)]
#[serde(default)]
struct TrayPrefs {
    pinned: Vec<String>,
    hidden: Vec<String>,
    order: Vec<String>,
}

fn prefs_path() -> PathBuf {
    config::dir().join(FILE_NAME)
}

fn read_prefs() -> TrayPrefs {
    fs::read_to_string(prefs_path())
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn write_prefs(prefs: &TrayPrefs) -> Result<(), String> {
    let path = prefs_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create {}: {error}", parent.display()))?;
    }
    let text = serde_json::to_string_pretty(prefs)
        .map_err(|error| format!("Failed to encode the tray settings: {error}"))?;
    fs::write(&path, text).map_err(|error| format!("Failed to write {}: {error}", path.display()))
}

fn shortcut_folder() -> Option<PathBuf> {
    let appdata = env::var_os("APPDATA")?;
    let mut path = PathBuf::from(appdata);
    for part in SHORTCUT_FOLDER {
        path.push(part);
    }
    Some(path)
}

/// Every `.lnk` in the folder and in its immediate subfolders, by display name.
///
/// Scoop nests the shortcuts of an app that has several of them under a folder
/// named after that app — `7-Zip\7-Zip File Manager.lnk` — so one level down is
/// the same list, not a different one.
///
/// A missing folder is an empty list rather than an error: it is the state of a
/// machine where nothing with a shortcut has been installed yet.
fn read_shortcuts(folder: &std::path::Path) -> Vec<TrayAppView> {
    let mut folders = vec![folder.to_path_buf()];
    if let Ok(entries) = fs::read_dir(folder) {
        for entry in entries.flatten() {
            if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                folders.push(entry.path());
            }
        }
    }

    let mut seen: BTreeSet<String> = BTreeSet::new();
    let mut apps: Vec<TrayAppView> = folders
        .iter()
        .filter_map(|dir| fs::read_dir(dir).ok())
        .flat_map(|entries| entries.flatten())
        .filter(|entry| entry.path().is_file())
        .filter_map(|entry| {
            let path = entry.path();
            if !path
                .extension()
                .is_some_and(|extension| extension.eq_ignore_ascii_case("lnk"))
            {
                return None;
            }
            let id = path.file_stem()?.to_string_lossy().to_string();
            if !seen.insert(id.to_ascii_lowercase()) {
                return None;
            }
            Some(TrayAppView {
                display_name: id.replace('_', " "),
                id,
                path: path.display().to_string(),
            })
        })
        .collect();

    apps.sort_by(|left, right| {
        left.display_name
            .to_ascii_lowercase()
            .cmp(&right.display_name.to_ascii_lowercase())
    });
    apps
}

fn lower(value: &str) -> String {
    value.to_ascii_lowercase()
}

/// The list in the order the tray draws it: pinned apps above a divider, and
/// inside each section the order the user dragged the rows into.
///
/// An app missing from `order` sorts after the ranked ones, alphabetically. A
/// fresh install has an empty `order`, so both sections stay alphabetical; a
/// newly installed app lands at the end of its section instead of silently
/// pushing the user's arrangement around.
fn sort_apps(mut apps: Vec<TrayAppView>, pinned: &[String], order: &[String]) -> Vec<TrayAppView> {
    let pinned: BTreeSet<String> = pinned.iter().map(|id| lower(id)).collect();
    let rank: HashMap<String, usize> = order
        .iter()
        .enumerate()
        .map(|(index, id)| (lower(id), index))
        .collect();

    apps.sort_by(|left, right| {
        let left_pinned = pinned.contains(&lower(&left.id));
        let right_pinned = pinned.contains(&lower(&right.id));
        right_pinned
            .cmp(&left_pinned)
            .then_with(|| {
                rank.get(&lower(&left.id))
                    .copied()
                    .unwrap_or(usize::MAX)
                    .cmp(&rank.get(&lower(&right.id)).copied().unwrap_or(usize::MAX))
            })
            .then_with(|| lower(&left.display_name).cmp(&lower(&right.display_name)))
            .then_with(|| lower(&left.id).cmp(&lower(&right.id)))
    });
    apps
}

/// The apps the tray menu can offer, with the user's pin, hide and order lists.
#[tauri::command(async)]
pub fn tray_apps_list() -> TrayAppsView {
    let folder = shortcut_folder();
    let apps = folder.as_deref().map(read_shortcuts).unwrap_or_default();
    let prefs = read_prefs();
    let apps = sort_apps(apps, &prefs.pinned, &prefs.order);

    TrayAppsView {
        apps,
        pinned: prefs.pinned,
        hidden: prefs.hidden,
        order: prefs.order,
        folder: folder
            .filter(|path| path.is_dir())
            .map(|path| path.display().to_string())
            .unwrap_or_default(),
    }
}

/// Trimmed, case-insensitively deduplicated, with the sent order preserved.
fn normalize_ids(list: Vec<String>) -> Vec<String> {
    let mut seen = BTreeSet::new();
    let mut ids = Vec::with_capacity(list.len());
    for id in list {
        let id = id.trim();
        if id.is_empty() || !seen.insert(lower(id)) {
            continue;
        }
        ids.push(id.to_string());
    }
    ids
}

/// Replaces the pin, hide and order lists.
///
/// Every list keeps the order it was sent in — the drag is the order, so sorting
/// here would undo it. Ids the folder no longer holds are kept as they are: an
/// app that is uninstalled and installed again comes back to where the user put
/// it, and dropping them here would silently undo the curation on a reinstall.
#[tauri::command(async)]
pub fn tray_apps_save(
    pinned: Vec<String>,
    hidden: Vec<String>,
    order: Vec<String>,
) -> Result<(), String> {
    write_prefs(&TrayPrefs {
        pinned: normalize_ids(pinned),
        hidden: normalize_ids(hidden),
        order: normalize_ids(order),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn app(id: &str) -> TrayAppView {
        TrayAppView {
            id: id.to_string(),
            display_name: id.to_string(),
            path: String::new(),
        }
    }

    fn ids(apps: &[TrayAppView]) -> Vec<&str> {
        apps.iter().map(|app| app.id.as_str()).collect()
    }

    #[test]
    fn pinned_first_then_the_saved_order() {
        let apps = vec![app("Bravo"), app("Alpha"), app("Charlie")];
        let sorted = sort_apps(
            apps,
            &["Charlie".to_string()],
            &[
                "Alpha".to_string(),
                "Bravo".to_string(),
                "Charlie".to_string(),
            ],
        );
        assert_eq!(ids(&sorted), ["Charlie", "Alpha", "Bravo"]);
    }

    #[test]
    fn without_an_order_both_sections_are_alphabetical() {
        let apps = vec![app("Bravo"), app("Alpha"), app("Charlie")];
        let sorted = sort_apps(apps, &["Charlie".to_string()], &[]);
        assert_eq!(ids(&sorted), ["Charlie", "Alpha", "Bravo"]);
    }

    #[test]
    fn unranked_apps_follow_the_ranked_ones_alphabetically() {
        let apps = vec![app("Delta"), app("Bravo"), app("Alpha")];
        let sorted = sort_apps(apps, &[], &["Delta".to_string(), "Bravo".to_string()]);
        assert_eq!(ids(&sorted), ["Delta", "Bravo", "Alpha"]);
    }
}
