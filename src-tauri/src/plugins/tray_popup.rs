//! The themed right-click menu on the system tray icon.
//!
//! The native tray menu cannot follow the app's theme, so right-clicks instead
//! pop a frameless, transparent window (`tray-menu`, declared in
//! `tauri.conf.json`) holding an ordinary shadcn menu. This module owns that
//! window's position and lifetime; its contents live in
//! `src/windows/tray-menu/index.tsx`.
//!
//! The same window also grows a Clash flyout when the pointer rests on the
//! menu's Clash row: the window widens leftwards (or rightwards, when the icon
//! sits near the left edge) and the page draws the flyout next to the menu.
//! Growing one window rather than opening a second one keeps a single hover and
//! blur owner.
//!
//! Windows only. On macOS a native menu *is* the platform-correct form, and
//! Linux keeps the menu it had, so `system_tray` never calls in there.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, Position, Rect, Runtime, Size};

/// Label of the popup window declared in `tauri.conf.json`.
const TRAY_MENU_LABEL: &str = "tray-menu";

/// Emitted to the popup just before it is shown. The page uses it to reset the
/// flyout and reload the state the menu shows.
pub const OPENED_EVENT: &str = "tray-menu:opened";

// Keep in sync with src/windows/tray-menu/index.tsx — the popup's row height is
// fixed in CSS, so the window size is arithmetic rather than a measurement.
const MENU_WIDTH: f64 = 220.0;
const MENU_ITEM_HEIGHT: f64 = 32.0;
const MENU_PAD_Y: f64 = 4.0;
const MENU_DIVIDER_HEIGHT: f64 = 9.0;
/// Show window / Settings / Space preview / Open file / Clash / FRP / Quit.
const MENU_ITEM_COUNT: f64 = 7.0;

/// The Clash flyout. It sits beside the menu column, taller than it, so the
/// menu keeps its place and the flyout grows upward.
const PANEL_WIDTH: f64 = 340.0;
const PANEL_HEIGHT: f64 = 460.0;

/// The tray click itself blurs whatever had focus, so the popup receives a blur
/// right after being shown. Ignore blurs that fall inside this window.
const FOCUS_GRACE: Duration = Duration::from_millis(200);
/// A right-click landing this soon after a hide is the one that *closed* the
/// popup, not a request to reopen it.
const REOPEN_GUARD: Duration = Duration::from_millis(250);

/// Where the tray icon was when the popup opened, in physical pixels. The
/// Clash flyout is laid out against this, so both directions stay anchored.
#[derive(Clone, Copy)]
struct Anchor {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

struct PopupState {
    shown_at: Option<Instant>,
    hidden_at: Option<Instant>,
    anchor: Option<Anchor>,
}

/// Single tray icon, so a single set of timestamps — no need for managed state.
static STATE: Mutex<PopupState> = Mutex::new(PopupState {
    shown_at: None,
    hidden_at: None,
    anchor: None,
});

/// Whether the blur handler is in place. It cannot be registered where the tray
/// itself is built: plugin setup hooks run before the runtime creates the
/// windows declared in `tauri.conf.json`, so the popup does not exist yet.
static BLUR_WIRED: AtomicBool = AtomicBool::new(false);

/// Which side of the menu column the flyout took, and which side of the icon the
/// popup hangs on. The page needs both: the menu column has to stay under the
/// pointer, and the card has to be aligned to the icon's edge.
#[derive(Debug, Clone, serde::Serialize)]
pub struct TrayMenuLayout {
    /// `left` or `right`.
    pub side: &'static str,
    /// `up` (popup above the icon) or `down` (taskbar at the top).
    pub vertical: &'static str,
}

fn menu_height() -> f64 {
    MENU_PAD_Y * 2.0 + MENU_ITEM_HEIGHT * MENU_ITEM_COUNT + MENU_DIVIDER_HEIGHT
}

fn hide<R: Runtime>(window: &tauri::WebviewWindow<R>) {
    let _ = window.hide();
    if let Ok(mut state) = STATE.lock() {
        state.hidden_at = Some(Instant::now());
    }
}

fn mark_shown(anchor: Anchor) {
    if let Ok(mut state) = STATE.lock() {
        state.shown_at = Some(Instant::now());
        state.anchor = Some(anchor);
    }
}

fn within_focus_grace() -> bool {
    STATE
        .lock()
        .map(|state| {
            state
                .shown_at
                .is_some_and(|at| at.elapsed() < FOCUS_GRACE)
        })
        .unwrap_or(false)
}

fn recently_hidden() -> bool {
    STATE
        .lock()
        .map(|state| {
            state
                .hidden_at
                .is_some_and(|at| at.elapsed() < REOPEN_GUARD)
        })
        .unwrap_or(false)
}

/// Anchor to place the popup against: the tray icon's physical bounds.
///
/// An icon sitting in the "hidden icons" overflow panel reports an all-zero
/// rect; the click position is then the only anchor there is.
fn rect_bounds(rect: &Rect, pointer: PhysicalPosition<f64>) -> Anchor {
    let (x, y, width, height) = match (rect.position, rect.size) {
        (Position::Physical(p), Size::Physical(s)) => {
            (p.x as f64, p.y as f64, s.width as f64, s.height as f64)
        }
        (Position::Physical(p), Size::Logical(s)) => (p.x as f64, p.y as f64, s.width, s.height),
        (Position::Logical(p), Size::Physical(s)) => (p.x, p.y, s.width as f64, s.height as f64),
        (Position::Logical(p), Size::Logical(s)) => (p.x, p.y, s.width, s.height),
    };

    if width <= 0.0 || height <= 0.0 {
        return Anchor {
            x: pointer.x,
            y: pointer.y,
            width: 0.0,
            height: 0.0,
        };
    }

    Anchor {
        x,
        y,
        width,
        height,
    }
}

/// Wire the popup's blur-to-close, once. Called on the first open, by which
/// time the window exists.
fn wire_blur_close<R: Runtime>(window: &tauri::WebviewWindow<R>) {
    if BLUR_WIRED.swap(true, Ordering::SeqCst) {
        return;
    }

    let handle = window.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::Focused(false) = event {
            if within_focus_grace() {
                return;
            }
            if handle.is_visible().unwrap_or(false) {
                hide(&handle);
            }
        }
    });
}

/// Place a popup of `logical_width` × `logical_height` against the icon.
///
/// Growing left is the default — a tray icon lives at the right edge, and the
/// menu column has to stay exactly where the pointer already is. When the icon
/// is too close to the left edge the panel flips to the right instead, and when
/// the popup does not fit above the icon it drops below, which is what a
/// taskbar at the top of the screen needs.
fn place<R: Runtime>(
    app: &AppHandle<R>,
    anchor: Anchor,
    logical_width: f64,
    logical_height: f64,
    scale: f64,
) -> (PhysicalPosition<f64>, TrayMenuLayout) {
    let width = logical_width * scale;
    let height = logical_height * scale;
    let collapsed_width = MENU_WIDTH * scale;
    let collapsed_x = anchor.x + anchor.width / 2.0 - collapsed_width / 2.0;
    let collapsed_right = collapsed_x + collapsed_width;

    let mut side = "left";
    let mut vertical = "up";
    let mut x = collapsed_right - width;
    let mut y = anchor.y - height;

    if let Ok(Some(monitor)) = app.monitor_from_point(anchor.x, anchor.y) {
        let area = monitor.work_area();
        let left = area.position.x as f64;
        let top = area.position.y as f64;
        let right = left + area.size.width as f64;
        let bottom = top + area.size.height as f64;

        if x < left {
            side = "right";
            x = collapsed_x;
        }
        if y < top {
            vertical = "down";
            y = anchor.y + anchor.height;
        }

        x = x.clamp(left, (right - width).max(left));
        y = y.clamp(top, (bottom - height).max(top));
    }

    (
        PhysicalPosition::new(x, y),
        TrayMenuLayout { side, vertical },
    )
}

fn apply_layout<R: Runtime>(
    app: &AppHandle<R>,
    window: &tauri::WebviewWindow<R>,
    anchor: Anchor,
    expanded: bool,
) -> Result<TrayMenuLayout, String> {
    let (width, height) = if expanded {
        (MENU_WIDTH + PANEL_WIDTH, PANEL_HEIGHT)
    } else {
        (MENU_WIDTH, menu_height())
    };

    window
        .set_size(LogicalSize::new(width, height))
        .map_err(|error| error.to_string())?;
    let scale = window.scale_factor().unwrap_or(1.0);
    let (position, layout) = place(app, anchor, width, height, scale);
    window
        .set_position(position)
        .map_err(|error| error.to_string())?;

    Ok(layout)
}

/// Grow or shrink the popup for the Clash flyout.
pub fn set_expanded<R: Runtime>(
    app: &AppHandle<R>,
    expanded: bool,
) -> Result<TrayMenuLayout, String> {
    let window = app
        .get_webview_window(TRAY_MENU_LABEL)
        .ok_or_else(|| "The tray menu window does not exist".to_string())?;
    let anchor = STATE
        .lock()
        .map_err(|_| "The tray menu state is poisoned".to_string())?
        .anchor
        .ok_or_else(|| "The tray menu has not been opened yet".to_string())?;

    apply_layout(app, &window, anchor, expanded)
}

/// Toggle the popup open, anchored above `rect` (or at `pointer` when the
/// icon's rect is not usable).
pub fn on_tray_right_click<R: Runtime>(
    app: &AppHandle<R>,
    rect: &Rect,
    pointer: PhysicalPosition<f64>,
) {
    let Some(window) = app.get_webview_window(TRAY_MENU_LABEL) else {
        return;
    };

    wire_blur_close(&window);

    // Visible means this click is the one meant to close it. The order matters:
    // testing the reopen guard first would swallow that second click and leave
    // the menu stuck open.
    if window.is_visible().unwrap_or(false) {
        hide(&window);
        return;
    }
    if recently_hidden() {
        return;
    }

    // Physical pixels throughout: the rect arrives in physical coordinates and
    // `outer_size` returns them, so the anchor needs no conversion at all. The
    // scale factor appears only to size our logical menu width in that space.
    let anchor = rect_bounds(rect, pointer);

    // A fresh open always starts collapsed, whatever the page last showed.
    if apply_layout(app, &window, anchor, false).is_err() {
        return;
    }

    mark_shown(anchor);
    // Told before the window is shown: the page resets the flyout while it is
    // still invisible, so a reopened menu never flashes yesterday's state.
    let _ = app.emit_to(TRAY_MENU_LABEL, OPENED_EVENT, ());
    let _ = window.show();
    let _ = window.set_focus();
}
