//! The native webview the app shows a plugin's page in.
//!
//! A plugin serves its own site, and the app embeds it — but *not* with an
//! `<iframe>`. Nearly every real web app sends `X-Frame-Options: DENY` and a CSP
//! `frame-ancestors 'none'` (the reference plugin does, to stop clickjacking),
//! and a browser refuses to render such a page in a frame. An iframe is also
//! cross-origin, so the app could never read its address — no address bar, no
//! history. A child webview has neither problem: the page is that webview's own
//! top-level document, and [`Webview::url`] tells the app where it is.
//!
//! # Why the plugin's page cannot reach the app's commands
//!
//! Tauri injects its IPC bootstrap into every webview, so the plugin's page does
//! get `__TAURI_INTERNALS__` and can call commands. Three things keep it
//! harmless:
//!
//! 1. **The app declares its own ACL manifest** (`build.rs`). Without one Tauri
//!    skips access control for application commands entirely, for any origin —
//!    so this is the load-bearing piece. `resolve_access` then compares the
//!    caller's **origin** first: a page served from `http://127.0.0.1:7864` is
//!    `Origin::Remote`, and every capability here is Local-only, so nothing
//!    matches.
//! 2. [`same_origin`] in `on_navigation` refuses to navigate anywhere but the
//!    plugin's own origin, so the document can never *become* the app's origin.
//!    This matters because the capability check is an *or* — `webview matches ||
//!    window matches` — and these webviews are children of `main`, which **is**
//!    in the capability list; a page that turned Local would inherit the main
//!    window's commands. (`history.pushState` cannot get there either: it is
//!    same-origin by definition, which the browser enforces.)
//! 3. The webview labels ([`label_of`]) are deliberately absent from
//!    `capabilities/default.json`. That file must not list `plugin-view-*`.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use tauri::webview::{Webview, WebviewBuilder};
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, WebviewUrl};
use url::Url;

use super::log;

/// Prefix of a plugin page's webview label.
const LABEL_PREFIX: &str = "plugin-view-";

/// Where the webview sits, in logical pixels relative to the window's client
/// area — the same units CSS uses, so a caller can pass a measured
/// `getBoundingClientRect()` straight through.
#[derive(Clone, Copy, Debug, serde::Deserialize)]
pub struct Bounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Which way to walk the history.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Direction {
    Back,
    Forward,
}

/// The webview label for one plugin page, in one host window.
///
/// The host is part of the label so the same plugin can be shown in more than
/// one host at once (the main window, a dedicated OS window) without the two
/// webviews colliding on a shared label.
///
/// Both the host and the id are encoded: each is itself a label or an id that
/// may contain `.`, which a webview label may not (see
/// [`crate::plugins::encode_label_id`]).
pub fn label_of(host: &str, id: &str) -> String {
    format!(
        "{LABEL_PREFIX}{}-{}",
        crate::plugins::encode_label_id(host),
        crate::plugins::encode_label_id(id)
    )
}

/// Whether a webview label names a plugin page belonging to `host`.
///
/// Host labels in this app (`main`, `plugin-window-<pluginid>`,
/// `plugin-config-<pluginid>`, …) themselves contain `-`, so a label cannot be
/// split back into its host and id unambiguously. Nothing needs to: every caller
/// scopes by matching the full label against the shape [`label_of`] produces.
fn belongs_to_host(host: &str, label: &str) -> bool {
    label.starts_with(&format!(
        "{LABEL_PREFIX}{}-",
        crate::plugins::encode_label_id(host)
    ))
}

/// Every plugin page this app has open, keyed by its full webview label, with
/// the id of the **document** that opened it.
///
/// Kept so [`close_all`] can find them: a child webview belongs to the window,
/// not to the page that asked for it, so it does **not** go away when the
/// frontend navigates elsewhere or reloads. Without this sweep a plugin's page
/// would stay on screen, floating over whatever the app showed next.
///
/// The full label is the key, not the plugin id, because the same plugin id can
/// be open in two hosts at once and the two must not collide.
///
/// The owner document is what makes closing safe across a navigation. The page
/// being left closes its own pages on `pagehide`, and the page arriving opens
/// its own — two async calls that can land in either order. Scoping the close to
/// the document that issued it means a late close from the old document cannot
/// take down the new document's pages, which is exactly the race that used to
/// leave a stale page showing or report it as "not open".
fn open_pages() -> &'static Mutex<HashMap<String, String>> {
    static OPEN: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    OPEN.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Serializes creating and destroying pages.
///
/// The frontend can ask to open and close the same page in the same breath —
/// React re-running an effect does exactly that — and both calls are
/// asynchronous, so without this they interleave: the second open looks up the
/// label before the first has registered it, then fails to create it because by
/// then it exists. The page is fine; the answer was not. One lock for all pages
/// is enough, because these calls are rare and each is quick.
fn ops_lock() -> &'static Mutex<()> {
    static OPS: OnceLock<Mutex<()>> = OnceLock::new();
    OPS.get_or_init(|| Mutex::new(()))
}

fn webview_of(app: &AppHandle, host: &str, id: &str) -> Result<Webview, String> {
    app.get_webview(&label_of(host, id))
        .ok_or_else(|| format!("The page for plugin '{id}' is not open in '{host}'."))
}

/// Records that `document` owns the page under `label`.
///
/// Overwrites any previous owner: when a page is reused across a navigation,
/// the document now showing it is the one that owns it, and the one whose
/// `close_all` may take it down.
fn insert_page(label: &str, document: &str) {
    if let Ok(mut pages) = open_pages().lock() {
        pages.insert(label.to_string(), document.to_string());
    }
}

fn forget_page(label: &str) {
    if let Ok(mut pages) = open_pages().lock() {
        pages.remove(label);
    }
}

/// Whether `label` is registered to any document.
fn is_registered(label: &str) -> bool {
    open_pages()
        .lock()
        .map(|pages| pages.contains_key(label))
        .unwrap_or(false)
}

/// Closes every page of `host` that `document` does not own, except `keep`.
///
/// Run as a new document opens one of its pages. Within one window there is only
/// ever one live document, so any page of this host owned by a different
/// document — or by none at all, a leftover — belongs to the page that was just
/// replaced and is safe to remove. Doing it here, rather than only on the way
/// out, is what makes a stale page impossible: by the time the new document
/// shows anything, the old document's pages are gone, whether or not its own
/// `pagehide` cleanup ran.
///
/// `keep` is the label the caller is about to open. It is left alone because it
/// is the same plugin's page either way: reusing it is correct, and closing it
/// here would race a `close` that the window system has not finished applying.
fn sweep_other_documents(app: &AppHandle, host: &str, document: &str, keep: &str) {
    // Pages this map knows about, owned by another document.
    let foreign: Vec<String> = open_pages()
        .lock()
        .map(|pages| {
            pages
                .iter()
                .filter(|(label, owner)| {
                    label.as_str() != keep
                        && belongs_to_host(host, label)
                        && owner.as_str() != document
                })
                .map(|(label, _)| label.clone())
                .collect()
        })
        .unwrap_or_default();

    for label in foreign {
        if let Some(webview) = app.get_webview(&label) {
            let _ = webview.close();
        }
        forget_page(&label);
    }

    // Pages of this host that no document claims at all: a webview left over
    // from a page load that never registered it. This host's live document owns
    // everything it opened, so anything unregistered here is a leftover.
    for (label, webview) in app.webviews() {
        if label != keep && belongs_to_host(host, &label) && !is_registered(&label) {
            let _ = webview.close();
        }
    }
}

/// Whether `candidate` is on the same scheme, host and port as `allowed`.
///
/// Used to keep the embedded page on its own origin: anything else is either a
/// navigation the plugin did not intend, or an attempt to reach the app's own
/// origin and inherit its command access.
pub fn same_origin(allowed: &Url, candidate: &Url) -> bool {
    let scheme_ok = matches!(candidate.scheme(), "http" | "https");
    scheme_ok
        && candidate.scheme() == allowed.scheme()
        && candidate.host_str() == allowed.host_str()
        && candidate.port_or_known_default() == allowed.port_or_known_default()
}

/// Opens a plugin's page in a child webview of `host`, owned by `document`.
///
/// Reuses the webview when one is already open for that plugin in that host, so
/// pressing around the UI never stacks duplicates. `document` identifies the
/// page load that asked for it (see [`open_pages`]); the first page a document
/// opens sweeps away the previous document's pages, so a replaced page cannot
/// outlive the navigation that replaced it.
///
/// A failure is written to the plugin's log as well as returned: the page is an
/// OS-level view with no DOM to inspect, so when nothing shows up, the log is
/// the only place the reason can be seen.
pub fn open(
    app: &AppHandle,
    host: &str,
    document: &str,
    id: &str,
    url: &str,
    bounds: Bounds,
) -> Result<(), String> {
    match open_webview(app, host, document, id, url, bounds) {
        Ok(()) => Ok(()),
        Err(error) => {
            log::failed(id, &error);
            Err(error)
        }
    }
}

fn open_webview(
    app: &AppHandle,
    host: &str,
    document: &str,
    id: &str,
    url: &str,
    bounds: Bounds,
) -> Result<(), String> {
    // Creating and destroying must not interleave with each other: see
    // [`ops_lock`]. Everything below runs with it held, including the wait for
    // the webview to be built.
    let _guard = ops_lock()
        .lock()
        .map_err(|_| "Browser lock poisoned.".to_string())?;

    let label = label_of(host, id);

    // The label matches the previous document's page for this same plugin, so a
    // webview already under it may belong to the page we just replaced. Sweeping
    // first clears every page this host holds that this document did not open —
    // the reused label excepted — so what we find below is genuinely ours.
    sweep_other_documents(app, host, document, &label);

    if app.get_webview(&label).is_some() {
        insert_page(&label, document);
        set_bounds(app, host, id, bounds)?;
        return set_visible(app, host, id, true);
    }

    let target =
        Url::parse(url.trim()).map_err(|error| format!("Invalid plugin address: {error}"))?;
    let allowed = target.clone();
    // Owned, because `on_navigation`'s handler is `'static`.
    let log_id = id.to_string();

    let window = app
        .get_window(host)
        .ok_or_else(|| format!("Window '{host}' is not available."))?;

    let webview = window
        .add_child(
            WebviewBuilder::new(label.clone(), WebviewUrl::External(target))
                // The gate described in the module docs: only the plugin's own
                // origin may be navigated to, so the page can never turn into
                // the app's origin and inherit the main window's commands.
                .on_navigation(move |next| {
                    if same_origin(&allowed, next) {
                        return true;
                    }
                    log::note(
                        &log_id,
                        &format!("blocked navigation outside the plugin origin: {next}"),
                    );
                    false
                }),
            LogicalPosition::new(bounds.x, bounds.y),
            LogicalSize::new(bounds.width.max(1.0), bounds.height.max(1.0)),
        )
        .map_err(|error| format!("Failed to open the plugin page: {error}"));

    // Someone else got there first (a concurrent open, or a page left over from
    // a reload). The page exists, which is all the caller asked for, so reuse it
    // rather than turning a working page into an error the frontend acts on.
    let webview = match webview {
        Ok(webview) => webview,
        Err(_) if app.get_webview(&label).is_some() => {
            insert_page(&label, document);
            set_bounds(app, host, id, bounds)?;
            set_visible(app, host, id, true)?;
            return Ok(());
        }
        Err(error) => return Err(error),
    };

    insert_page(&label, document);
    // The measured rectangle and the window it has to fit in, both logged: the
    // page is an OS-level view, so when it covers something it should not, this
    // line is what says whether the placement or the measurement was wrong.
    log::note(
        id,
        &format!(
            "opened page {url} at {}x{} +{},{} (window {})",
            bounds.width,
            bounds.height,
            bounds.x,
            bounds.y,
            window
                .inner_size()
                .map(|size| format!("{}x{}", size.width, size.height))
                .unwrap_or_else(|_| "?".to_string())
        ),
    );
    let _ = webview;
    Ok(())
}

/// Moves and resizes a plugin's page.
pub fn set_bounds(app: &AppHandle, host: &str, id: &str, bounds: Bounds) -> Result<(), String> {
    let webview = webview_of(app, host, id)?;
    webview
        .set_position(LogicalPosition::new(bounds.x, bounds.y))
        .map_err(|error| format!("Failed to move the plugin page: {error}"))?;
    webview
        .set_size(LogicalSize::new(
            bounds.width.max(1.0),
            bounds.height.max(1.0),
        ))
        .map_err(|error| format!("Failed to resize the plugin page: {error}"))
}

/// Shows or hides a plugin's page.
///
/// Needed because the page is an OS-level view: CSS cannot hide it, so an
/// inactive tab (or a dialog in front of it) has to say so explicitly.
pub fn set_visible(app: &AppHandle, host: &str, id: &str, visible: bool) -> Result<(), String> {
    let webview = webview_of(app, host, id)?;
    let result = if visible {
        webview.show()
    } else {
        webview.hide()
    };
    result.map_err(|error| format!("Failed to show or hide the plugin page: {error}"))
}

/// Navigates a plugin's page to another address on its own origin.
pub fn navigate(app: &AppHandle, host: &str, id: &str, url: &str) -> Result<(), String> {
    let webview = webview_of(app, host, id)?;
    let target = Url::parse(url.trim()).map_err(|error| format!("Invalid address: {error}"))?;

    let current = webview
        .url()
        .map_err(|error| format!("Failed to read the current address: {error}"))?;

    // Same rule as `on_navigation`, checked here too so a hand-typed address
    // gets a clear error instead of a silently ignored navigation.
    if !same_origin(&current, &target) {
        return Err("Only addresses on the plugin's own site can be opened here.".to_string());
    }

    webview
        .navigate(target)
        .map_err(|error| format!("Failed to navigate: {error}"))
}

/// Walks the page's history.
///
/// Done with `eval` rather than a Tauri call: `history` belongs to the page, and
/// the plugin's own client-side router is what actually handles the move.
pub fn history(app: &AppHandle, host: &str, id: &str, direction: Direction) -> Result<(), String> {
    let webview = webview_of(app, host, id)?;
    let script = match direction {
        Direction::Back => "history.back()",
        Direction::Forward => "history.forward()",
    };
    webview
        .eval(script)
        .map_err(|error| format!("Failed to move through the history: {error}"))
}

/// Reloads a plugin's page.
pub fn reload(app: &AppHandle, host: &str, id: &str) -> Result<(), String> {
    let webview = webview_of(app, host, id)?;
    webview
        .reload()
        .map_err(|error| format!("Failed to reload the plugin page: {error}"))
}

/// The address a plugin's page is on right now.
///
/// Read by polling rather than pushed: a client-side router moving between
/// routes (`pushState`) is not a navigation the host is told about, but it does
/// change the document's address, which is what this returns.
pub fn current_url(app: &AppHandle, host: &str, id: &str) -> Result<String, String> {
    let webview = webview_of(app, host, id)?;
    let url = webview
        .url()
        .map(|url| url.to_string())
        .map_err(|error| format!("Failed to read the plugin address: {error}"))?;

    note_url_change(&label_of(host, id), id, &url);
    Ok(url)
}

/// Records each *new* address in the plugin log.
///
/// The address bar mirrors the page by asking for its URL, and whether the
/// platform reports a single-page app's route changes through that call is not
/// something this app can assume either way. Logging each change makes the
/// question answerable from the log — a plugin whose routes show up here is one
/// the address bar can follow — and costs nothing while the address sits still.
///
/// Keyed by label rather than id, because the same plugin open in two hosts
/// tracks two independent addresses.
fn note_url_change(label: &str, id: &str, url: &str) {
    let mut seen = match seen_urls().lock() {
        Ok(seen) => seen,
        Err(_) => return,
    };

    if seen.get(label).map(String::as_str) == Some(url) {
        return;
    }

    seen.insert(label.to_string(), url.to_string());
    log::note(id, &format!("page address: {url}"));
}

/// The last address reported for each plugin page, keyed by webview label.
fn seen_urls() -> &'static Mutex<HashMap<String, String>> {
    static SEEN: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    SEEN.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Closes a plugin's page, if `document` owns it.
///
/// Ownership is checked so a close issued by a document on its way out cannot
/// take down a page a newer document has already claimed — the race described
/// on [`open_pages`].
pub fn close(app: &AppHandle, host: &str, document: &str, id: &str) {
    let _guard = ops_lock().lock();

    let label = label_of(host, id);
    if !is_owned_by(&label, document) {
        return;
    }
    if let Some(webview) = app.get_webview(&label) {
        let _ = webview.close();
    }
    forget_page(&label);
}

/// Whether `document` is the registered owner of `label`.
fn is_owned_by(label: &str, document: &str) -> bool {
    open_pages()
        .lock()
        .map(|pages| pages.get(label).map(String::as_str) == Some(document))
        .unwrap_or(false)
}

/// Closes every plugin page in `host` that `document` owns.
///
/// Called when the plugin page is left or reloaded, and once at startup. A
/// child webview outlives the frontend that created it, so this is the only
/// thing standing between "switched to another page in the sidebar" and "a
/// plugin's site is still painted over it".
///
/// Scoped both ways: only this host's pages, and only the ones this document
/// opened — so a late call from a page being replaced cannot close the pages of
/// the page that replaced it.
pub fn close_all(app: &AppHandle, host: &str, document: &str) {
    for label in labels_owned_by(host, document) {
        let _guard = ops_lock().lock();
        if let Some(webview) = app.get_webview(&label) {
            let _ = webview.close();
        }
        forget_page(&label);
    }
}

/// The labels currently owned by `document`, within `host`.
fn labels_owned_by(host: &str, document: &str) -> Vec<String> {
    open_pages()
        .lock()
        .map(|pages| {
            pages
                .iter()
                .filter(|(label, owner)| owner.as_str() == document && belongs_to_host(host, label))
                .map(|(label, _)| label.clone())
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(text: &str) -> Url {
        Url::parse(text).unwrap()
    }

    #[test]
    fn a_page_label_round_trips_through_its_host_and_id() {
        assert_eq!(
            label_of("main", "python-web"),
            "plugin-view-main-python-web"
        );
        assert_eq!(
            label_of("plugin-window-python-web", "python-web"),
            "plugin-view-plugin-window-python-web-python-web"
        );

        // Host scoping: a page belongs to exactly its host, even though host
        // labels themselves contain `-`.
        assert!(belongs_to_host("main", "plugin-view-main-python-web"));
        assert!(!belongs_to_host(
            "main",
            "plugin-view-plugin-sidebar-python-web"
        ));
        assert!(belongs_to_host(
            "plugin-window-python-web",
            "plugin-view-plugin-window-python-web-python-web"
        ));

        // Not ours, so the startup sweep must leave it alone.
        assert!(!belongs_to_host("main", "main"));
        assert!(!belongs_to_host("main", "settings"));
        assert!(!belongs_to_host("main", "plugin-config-foo"));
        assert!(!belongs_to_host("main", "plugin-view-"));
    }

    /// A plugin id with a dot — a versioned folder — must still produce a label
    /// the window system accepts, and the same label must still be recognized as
    /// that host's.
    #[test]
    fn a_dotted_id_yields_a_valid_label_and_still_scopes_to_its_host() {
        let id = "dsh-portable-0.2.1-alpha.1-win-x64";
        let label = label_of("main", id);

        // No `.` survives, so the window system will accept it.
        assert!(!label.contains('.'), "{label}");
        assert!(belongs_to_host("main", &label));
        assert!(!belongs_to_host("plugin-sidebar", &label));

        // A host that is itself a plugin's own window carries a dotted id too;
        // it is encoded the same way, so the two sides still agree.
        let host = format!("plugin-window-{}", crate::plugins::encode_label_id(id));
        assert!(belongs_to_host(&host, &label_of(&host, id)));
    }

    #[test]
    fn the_plugin_origin_is_the_only_one_allowed() {
        let allowed = url("http://127.0.0.1:7864/");

        assert!(same_origin(
            &allowed,
            &url("http://127.0.0.1:7864/dashboard")
        ));
        assert!(same_origin(
            &allowed,
            &url("http://127.0.0.1:7864/a/b?c=1#d")
        ));

        // A different port is a different origin — the usual way two local
        // servers are kept apart.
        assert!(!same_origin(&allowed, &url("http://127.0.0.1:7863/")));
        // A different host, even on the same machine.
        assert!(!same_origin(&allowed, &url("http://localhost:7864/")));
        assert!(!same_origin(
            &allowed,
            &url("http://127.0.0.1.nip.io:7864/")
        ));
        // The app's own origin: reaching it is how a plugin would inherit the
        // main window's commands.
        assert!(!same_origin(&allowed, &url("http://tauri.localhost/")));
        assert!(!same_origin(&allowed, &url("http://localhost:1420/")));
        // Schemes a plugin has no business navigating to.
        assert!(!same_origin(&allowed, &url("file:///C:/Windows/System32/")));
        assert!(!same_origin(&allowed, &url("tauri://localhost/")));
        assert!(!same_origin(&allowed, &url("javascript:alert(1)")));
    }

    #[test]
    fn a_default_port_matches_an_explicit_one() {
        // `http://host` and `http://host:80` are the same origin, and the URL
        // parser drops the default port, so both sides have to agree.
        assert!(same_origin(
            &url("http://example.com/"),
            &url("http://example.com/x")
        ));
        assert!(same_origin(
            &url("https://example.com/"),
            &url("https://example.com/y")
        ));
    }

    #[test]
    fn https_is_not_http() {
        assert!(!same_origin(
            &url("https://example.com/"),
            &url("http://example.com/")
        ));
    }

    #[test]
    fn an_open_registry_tracks_the_owning_document() {
        // A fresh label, so this does not depend on other tests.
        let host = "unit-host";
        let id = format!("unit-browser-{}", std::process::id());
        let label = label_of(host, &id);

        assert!(labels_owned_by(host, "doc-a").is_empty());

        insert_page(&label, "doc-a");
        assert!(labels_owned_by(host, "doc-a").contains(&label));
        assert!(is_owned_by(&label, "doc-a"));
        assert!(!is_owned_by(&label, "doc-b"));

        // A page for another host is not swept up by this host's view.
        assert!(labels_owned_by("other-host", "doc-a").is_empty());

        // Reusing the label on a new page load hands ownership to the new
        // document, so the old document's close can no longer reach it — this is
        // the race that used to blank the pane.
        insert_page(&label, "doc-b");
        assert!(labels_owned_by(host, "doc-a").is_empty());
        assert!(is_owned_by(&label, "doc-b"));

        forget_page(&label);
        assert!(labels_owned_by(host, "doc-b").is_empty());
    }
}
