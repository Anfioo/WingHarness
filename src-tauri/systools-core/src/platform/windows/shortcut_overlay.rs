//! Generic shortcut overlay icons for entries without a native icon.

/// Returns a small generic shortcut overlay PNG.
///
/// The reference application shipped a pre-rendered image asset. This port has
/// no embedded binary asset and adding an encoder or image crate would violate
/// the "no new dependencies" constraint for a purely cosmetic fallback, so the
/// function returns `None`. The frontend already renders its own placeholder
/// badge for catalog rows without an icon, and shortcut rows fall back to the
/// generic file icon assignment.
pub(crate) fn overlay_icon_png() -> Option<&'static [u8]> {
    None
}

#[cfg(test)]
mod tests {
    use super::overlay_icon_png;

    #[test]
    fn overlay_is_optional_and_never_panics() {
        assert_eq!(overlay_icon_png(), None);
    }
}
