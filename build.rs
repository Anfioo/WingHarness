//! Every command the app's own pages are allowed to call.
//!
//! Naming them here is what puts the application behind the ACL. Tauri only
//! checks access control for application commands when the app declares its own
//! manifest — without one, *every* application command is callable from *any*
//! webview, regardless of where its document came from
//! (`src/webview/mod.rs`: "we only check ACL on plugin commands or if the app
//! defined its ACL manifest").
//!
//! That matters here because not every webview is one of this app's windows:
//! `capabilities/*.json` grants these permissions to `main`, `about`,
//! `settings` and `tray-menu` only, and the ACL additionally requires the
//! caller's origin to match. A document that reaches a webview from anywhere
//! else therefore cannot call `local_shell_start`, `project_write`, or anything
//! else below.
//!
//! Adding a command to `invoke.rs` therefore also means adding it here and
//! granting `allow-<command>` in `capabilities/default.json`. Miss it, and that
//! command fails at runtime with "not allowed by ACL" — so [`assert_acl_matches_commands`]
//! below checks the two lists against each other and fails this build instead.
use std::collections::HashSet;

const COMMANDS: &[&str] = &[
    "cancel_update_download",
    "download_and_install_update",
    "fonts_list",
    "get_config",
    "is_update_download_active",
    "local_shell_kill",
    "local_shell_list_fonts",
    "local_shell_resize",
    "local_shell_start",
    "local_shell_write",
    "notes_delete",
    "notes_list",
    "notes_mkdir",
    "notes_rename",
    "notes_write",
    "open_devtools",
    "preview_bytes",
    "preview_metadata",
    "project_delete",
    "project_info",
    "project_mkdir",
    "project_move",
    "project_read",
    "project_tree",
    "project_write",
    "quit_app",
    "save_config",
    "set_data_dir",
    "theme_fonts_css",
    "update_tray_menu",
];

/// Where the permissions granted to this app's own windows are listed.
const CAPABILITIES: &str = "capabilities/default.json";

/// Fails the build when `COMMANDS` and `capabilities/default.json` disagree.
///
/// The ACL is checked at *runtime*. A command that is registered but not granted
/// compiles fine, ships fine, and then fails the first time anything calls it —
/// with "not allowed by ACL", from a code path that is usually far from the
/// declaration. Since both lists are maintained by hand and edited together on
/// every feature change, drift is a matter of when, not if; this is the only
/// point where it can be caught cheaply.
///
/// Namespaced permissions (`core:window:allow-close`, `dialog:allow-open`, ...)
/// belong to Tauri's own plugins rather than to this app, so they are skipped —
/// only the bare `allow-<command>` entries are compared.
fn assert_acl_matches_commands() {
    let raw = std::fs::read_to_string(CAPABILITIES)
        .unwrap_or_else(|error| panic!("cannot read {CAPABILITIES}: {error}"));
    let manifest: serde_json::Value = serde_json::from_str(&raw)
        .unwrap_or_else(|error| panic!("cannot parse {CAPABILITIES}: {error}"));
    let permissions = manifest["permissions"]
        .as_array()
        .unwrap_or_else(|| panic!("{CAPABILITIES} has no `permissions` array"));

    let mut granted: HashSet<String> = HashSet::new();
    for entry in permissions {
        let Some(name) = entry.as_str() else {
            continue;
        };
        if name.contains(':') {
            continue;
        }
        let Some(command) = name.strip_prefix("allow-") else {
            panic!("{CAPABILITIES} has a non-namespaced permission that is not `allow-*`: `{name}`");
        };
        let command = command.replace('-', "_");
        if !granted.insert(command.clone()) {
            panic!("{CAPABILITIES} grants `{name}` more than once");
        }
    }

    let mut declared: HashSet<&str> = HashSet::new();
    for command in COMMANDS {
        if !declared.insert(command) {
            panic!("build.rs lists `{command}` in COMMANDS more than once");
        }
    }

    let granted_snake: HashSet<&str> = granted.iter().map(String::as_str).collect();

    let mut missing: Vec<&str> = declared.difference(&granted_snake).copied().collect();
    let mut stray: Vec<&str> = granted_snake.difference(&declared).copied().collect();

    if !missing.is_empty() || !stray.is_empty() {
        missing.sort_unstable();
        stray.sort_unstable();
        panic!(
            "build.rs and {CAPABILITIES} disagree about the app's commands.\n\
             \n\
             Declared in COMMANDS but not granted — these fail at runtime with \n\
             \"not allowed by ACL\":\n    {}\n\
             \n\
             Granted but not declared in COMMANDS:\n    {}",
            missing.join("\n    "),
            stray.join("\n    "),
        );
    }
}

fn main() {
    for path in [CAPABILITIES, "build.rs"] {
        println!("cargo:rerun-if-changed={path}");
    }
    assert_acl_matches_commands();

    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to run tauri-build");
}
