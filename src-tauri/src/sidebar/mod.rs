//! The main window's sidebar layout: groups, first-level entries, and one level
//! of children under a parent entry.
//!
//! Only the sidebar manager writes this file, so the shape is defined here and
//! nowhere else. Entries reference a built-in page by its route id and a plugin
//! by its id — never a path — so renaming a page or moving its URL does not
//! invalidate a saved layout.

use std::collections::HashSet;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

use serde::{Deserialize, Serialize};

pub mod icons;

const DIR_NAME: &str = "sidebar";
const FILE_NAME: &str = "sidebar.json";
const VERSION: u32 = 1;

/// Distinguishes the temp files of two saves racing each other: a fixed name
/// would let one rename the other's half-written file into place.
static WRITE_SEQ: AtomicU32 = AtomicU32::new(0);

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SidebarConfig {
    /// Schema version, so a later shape change can migrate instead of guess.
    #[serde(default = "version")]
    pub version: u32,
    /// Whether the main window keeps each page mounted after the user moves on,
    /// so coming back finds it as they left it instead of rebuilt.
    #[serde(default)]
    pub cache_pages: bool,
    #[serde(default)]
    pub groups: Vec<SidebarGroup>,
}

fn version() -> u32 {
    VERSION
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SidebarGroup {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub items: Vec<SidebarItem>,
}

/// One first-level entry. A leaf navigates; a parent only holds children and
/// navigates to its default one when clicked.
///
/// `label`, `icon`, `icon_color`, `scope`, and `notes` are what the manager lets
/// a user change about an entry that is otherwise described by its page. Each
/// falls back to the page's own value when unset.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SidebarItem {
    /// A built-in page, referenced by its route id.
    Route {
        id: String,
        route: String,
        #[serde(default)]
        label: Option<String>,
        #[serde(default)]
        icon: Option<String>,
        /// CSS colour for the icon; the theme's own colour when unset.
        #[serde(default, rename = "iconColor")]
        icon_color: Option<String>,
        /// The page header's subtitle.
        #[serde(default)]
        scope: Option<String>,
        /// The text shown by the page header's question mark.
        #[serde(default)]
        notes: Option<String>,
    },
    /// A plugin's page, referenced by the plugin's id.
    Plugin {
        id: String,
        plugin: String,
        #[serde(default)]
        label: Option<String>,
        #[serde(default)]
        icon: Option<String>,
        /// CSS colour for the icon; the theme's own colour when unset.
        #[serde(default, rename = "iconColor")]
        icon_color: Option<String>,
        /// The page header's subtitle.
        #[serde(default)]
        scope: Option<String>,
        /// The text shown by the page header's question mark.
        #[serde(default)]
        notes: Option<String>,
    },
    /// A container whose children are the second level.
    #[serde(rename_all = "camelCase")]
    Parent {
        id: String,
        name: String,
        #[serde(default)]
        icon: Option<String>,
        /// CSS colour for the icon; the theme's own colour when unset.
        #[serde(default)]
        icon_color: Option<String>,
        /// Id of the child a click on the parent opens. Falls back to the first
        /// child when unset or dangling.
        #[serde(default)]
        default_child: Option<String>,
        #[serde(default)]
        children: Vec<SidebarItem>,
    },
}

/// Folder holding the layout file.
pub fn dir() -> PathBuf {
    crate::config::dir().join(DIR_NAME)
}

fn path() -> PathBuf {
    dir().join(FILE_NAME)
}

/// The saved layout, or `None` when it has never been written.
///
/// A file that will not parse is reported as missing rather than as an error:
/// the caller answers that by writing the default layout, which is the same
/// recovery a first run takes. Nothing else in the app depends on the file, so
/// there is no state worth refusing to start over.
pub fn load() -> Option<SidebarConfig> {
    let bytes = fs::read(path()).ok()?;
    match serde_json::from_slice(&bytes) {
        Ok(config) => Some(config),
        Err(error) => {
            eprintln!("Ignoring an unreadable sidebar layout: {error}");
            None
        }
    }
}

/// Replaces the layout, after checking that the manager sent something the
/// renderer can work with.
pub fn save(config: &SidebarConfig) -> Result<(), String> {
    validate(config)?;

    let dir = dir();
    fs::create_dir_all(&dir)
        .map_err(|error| format!("Failed to create {}: {error}", dir.display()))?;

    let json = serde_json::to_vec_pretty(config)
        .map_err(|error| format!("Failed to serialize the sidebar layout: {error}"))?;

    let target = path();
    let temp = temp_path(&target);
    {
        let mut file = fs::File::create(&temp)
            .map_err(|error| format!("Failed to write {}: {error}", temp.display()))?;
        file.write_all(&json)
            .map_err(|error| format!("Failed to write {}: {error}", temp.display()))?;
        file.sync_all()
            .map_err(|error| format!("Failed to flush {}: {error}", temp.display()))?;
    }

    fs::rename(&temp, &target)
        .map_err(|error| format!("Failed to replace {}: {error}", target.display()))
}

/// A temp file beside the target whose name differs on every call.
fn temp_path(target: &Path) -> PathBuf {
    let seq = WRITE_SEQ.fetch_add(1, Ordering::Relaxed);
    target.with_extension(format!("{seq}.tmp"))
}

/// Rejects the layouts the renderer could not draw: blank or duplicate ids, a
/// parent nested in a parent, and a default child that is not one of its own.
fn validate(config: &SidebarConfig) -> Result<(), String> {
    let mut ids: HashSet<&str> = HashSet::new();

    for group in &config.groups {
        if group.id.trim().is_empty() {
            return Err("A sidebar group has no id.".to_string());
        }
        if group.name.trim().is_empty() {
            return Err("A sidebar group has no name.".to_string());
        }
        if !ids.insert(group.id.as_str()) {
            return Err(format!("Duplicate sidebar id: {}", group.id));
        }

        for item in &group.items {
            validate_item(item, &mut ids)?;
        }
    }

    Ok(())
}

fn validate_item<'a>(item: &'a SidebarItem, ids: &mut HashSet<&'a str>) -> Result<(), String> {
    let id = match item {
        SidebarItem::Route {
            id,
            route,
            label,
            icon,
            icon_color,
            scope,
            notes,
        } => {
            if route.trim().is_empty() {
                return Err(format!("Sidebar entry {id} names no route."));
            }
            validate_texts(
                id,
                [
                    ("name", label.as_deref()),
                    ("icon", icon.as_deref()),
                    ("colour", icon_color.as_deref()),
                    ("summary", scope.as_deref()),
                    ("note", notes.as_deref()),
                ],
            )?;
            id
        }
        SidebarItem::Plugin {
            id,
            plugin,
            label,
            icon,
            icon_color,
            scope,
            notes,
        } => {
            if plugin.trim().is_empty() {
                return Err(format!("Sidebar entry {id} names no plugin."));
            }
            validate_texts(
                id,
                [
                    ("name", label.as_deref()),
                    ("icon", icon.as_deref()),
                    ("colour", icon_color.as_deref()),
                    ("summary", scope.as_deref()),
                    ("note", notes.as_deref()),
                ],
            )?;
            id
        }
        SidebarItem::Parent {
            id,
            name,
            icon,
            icon_color,
            default_child,
            children,
        } => {
            if name.trim().is_empty() {
                return Err(format!("Sidebar menu {id} has no name."));
            }
            validate_texts(
                id,
                [("icon", icon.as_deref()), ("colour", icon_color.as_deref())],
            )?;

            let mut child_ids: HashSet<&str> = HashSet::new();
            for child in children {
                if matches!(child, SidebarItem::Parent { .. }) {
                    return Err("A sidebar menu cannot be nested in another one.".to_string());
                }
                let child_id = child.id();
                child_ids.insert(child_id);
                validate_item(child, ids)?;
            }

            if let Some(default_child) = default_child {
                if !child_ids.contains(default_child.as_str()) {
                    return Err(format!(
                        "Sidebar menu {id} defaults to {default_child}, which is not one of its entries."
                    ));
                }
            }

            id
        }
    };

    if id.trim().is_empty() {
        return Err("A sidebar entry has no id.".to_string());
    }
    if !ids.insert(id.as_str()) {
        return Err(format!("Duplicate sidebar id: {id}"));
    }

    Ok(())
}

/// A saved text that is present but blank would draw an empty row or an empty
/// header line, so it is rejected the same way a blank name is.
fn validate_texts<'v>(
    id: &str,
    fields: impl IntoIterator<Item = (&'static str, Option<&'v str>)>,
) -> Result<(), String> {
    for (field, value) in fields {
        if let Some(value) = value {
            if value.trim().is_empty() {
                return Err(format!("Sidebar entry {id} has a blank {field}."));
            }
        }
    }
    Ok(())
}

impl SidebarItem {
    fn id(&self) -> &str {
        match self {
            SidebarItem::Route { id, .. }
            | SidebarItem::Plugin { id, .. }
            | SidebarItem::Parent { id, .. } => id,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config_with(items: Vec<SidebarItem>) -> SidebarConfig {
        SidebarConfig {
            version: VERSION,
            cache_pages: false,
            groups: vec![SidebarGroup {
                id: "group:workspace".to_string(),
                name: "Workspace".to_string(),
                items,
            }],
        }
    }

    fn route_with(icon: Option<&str>, icon_color: Option<&str>) -> SidebarItem {
        SidebarItem::Route {
            id: "route:overview".to_string(),
            route: "overview".to_string(),
            label: None,
            icon: icon.map(str::to_string),
            icon_color: icon_color.map(str::to_string),
            scope: None,
            notes: None,
        }
    }

    /// The colour rides under its own camel-case key, so a layout written by
    /// the manager parses back in the frontend untouched.
    #[test]
    fn icon_colour_round_trips_as_camel_case() {
        let config = config_with(vec![route_with(Some("custom:logo"), Some("#ff8800"))]);
        let json = serde_json::to_string(&config).unwrap();
        assert!(json.contains("\"iconColor\":\"#ff8800\""), "{json}");

        let parsed: SidebarConfig = serde_json::from_str(&json).unwrap();
        match &parsed.groups[0].items[0] {
            SidebarItem::Route {
                icon, icon_color, ..
            } => {
                assert_eq!(icon.as_deref(), Some("custom:logo"));
                assert_eq!(icon_color.as_deref(), Some("#ff8800"));
            }
            other => panic!("unexpected item: {other:?}"),
        }
    }

    #[test]
    fn a_blank_colour_is_rejected() {
        let config = config_with(vec![route_with(Some("Home"), Some("  "))]);
        assert!(validate(&config).is_err());
    }

    #[test]
    fn an_absent_colour_keeps_working() {
        let config = config_with(vec![route_with(None, None)]);
        assert!(validate(&config).is_ok());
    }
}
