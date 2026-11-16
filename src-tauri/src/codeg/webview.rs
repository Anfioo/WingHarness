//! The child webview the Codeg page is shown in.
//!
//! A child webview rather than an `<iframe>` — the same reasons as
//! [`crate::plugins::browser`], plus one of its own: the page is a whole app
//! with its own router and its own history, and an iframe would hide both from
//! the app's tab bar.
//!
//! **One webview per host window, ever.** Codeg's own client asks the browser
//! for extra windows (its settings page is one of them), which in this app must
//! not become a second view of the same app: the embedded page is the only copy
//! of Codeg, and the app's tab bar is what stands in for those windows. Two
//! pieces make that work:
//!
//! * The page's `window.open` is replaced by the injection script below. Codeg
//!   reserves a window with `window.open("", name)` and then assigns the route
//!   to it; handing back the page itself turns that assignment into an
//!   in-place navigation, so the route changes in the one webview and the
//!   address poll in the frontend turns it into a tab.
//! * `on_navigation` refuses any address off the server's own origin. A link
//!   that genuinely belongs outside the app is reported through
//!   [`EXTERNAL_LINK_EVENT`] so the frontend can hand it to the user's browser,
//!   which is what the target would have done in a real browser tab.
//!
//! The page cannot call this app's commands: Tauri injects its IPC bootstrap
//! into every webview, but the app's ACL manifest compares the caller's origin,
//! and a page served from `http://127.0.0.1:<port>` is a remote origin that no
//! capability covers (see `build.rs`).

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use serde::Deserialize;
use tauri::webview::{Webview, WebviewBuilder};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewUrl};
use url::Url;

use crate::config;
use crate::plugins::browser::{same_origin, Bounds};

use super::server;

/// Prefix of the page's webview label.
const LABEL_PREFIX: &str = "codeg-view-";

/// Emitted when the page asks to navigate somewhere outside its own origin.
///
/// The payload is the address; the frontend opens it in the system browser.
pub const EXTERNAL_LINK_EVENT: &str = "codeg-external-link";

/// The app's appearance, handed to the webview.
///
/// `custom` is Codeg's own `codeg-custom-theme` value — one JSON object with a
/// `light` and a `dark` bucket, already limited to the variables Codeg accepts.
/// It is a string rather than a value because it is stored verbatim in the
/// page's `localStorage`.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Theme {
    /// The resolved mode: `light` or `dark`. Codeg's own "system" value is never
    /// used here — the app resolves it, so the page never disagrees with the
    /// window it sits in.
    pub mode: String,
    pub custom: String,
}

/// Who asked for the page: the document (page load) it belongs to, and the
/// effect run inside that document.
///
/// The same two halves as [`crate::plugins::browser`], and for the same two
/// races: a document that is being replaced must not close the page the next
/// document claimed, and a superseded effect run must not close the page the
/// live run is showing.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Owner {
    document: String,
    run: String,
}

fn owners() -> &'static Mutex<HashMap<String, Owner>> {
    static OWNERS: OnceLock<Mutex<HashMap<String, Owner>>> = OnceLock::new();
    OWNERS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Serializes creating and destroying the page.
///
/// The frontend can ask to open and to close the same page in the same breath —
/// a React remount does exactly that — and both calls are asynchronous, so
/// without this they interleave and the answer is wrong even though the page is
/// fine.
fn ops_lock() -> &'static Mutex<()> {
    static OPS: OnceLock<Mutex<()>> = OnceLock::new();
    OPS.get_or_init(|| Mutex::new(()))
}

/// The webview label for one host window.
///
/// The host is encoded because a window label may contain `.`, which a webview
/// label may not (see [`crate::plugins::encode_label_id`]).
pub fn label_of(host: &str) -> String {
    format!("{LABEL_PREFIX}{}", crate::plugins::encode_label_id(host))
}

fn belongs_to_host(host: &str, label: &str) -> bool {
    label == label_of(host)
}

fn webview_of(app: &AppHandle, host: &str) -> Result<Webview, String> {
    app.get_webview(&label_of(host))
        .ok_or_else(|| "The Codeg page is not open.".to_string())
}

fn insert_owner(label: &str, document: &str, run: &str) {
    if let Ok(mut owners) = owners().lock() {
        owners.insert(
            label.to_string(),
            Owner {
                document: document.to_string(),
                run: run.to_string(),
            },
        );
    }
}

fn forget_owner(label: &str) {
    if let Ok(mut owners) = owners().lock() {
        owners.remove(label);
    }
}

fn is_owned_by(label: &str, document: &str, run: &str) -> bool {
    owners()
        .lock()
        .map(|owners| {
            owners.get(label)
                == Some(&Owner {
                    document: document.to_string(),
                    run: run.to_string(),
                })
        })
        .unwrap_or(false)
}

fn is_owned_by_document(label: &str, document: &str) -> bool {
    owners()
        .lock()
        .map(|owners| {
            owners
                .get(label)
                .map(|owner| owner.document == document)
                .unwrap_or(false)
        })
        .unwrap_or(false)
}

/// Opens the Codeg page over `bounds`, at `route`.
///
/// Reuses the webview when it already exists, so moving between tabs never
/// stacks a second copy. `route` is a path on the server (`/workspace`), which
/// is what the tab bar keeps.
pub fn open(
    app: &AppHandle,
    host: &str,
    document: &str,
    run: &str,
    route: &str,
    bounds: Bounds,
    theme: &Theme,
) -> Result<(), String> {
    let _guard = ops_lock()
        .lock()
        .map_err(|_| "Codeg view lock poisoned.".to_string())?;

    let label = label_of(host);
    insert_owner(&label, document, run);

    // A page of this host owned by another document is what the previous page
    // load left behind; it would otherwise stay painted over whatever the app
    // shows next. The label matches, so a reuse below is genuinely this
    // document's page.
    sweep(app, host, document);

    if app.get_webview(&label).is_some() {
        set_bounds(app, host, bounds)?;
        return set_visible(app, host, true);
    }

    let config = config::load().codeg;
    let base = config.url();
    let origin = Url::parse(&format!("{base}/"))
        .map_err(|error| format!("Invalid Codeg address: {error}"))?;
    let target = Url::parse(&format!("{base}{}", normalize_route(route)))
        .map_err(|error| format!("Invalid Codeg route: {error}"))?;

    let token = server::token(app)?;
    let script = initialization_script(&token, theme);

    let window = app
        .get_window(host)
        .ok_or_else(|| format!("Window '{host}' is not available."))?;

    let nav_app = app.clone();
    let webview = window
        .add_child(
            WebviewBuilder::new(label.clone(), WebviewUrl::External(target))
                // Runs before any of the page's own scripts: the token and the
                // theme have to be in `localStorage` before Codeg reads them, or
                // the first frame is a login page and a flash of the default
                // light theme.
                .initialization_script(&script)
                .on_navigation(move |next| {
                    if same_origin(&origin, next) {
                        return true;
                    }
                    // Everything off this origin belongs to the user's browser,
                    // not to a webview whose whole address space the tab bar has
                    // to be able to describe.
                    let _ = nav_app.emit(EXTERNAL_LINK_EVENT, next.to_string());
                    false
                }),
            LogicalPosition::new(bounds.x, bounds.y),
            LogicalSize::new(bounds.width.max(1.0), bounds.height.max(1.0)),
        )
        .map_err(|error| format!("Failed to open the Codeg page: {error}"));

    // Someone got there first (a concurrent open, or a page left over from a
    // reload). It exists, which is what the caller asked for.
    let webview = match webview {
        Ok(webview) => webview,
        Err(_) if app.get_webview(&label).is_some() => {
            set_bounds(app, host, bounds)?;
            return set_visible(app, host, true);
        }
        Err(error) => return Err(error),
    };

    let _ = webview;
    Ok(())
}

/// Moves and resizes the page to its placeholder.
pub fn set_bounds(app: &AppHandle, host: &str, bounds: Bounds) -> Result<(), String> {
    let webview = webview_of(app, host)?;
    webview
        .set_position(LogicalPosition::new(bounds.x, bounds.y))
        .map_err(|error| format!("Failed to move the Codeg page: {error}"))?;
    webview
        .set_size(LogicalSize::new(
            bounds.width.max(1.0),
            bounds.height.max(1.0),
        ))
        .map_err(|error| format!("Failed to resize the Codeg page: {error}"))
}

/// Shows or hides the page.
///
/// Needed because the page is an OS-level view: CSS cannot hide it, so a tab
/// that is not the selected one — or a page the router keeps cached but off
/// screen — has to say so explicitly.
pub fn set_visible(app: &AppHandle, host: &str, visible: bool) -> Result<(), String> {
    let webview = webview_of(app, host)?;
    let result = if visible {
        webview.show()
    } else {
        webview.hide()
    };
    result.map_err(|error| format!("Failed to show or hide the Codeg page: {error}"))
}

/// Navigates the page to another route on the server.
pub fn navigate(app: &AppHandle, host: &str, route: &str) -> Result<(), String> {
    let webview = webview_of(app, host)?;
    let config = config::load().codeg;
    let target = Url::parse(&format!("{}{}", config.url(), normalize_route(route)))
        .map_err(|error| format!("Invalid Codeg route: {error}"))?;

    let current = webview
        .url()
        .map_err(|error| format!("Failed to read the Codeg address: {error}"))?;
    if !same_origin(&current, &target) {
        return Err("Only routes of the Codeg server can be opened here.".to_string());
    }

    webview
        .navigate(target)
        .map_err(|error| format!("Failed to navigate the Codeg page: {error}"))
}

/// Reloads the page from the server.
pub fn reload(app: &AppHandle, host: &str) -> Result<(), String> {
    webview_of(app, host)?
        .reload()
        .map_err(|error| format!("Failed to reload the Codeg page: {error}"))
}

/// The address the page is on right now.
///
/// Polled rather than pushed: Codeg's router moves between routes with
/// `history.pushState`, which is not a navigation the host is told about but
/// does change the document's address.
pub fn current_url(app: &AppHandle, host: &str) -> Result<String, String> {
    webview_of(app, host)?
        .url()
        .map(|url| url.to_string())
        .map_err(|error| format!("Failed to read the Codeg address: {error}"))
}

/// Repaints the page in the app's current appearance, without a reload.
///
/// Writes the same two `localStorage` values the injection script wrote, then
/// dispatches the `storage` events Codeg's appearance provider listens for —
/// the same one a second Codeg tab would receive — and flips the document's own
/// mode class so its light and dark buckets are the right way round.
pub fn apply_theme(app: &AppHandle, host: &str, theme: &Theme) -> Result<(), String> {
    let script = theme_script(theme);
    webview_of(app, host)?
        .eval(&script)
        .map_err(|error| format!("Failed to restyle the Codeg page: {error}"))
}

/// Opens the page's own inspector.
#[cfg(any(debug_assertions, feature = "devtools"))]
pub fn devtools(app: &AppHandle, host: &str) -> Result<(), String> {
    webview_of(app, host)?.open_devtools();
    Ok(())
}

/// See the other [`devtools`]: a build without the inspector says so.
#[cfg(not(any(debug_assertions, feature = "devtools")))]
pub fn devtools(_app: &AppHandle, _host: &str) -> Result<(), String> {
    Err("DevTools are not available in this build.".to_string())
}

/// Closes the page, if the calling effect run still owns it.
pub fn close(app: &AppHandle, host: &str, document: &str, run: &str) {
    let _guard = ops_lock().lock();

    let label = label_of(host);
    if !is_owned_by(&label, document, run) {
        return;
    }
    if let Some(webview) = app.get_webview(&label) {
        let _ = webview.close();
    }
    forget_owner(&label);
}

/// Closes the page this document opened in `host`.
///
/// Called when the Codeg page is left or reloaded: a child webview belongs to
/// the window, so nothing else would take it down, and it would stay painted
/// over the next page.
pub fn close_all(app: &AppHandle, host: &str, document: &str) {
    let _guard = ops_lock().lock();

    let label = label_of(host);
    // Re-checked under the lock: an `open` may have handed the page to another
    // document between the caller deciding to close and this point.
    if !is_owned_by_document(&label, document) {
        return;
    }
    if let Some(webview) = app.get_webview(&label) {
        let _ = webview.close();
    }
    forget_owner(&label);
}

/// Closes this host's page when it belongs to a different document than
/// `document`.
///
/// Run as a new document opens the page. With pages cached the router keeps one
/// document alive at a time, so a page of this host owned by another document —
/// or by none at all, a leftover — is from the page that was just replaced.
fn sweep(app: &AppHandle, host: &str, document: &str) {
    let label = label_of(host);
    if !belongs_to_host(host, &label) {
        return;
    }

    let foreign = owners()
        .lock()
        .map(|owners| {
            owners
                .get(&label)
                .map(|owner| owner.document != document)
                .unwrap_or(false)
        })
        .unwrap_or(false);

    if foreign {
        if let Some(webview) = app.get_webview(&label) {
            let _ = webview.close();
        }
        forget_owner(&label);
    }
}

/// A route always starts with exactly one `/`.
fn normalize_route(route: &str) -> String {
    let route = route.trim();
    if route.is_empty() {
        return "/".to_string();
    }
    if route.starts_with('/') {
        route.to_string()
    } else {
        format!("/{route}")
    }
}

/// A JS string literal for `value`.
///
/// The values below are embedded in a script that runs before the page's own,
/// so anything that could end the literal — a quote, a backslash, a newline —
/// has to be escaped rather than pasted.
fn js_string(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_string())
}

/// The appearance keys Codeg carries in its own settings store.
///
/// Its appearance lives in this page's `localStorage`, which the backend cannot
/// read, so Codeg keeps a copy in its database — the mirror a config snapshot,
/// restore or rollback carries. Its own setters write that copy; a value this
/// app injects does not, so the copy is written here too.
///
/// Must match `SYNCED_APPEARANCE_KEYS` in Codeg's `src/lib/appearance-sync.ts`
/// (which a test of Codeg's own holds to `APPEARANCE_STORAGE_KEYS` in its
/// `appearance.rs`). The write is wholesale, so the whole set is read back from
/// the page rather than sending only the keys this app owns — a partial set
/// would drop the page's fonts, zoom and background from that copy.
const SYNCED_KEYS_JS: &str = r#"["theme","codeg-theme-color","codeg-zoom-level","codeg-welcome-quick-actions","codeg-chat-animations","codeg-chat-content-width","codeg-ui-font","codeg-ui-font-custom","codeg-ui-font-stack","codeg-editor-font","codeg-editor-font-custom","codeg-editor-font-size","codeg-editor-ligatures","codeg-editor-word-wrap","codeg-terminal-font","codeg-terminal-font-custom","codeg-terminal-font-size","codeg-terminal-ligatures","codeg-workspace-bg-enabled","codeg-workspace-bg-mask","codeg-workspace-bg-blur","codeg-workspace-bg-fill","codeg-workspace-bg-panel-opacity","codeg-custom-theme","codeg-custom-theme-enabled","codeg-custom-css","codeg-custom-css-enabled"]"#;

/// Copies the page's appearance into Codeg's settings store.
///
/// The same call Codeg's own setters make (`mirrorAppearanceNow` in
/// `src/lib/appearance-sync.ts`), over the same route, with the page's own token:
/// it has to come from inside the page, because that is where the values are.
const MIRROR_JS: &str = r#"function () {
  try {
    var keys = __KEYS__;
    var values = {};
    for (var index = 0; index < keys.length; index += 1) {
      var value = window.localStorage.getItem(keys[index]);
      if (value !== null) values[keys[index]] = value;
    }
    var token = window.localStorage.getItem("codeg_token") || "";
    fetch("/api/config_sync_mirror_appearance", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + token,
        "X-Requested-With": "XMLHttpRequest"
      },
      body: JSON.stringify({ values: values })
    }).catch(function () {});
  } catch (error) {}
}"#;

/// The mirror as a callable expression, for pasting into a script body.
fn mirror_call() -> String {
    format!("({})", MIRROR_JS.replace("__KEYS__", SYNCED_KEYS_JS))
}

/// The script that runs before the page's own scripts.
///
/// It may only touch `localStorage` and `window`: there is no DOM yet, and the
/// point of running this early is that nothing has been painted.
///
/// What it puts there, and why:
///
/// * `codeg_token` — the page's own key for the `Authorization` header, so the
///   page starts signed in and never shows its login form.
/// * `__CODEG_EMBEDDED__` — read by Codeg's transport switch. Tauri defines
///   `__TAURI_INTERNALS__` on every webview it creates, child webviews
///   included, so without a marker of our own Codeg would take itself for its
///   own desktop app and call commands that do not exist here.
/// * `theme` — the mode, already resolved by the app.
/// * `codeg-custom-theme` — the app's palette, as the two buckets Codeg expects.
///
/// Once the page has loaded it also calls the page's own appearance mirror, so
/// the copy of these values in Codeg's settings store is written on the first
/// open too. Codeg mirrors at launch by itself, but only for its own desktop
/// window, and this embed is a web build.
const INIT_SCRIPT: &str = r#"(function () {
  try {
    window.__CODEG_EMBEDDED__ = true;
    localStorage.setItem("codeg_token", __TOKEN__);
    localStorage.setItem("theme", __MODE__);
    localStorage.setItem("codeg-theme-color", "neutral");
    localStorage.setItem("codeg-custom-theme", __CUSTOM__);
    localStorage.setItem("codeg-custom-theme-enabled", "1");
  } catch (error) {}
  window.open = function (url) {
    if (typeof url === "string" && url && url !== "about:blank") {
      try {
        window.location.assign(new URL(url, window.location.href).href);
      } catch (error) {}
    }
    return window;
  };
  window.addEventListener("load", function () {
    // Late enough for the page's own boot to have had its say about the other
    // keys, so the mirror carries what the page settled on.
    setTimeout(function () {
      __MIRROR__();
    }, 1200);
  });
})();"#;

/// The script that repaints an already-loaded page.
const THEME_SCRIPT: &str = r##"(function () {
  var mode = __MODE__;
  var custom = __CUSTOM__;
  try {
    localStorage.setItem("theme", mode);
    localStorage.setItem("codeg-custom-theme", custom);
    localStorage.setItem("codeg-custom-theme-enabled", "1");
    window.dispatchEvent(
      new StorageEvent("storage", { key: "codeg-custom-theme", newValue: custom })
    );
    window.dispatchEvent(new StorageEvent("storage", { key: "theme", newValue: mode }));
  } catch (error) {}
  var root = document.documentElement;
  if (mode === "dark") {
    root.classList.add("dark");
  } else {
    root.classList.remove("dark");
  }
  root.style.colorScheme = mode;
  root.style.backgroundColor = mode === "dark" ? "#09090b" : "";
  // The page mirrors a mode it changed itself; this one it did not, and the
  // copy in its settings store would otherwise keep the previous palette.
  setTimeout(function () {
    __MIRROR__();
  }, 600);
})();"##;

fn initialization_script(token: &str, theme: &Theme) -> String {
    INIT_SCRIPT
        .replace("__TOKEN__", &js_string(token))
        .replace("__MODE__", &js_string(&theme.mode))
        .replace("__CUSTOM__", &js_string(&theme.custom))
        .replace("__MIRROR__", &mirror_call())
}

fn theme_script(theme: &Theme) -> String {
    THEME_SCRIPT
        .replace("__MODE__", &js_string(&theme.mode))
        .replace("__CUSTOM__", &js_string(&theme.custom))
        .replace("__MIRROR__", &mirror_call())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_route_is_normalized_to_a_single_leading_slash() {
        assert_eq!(normalize_route("/workspace"), "/workspace");
        assert_eq!(normalize_route("workspace"), "/workspace");
        assert_eq!(
            normalize_route("  /settings?tab=theme "),
            "/settings?tab=theme"
        );
        assert_eq!(normalize_route(""), "/");
    }

    #[test]
    fn a_page_label_is_scoped_to_its_host() {
        assert_eq!(label_of("main"), "codeg-view-main");
        assert!(belongs_to_host("main", &label_of("main")));
        assert!(!belongs_to_host("settings", &label_of("main")));
        // Not ours: the startup sweep and the close calls must leave these be.
        assert!(!belongs_to_host("main", "main"));
        assert!(!belongs_to_host("main", "plugin-view-main-x"));
    }

    /// The token and the theme are pasted into a script, so a value that could
    /// end the literal must not survive as itself.
    #[test]
    fn injected_values_are_escaped() {
        assert_eq!(js_string("a\"b"), "\"a\\\"b\"");
        assert_eq!(js_string("a\\b"), "\"a\\\\b\"");
        assert_eq!(js_string("a\nb"), "\"a\\nb\"");

        let script = initialization_script(
            "tok\"en",
            &Theme {
                mode: "dark".to_string(),
                custom: "{\"dark\":{\"primary\":\"oklch(1 0 0)\"}}".to_string(),
            },
        );
        assert!(script.contains(r#""codeg_token", "tok\"en""#), "{script}");
        assert!(script.contains(r#""theme", "dark""#), "{script}");
        assert!(!script.contains("__TOKEN__"), "{script}");
        assert!(!script.contains("__CUSTOM__"), "{script}");
        // The popup replacement is what keeps this app to one Codeg webview.
        assert!(script.contains("window.open = function"), "{script}");
        // The appearance copy in Codeg's own settings store is written from
        // inside the page, on this first open included.
        assert!(!script.contains("__MIRROR__"), "{script}");
        assert!(script.contains("config_sync_mirror_appearance"), "{script}");
        assert!(
            script.contains(r#""codeg-custom-theme-enabled""#),
            "{script}"
        );
    }

    /// `SYNCED_APPEARANCE_KEYS` in Codeg's `src/lib/appearance-sync.ts` — the
    /// backend replaces the whole row, so a shorter list silently drops keys.
    #[test]
    fn the_mirror_sends_the_whole_synced_set() {
        let script = mirror_call();
        assert_eq!(script.matches(r#""codeg-"#).count(), 26, "{script}");
        assert!(script.contains(r#""theme""#), "{script}");
        assert!(script.contains(r#""codeg-custom-css-enabled""#), "{script}");
    }

    #[test]
    fn the_theme_script_carries_the_mode_and_the_palette() {
        let script = theme_script(&Theme {
            mode: "light".to_string(),
            custom: "{}".to_string(),
        });
        assert!(script.contains(r#"var mode = "light""#), "{script}");
        assert!(script.contains(r#"var custom = "{}""#), "{script}");
        assert!(script.contains("classList.remove(\"dark\")"), "{script}");
        assert!(!script.contains("__MIRROR__"), "{script}");
        assert!(script.contains("config_sync_mirror_appearance"), "{script}");
    }
}
