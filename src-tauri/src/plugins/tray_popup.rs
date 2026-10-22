//! The themed right-click menu on the system tray icon.
//!
//! The native tray menu cannot follow the app's theme, so right-clicks instead
//! pop a frameless, transparent window (`tray-menu`, declared in
//! `tauri.conf.json`) holding an ordinary shadcn menu. This module owns that
//! window's position and lifetime; its contents live in
//! `src/windows/tray-menu/index.tsx`.
//!
//! Windows only. On macOS a native menu *is* the platform-correct form, and
//! Linux keeps the menu it had, so `system_tray` never calls in there.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, LogicalSize, Manager, PhysicalPosition, Position, Rect, Runtime, Size};

/// Label of the popup window declared in `tauri.conf.json`.
const TRAY_MENU_LABEL: &str = "tray-menu";

// Keep in sync with src/lib/tray-menu.ts — the popup's row height is fixed in
// CSS, so the window size is arithmetic rather than a measurement.
const MENU_WIDTH: f64 = 220.0;
const MENU_ITEM_HEIGHT: f64 = 32.0;
const MENU_PAD_Y: f64 = 4.0;
const MENU_DIVIDER_HEIGHT: f64 = 9.0;
/// Show window / Settings / Quit.
const MENU_ITEM_COUNT: f64 = 3.0;

/// The tray click itself blurs whatever had focus, so the popup receives a blur
/// right after being shown. Ignore blurs that fall inside this window.
const FOCUS_GRACE: Duration = Duration::from_millis(200);
/// A right-click landing this soon after a hide is the one that *closed* the
/// popup, not a request to reopen it.
const REOPEN_GUARD: Duration = Duration::from_millis(250);

struct PopupState {
    shown_at: Option<Instant>,
    hidden_at: Option<Instant>,
}

/// Single tray icon, so a single set of timestamps — no need for managed state.
static STATE: Mutex<PopupState> = Mutex::new(PopupState {
    shown_at: None,
    hidden_at: None,
});

/// Whether the blur handler is in place. It cannot be registered where the tray
/// itself is built: plugin setup hooks run before the runtime creates the
/// windows declared in `tauri.conf.json`, so the popup does not exist yet.
static BLUR_WIRED: AtomicBool = AtomicBool::new(false);

fn menu_height() -> f64 {
    MENU_PAD_Y * 2.0 + MENU_ITEM_HEIGHT * MENU_ITEM_COUNT + MENU_DIVIDER_HEIGHT
}

fn hide<R: Runtime>(window: &tauri::WebviewWindow<R>) {
    let _ = window.hide();
    if let Ok(mut state) = STATE.lock() {
        state.hidden_at = Some(Instant::now());
    }
}

fn mark_shown() {
    if let Ok(mut state) = STATE.lock() {
        state.shown_at = Some(Instant::now());
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
fn rect_bounds(rect: &Rect, pointer: PhysicalPosition<f64>) -> (f64, f64, f64, f64) {
    let (x, y, width, height) = match (rect.position, rect.size) {
        (Position::Physical(p), Size::Physical(s)) => {
            (p.x as f64, p.y as f64, s.width as f64, s.height as f64)
        }
        (Position::Physical(p), Size::Logical(s)) => (p.x as f64, p.y as f64, s.width, s.height),
        (Position::Logical(p), Size::Physical(s)) => (p.x, p.y, s.width as f64, s.height as f64),
        (Position::Logical(p), Size::Logical(s)) => (p.x, p.y, s.width, s.height),
    };

    if width <= 0.0 || height <= 0.0 {
        return (pointer.x, pointer.y, 0.0, 0.0);
    }

    (x, y, width, height)
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
    let (icon_x, icon_y, icon_width, icon_height) = rect_bounds(rect, pointer);

    if window
        .set_size(LogicalSize::new(MENU_WIDTH, menu_height()))
        .is_err()
    {
        return;
    }
    let Ok(size) = window.outer_size() else {
        return;
    };
    let scale = window.scale_factor().unwrap_or(1.0);
    let menu_width = MENU_WIDTH * scale;

    let mut x = icon_x + icon_width / 2.0 - menu_width / 2.0;
    let mut y = icon_y - size.height as f64;

    // Converge on the monitor's work area, so the popup stays on screen whatever
    // edge the taskbar sits on. Dropping below the icon covers a taskbar at the
    // top, where "above the icon" is off-screen.
    if let Ok(Some(monitor)) = app.monitor_from_point(icon_x, icon_y) {
        let area = monitor.work_area();
        let left = area.position.x as f64;
        let top = area.position.y as f64;
        let right = left + area.size.width as f64;
        let bottom = top + area.size.height as f64;

        if y < top {
            y = icon_y + icon_height;
        }
        x = x.clamp(left, (right - menu_width).max(left));
        y = y.clamp(top, (bottom - size.height as f64).max(top));
    }

    mark_shown();
    let _ = window.set_position(PhysicalPosition::new(x, y));
    let _ = window.show();
    let _ = window.set_focus();
}
