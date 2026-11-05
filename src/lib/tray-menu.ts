/**
 * Geometry of the tray menu popup window.
 *
 * The window is sized and positioned by Rust (`src-tauri/src/plugins/tray_popup.rs`),
 * which keeps its own copy of these numbers and cannot import this file. What
 * makes that safe is that the popup's rows are pinned to fixed heights in CSS —
 * `h-8` per item, `p-1` around them, `my-1 h-px` for the divider — so the
 * height is arithmetic rather than something measured at runtime. Change the
 * classes in `src/windows/tray-menu/index.tsx` and the numbers here and there
 * have to move together.
 */

export const TRAY_MENU_WIDTH = 220;
export const TRAY_MENU_ITEM_HEIGHT = 32;
export const TRAY_MENU_PAD_Y = 4;
export const TRAY_MENU_DIVIDER_HEIGHT = 9;

/** Show window / Settings / Clash / Quit. */
const TRAY_MENU_ITEM_COUNT = 4;

/** The Clash flyout that the window grows into on hover. */
export const TRAY_MENU_PANEL_WIDTH = 340;
export const TRAY_MENU_PANEL_HEIGHT = 460;

/** Height of the popup for the menu it currently holds. */
export function trayMenuHeight() {
  return (
    TRAY_MENU_PAD_Y * 2 + TRAY_MENU_ITEM_HEIGHT * TRAY_MENU_ITEM_COUNT + TRAY_MENU_DIVIDER_HEIGHT
  );
}
