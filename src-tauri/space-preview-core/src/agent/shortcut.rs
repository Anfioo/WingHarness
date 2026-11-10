// Ported from SpacePreview (MIT). See src-tauri/space-preview-core/UPSTREAM.md.
//! The space agent's shortcut.
//!
//! The packed layout is virtual-key code in the low byte and one bit per
//! modifier above bit 16, so the keyboard hook can compare a live key press
//! with a single integer. The trigger itself is a preference, and the hook
//! reads `current()` on every event, so changing it takes effect without
//! reinstalling the hook.

use std::sync::atomic::{AtomicU32, Ordering};

/// Virtual-key code for Space (`VK_SPACE`).
const SPACE: u32 = 0x20;
/// The Meta bit, packed above bit 16; bit 0 is Ctrl and bit 1 is Alt.
const META: u32 = 4 << 16;

const SPACE_KEY: u32 = SPACE;
const WIN_SPACE: u32 = SPACE | META;

static CURRENT: AtomicU32 = AtomicU32::new(SPACE_KEY);

/// The packed shortcut the hook listens for.
pub fn current() -> u32 {
    CURRENT.load(Ordering::Relaxed)
}

/// Install the trigger named by the preference. Unknown names keep bare Space.
pub fn set(name: &str) {
    let packed = packed_for(name);
    CURRENT.store(packed, Ordering::Relaxed);
}

fn packed_for(name: &str) -> u32 {
    match name {
        "winSpace" => WIN_SPACE,
        _ => SPACE_KEY,
    }
}

/// Whether the live modifier state matches the packed shortcut exactly.
pub fn matches(packed: u32, ctrl: bool, alt: bool, meta: bool) -> bool {
    packed >> 16 == (ctrl as u32 | (alt as u32) << 1 | (meta as u32) << 2)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_default_trigger_is_bare_space() {
        CURRENT.store(SPACE_KEY, Ordering::Relaxed);
        let packed = current();
        assert_eq!(packed, 0x20);
        assert_eq!(packed >> 16, 0);
        assert!(matches(packed, false, false, false));
    }

    #[test]
    fn every_preset_is_a_space_press_with_its_modifiers() {
        assert_eq!(packed_for("space"), 0x20);
        assert_eq!(packed_for("winSpace"), 0x20 | (4 << 16));
        assert_eq!(packed_for("altSpace"), 0x20, "the retired preset falls back");
        assert_eq!(packed_for("unknown"), 0x20);
    }

    #[test]
    fn the_packed_modifiers_must_match_exactly() {
        let win_space = packed_for("winSpace");
        assert!(matches(win_space, false, false, true));
        assert!(!matches(win_space, false, false, false));
        assert!(!matches(win_space, true, false, true));
    }

    #[test]
    fn set_installs_the_named_preset() {
        set("winSpace");
        assert_eq!(current(), packed_for("winSpace"));
        set("not-a-preset");
        assert_eq!(current(), SPACE_KEY);
    }
}
