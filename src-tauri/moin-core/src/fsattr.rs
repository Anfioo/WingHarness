// Adapted from moin (MIT), https://github.com/exxvius/moin at 79e7587.
// See `UPSTREAM.md` for the porting record.

//! Hidden attribute for `.part` files.
//!
//! `hide_part_files` asks for partial downloads to stay out of the way in the
//! platform file browser. Windows has a real attribute for that; everywhere
//! else the leading dot of `file.bin.part` already keeps the file out of most
//! listings, so the call does nothing.

/// Toggles the hidden attribute on `path`.
///
/// Best effort on purpose: a transfer must never fail because a file attribute
/// could not be read or changed.
pub fn set_hidden(path: &str, hidden: bool) {
    #[cfg(windows)]
    {
        windows::set_hidden(path, hidden);
    }
    #[cfg(not(windows))]
    {
        let _ = (path, hidden);
    }
}

#[cfg(windows)]
mod windows {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;

    const FILE_ATTRIBUTE_HIDDEN: u32 = 0x0000_0002;
    const INVALID_FILE_ATTRIBUTES: u32 = u32::MAX;

    #[link(name = "kernel32")]
    extern "system" {
        fn GetFileAttributesW(name: *const u16) -> u32;
        fn SetFileAttributesW(name: *const u16, attributes: u32) -> i32;
    }

    pub(super) fn set_hidden(path: &str, hidden: bool) {
        let wide: Vec<u16> = OsStr::new(path)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        // SAFETY: `wide` is a NUL-terminated UTF-16 buffer that outlives the call.
        let current = unsafe { GetFileAttributesW(wide.as_ptr()) };
        if current == INVALID_FILE_ATTRIBUTES {
            // The file is not there yet, or the path is unreadable. Both are
            // fine: the caller only wants the attribute set on what it wrote.
            return;
        }
        let wanted = if hidden {
            current | FILE_ATTRIBUTE_HIDDEN
        } else {
            current & !FILE_ATTRIBUTE_HIDDEN
        };
        if wanted == current {
            return;
        }
        // SAFETY: same buffer as above; the call only reads it.
        unsafe {
            SetFileAttributesW(wide.as_ptr(), wanted);
        }
    }
}
