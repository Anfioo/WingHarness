//! System file icons.
//!
//! Ported from SpacePreview (MIT). See `UPSTREAM.md`, `windows_icons.rs`.
//!
//! The shell is asked for the icon of a path — or of a name plus a folder flag
//! when there is no path, so a not-yet-existing file still gets its type icon.
//! Nothing here opens the selected shortcut or application: only the icon is
//! rendered, on two backgrounds, so its alpha channel can be reconstructed and
//! the result crosses the IPC bridge as a PNG.
//!
//! A failure is not an error the caller has to handle: the preview falls back to
//! its built-in icon when it receives an empty array.

use std::path::Path;

use crate::error::SpacePreviewResult;

/// Read `path`'s icon, or the generic icon for `name`; an empty array means the
/// shell could not provide one.
pub fn read(path: Option<&Path>, name: &str, folder: bool) -> SpacePreviewResult<Vec<u8>> {
    #[cfg(windows)]
    {
        Ok(windows::read(path, name, folder).unwrap_or_default())
    }
    #[cfg(not(windows))]
    {
        let _ = (path, name, folder);
        Ok(Vec::new())
    }
}

#[cfg(windows)]
mod windows {
    use std::{mem::size_of, path::Path, sync::Mutex};

    use windows::{
        core::PCWSTR,
        Win32::{
            Graphics::Gdi::*,
            Storage::FileSystem::{FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_NORMAL},
            System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED},
            UI::{
                Shell::*,
                WindowsAndMessaging::{DestroyIcon, DrawIconEx, DI_NORMAL, HICON},
            },
        },
    };

    use crate::error::SpacePreviewError;

    const SIDE: usize = 64;

    /// Serialize Shell requests and their icon lifetimes, including installed
    /// icon handlers.
    static ICON_LOCK: Mutex<()> = Mutex::new(());

    struct ShellIcon(HICON);

    impl Drop for ShellIcon {
        fn drop(&mut self) {
            unsafe {
                let _ = DestroyIcon(self.0);
            }
        }
    }

    pub(super) fn read(
        path: Option<&Path>,
        name: &str,
        folder: bool,
    ) -> Result<Vec<u8>, SpacePreviewError> {
        let _guard = ICON_LOCK
            .lock()
            .map_err(|_| SpacePreviewError::internal("The icon queue is poisoned."))?;
        unsafe {
            let initialized = CoInitializeEx(None, COINIT_APARTMENTTHREADED).is_ok();
            let result = read_inner(path, name, folder);
            if initialized {
                CoUninitialize();
            }
            result
        }
    }

    unsafe fn read_inner(
        path: Option<&Path>,
        name: &str,
        folder: bool,
    ) -> Result<Vec<u8>, SpacePreviewError> {
        let query = if let Some(path) = path {
            let path = path.to_string_lossy();
            if let Some(unc) = path.strip_prefix(r"\\?\UNC\") {
                format!(r"\\{unc}")
            } else {
                path.strip_prefix(r"\\?\").unwrap_or(&path).to_string()
            }
        } else {
            let extension = Path::new(name)
                .extension()
                .and_then(|ext| ext.to_str())
                .unwrap_or("");
            format!("preview.{}", extension.chars().take(32).collect::<String>())
        };
        let wide: Vec<u16> = query.encode_utf16().chain(Some(0)).collect();
        let mut info = SHFILEINFOW::default();
        let mut flags = SHGFI_ICON | SHGFI_LARGEICON | SHGFI_ADDOVERLAYS;
        if path.is_none() {
            flags |= SHGFI_USEFILEATTRIBUTES;
        }
        let attributes = if folder {
            FILE_ATTRIBUTE_DIRECTORY
        } else {
            FILE_ATTRIBUTE_NORMAL
        };
        if SHGetFileInfoW(
            PCWSTR(wide.as_ptr()),
            attributes,
            Some(&mut info),
            size_of::<SHFILEINFOW>() as u32,
            flags,
        ) == 0
        {
            // A path that no longer resolves still gets its type icon.
            if path.is_some() {
                return read_inner(None, name, folder);
            }
            return Err(SpacePreviewError::internal(
                "The system icon is unavailable.",
            ));
        }
        let icon = ShellIcon(info.hIcon);
        let black = render(icon.0, 0)?;
        let white = render(icon.0, 255)?;
        let rgba = transparent_pixels(&black, &white);
        let mut png = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut png, SIDE as u32, SIDE as u32);
            encoder.set_color(png::ColorType::Rgba);
            encoder.set_depth(png::BitDepth::Eight);
            let mut writer = encoder.write_header().map_err(|error| {
                SpacePreviewError::internal(format!("The icon could not be encoded: {error}"))
            })?;
            writer.write_image_data(&rgba).map_err(|error| {
                SpacePreviewError::internal(format!("The icon could not be encoded: {error}"))
            })?;
        }
        Ok(png)
    }

    unsafe fn render(icon: HICON, background: u8) -> Result<Vec<u8>, SpacePreviewError> {
        let dc = CreateCompatibleDC(None);
        if dc.0.is_null() {
            return Err(SpacePreviewError::internal(
                "The system icon could not be drawn.",
            ));
        }
        let info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: SIDE as i32,
                biHeight: -(SIDE as i32),
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut bits = std::ptr::null_mut();
        let bitmap = match CreateDIBSection(Some(dc), &info, DIB_RGB_COLORS, &mut bits, None, 0) {
            Ok(bitmap) => bitmap,
            Err(error) => {
                let _ = DeleteDC(dc);
                return Err(SpacePreviewError::internal(format!(
                    "The icon could not be drawn: {error}"
                )));
            }
        };
        let old = SelectObject(dc, HGDIOBJ(bitmap.0));
        let pixels = std::slice::from_raw_parts_mut(bits.cast::<u8>(), SIDE * SIDE * 4);
        pixels.fill(background);
        let result = DrawIconEx(dc, 0, 0, icon, SIDE as i32, SIDE as i32, 0, None, DI_NORMAL)
            .map_err(|error| {
                SpacePreviewError::internal(format!("The icon could not be drawn: {error}"))
            })
            .map(|_| {
                let _ = GdiFlush();
                pixels.to_vec()
            });
        let _ = SelectObject(dc, old);
        let _ = DeleteObject(HGDIOBJ(bitmap.0));
        let _ = DeleteDC(dc);
        result
    }

    fn transparent_pixels(black: &[u8], white: &[u8]) -> Vec<u8> {
        black
            .chunks_exact(4)
            .zip(white.chunks_exact(4))
            .flat_map(|(dark, light)| {
                // Two opaque backgrounds also preserve masks of old icons with
                // no alpha channel.
                let alpha = 255
                    - (0..3)
                        .map(|i| light[i].saturating_sub(dark[i]))
                        .max()
                        .unwrap();
                let color = |i| {
                    if alpha == 0 {
                        0
                    } else {
                        (dark[i] as u32 * 255 / alpha as u32).min(255) as u8
                    }
                };
                [color(2), color(1), color(0), alpha]
            })
            .collect()
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn decode(bytes: Vec<u8>) -> (u32, u32, Vec<u8>) {
            let mut decoder = png::Decoder::new(std::io::Cursor::new(bytes))
                .read_info()
                .unwrap();
            let mut pixels = vec![0; decoder.output_buffer_size()];
            let frame = decoder.next_frame(&mut pixels).unwrap();
            (frame.width, frame.height, pixels)
        }

        #[test]
        fn generic_icons_are_pngs() {
            for (name, folder) in [("note.txt", false), ("folder", true)] {
                let bytes =
                    read(None, name, folder).unwrap_or_else(|error| panic!("{name}: {error}"));
                assert!(bytes.starts_with(b"\x89PNG\r\n\x1a\n"), "{name}");
                let (width, height, pixels) = decode(bytes);
                assert_eq!((width, height), (SIDE as u32, SIDE as u32));
                assert!(pixels.chunks_exact(4).any(|pixel| pixel[3] != 0), "{name}");
            }
        }

        #[test]
        fn colors_and_transparency_survive_bgra_conversion() {
            assert_eq!(
                transparent_pixels(&[0, 0, 0, 0], &[255, 255, 255, 0]),
                [0, 0, 0, 0]
            );
            assert_eq!(
                transparent_pixels(&[10, 20, 30, 0], &[10, 20, 30, 0]),
                [30, 20, 10, 255]
            );
            assert_eq!(
                transparent_pixels(&[0, 0, 128, 0], &[127, 127, 255, 0]),
                [255, 0, 0, 128]
            );
        }
    }
}

#[cfg(all(test, not(windows)))]
mod tests {
    use super::*;

    #[test]
    fn icons_are_empty_off_windows() {
        assert!(read(None, "note.txt", false).unwrap().is_empty());
        assert!(read(Some(Path::new("/tmp/note.txt")), "note.txt", false)
            .unwrap()
            .is_empty());
    }
}
