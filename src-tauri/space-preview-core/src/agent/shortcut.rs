// Ported from SpacePreview (MIT). See src-tauri/space-preview-core/UPSTREAM.md.
//! The space agent's shortcut.
//!
//! The upstream app let the user pick a key and modifiers; this port keeps the
//! trigger fixed to a bare Space. The packed layout is kept unchanged so the
//! keyboard hook compares values the same way: virtual-key code in the low
//! byte, one bit per modifier above bit 16.

/// Virtual-key code for Space (`VK_SPACE`), with no modifiers set.
const SPACE: u32 = 0x20;

/// The packed shortcut the hook listens for.
pub const fn current() -> u32 {
    SPACE
}

/// Whether the live modifier state matches the packed shortcut exactly.
pub fn matches(packed: u32, ctrl: bool, alt: bool, meta: bool) -> bool {
    packed >> 16 == (ctrl as u32 | (alt as u32) << 1 | (meta as u32) << 2)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_trigger_is_bare_space() {
        let packed = current();
        assert_eq!(packed & 255, 0x20);
        assert_eq!(packed >> 16, 0);
        assert!(matches(packed, false, false, false));
    }

    #[test]
    fn any_modifier_disqualifies_the_press() {
        let packed = current();
        for (ctrl, alt, meta) in [
            (true, false, false),
            (false, true, false),
            (false, false, true),
            (true, true, true),
        ] {
            assert!(!matches(packed, ctrl, alt, meta));
        }
    }
}
