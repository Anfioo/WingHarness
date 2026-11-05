//! Windows version-resource metadata used as identity evidence.
//!
//! The metadata is descriptive only. A product or company name never authorizes
//! removal; it enriches catalog rows and startup identity summaries.

use std::ffi::c_void;
use std::path::Path;
use std::slice;

use windows::Win32::Storage::FileSystem::{
    GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW,
};
use windows_core::HSTRING;

const MAX_VERSION_RESOURCE_BYTES: u32 = 16 * 1024 * 1024;
const VS_FFI_SIGNATURE: u32 = 0xFEEF_04BD;
const VS_FIXEDFILEINFO_DWORDS: usize = 13;
/// `040904B0` (en-US, Unicode) and `040904E4` (en-US, Windows 1252) are the
/// conventional tables most installers ship. Other translations are appended
/// after these two.
const PREFERRED_TRANSLATIONS: [(u16, u16); 2] = [(0x0409, 0x04B0), (0x0409, 0x04E4)];

#[derive(Debug, Clone, Default)]
pub(crate) struct FileVersionMetadata {
    pub(crate) product_name: Option<String>,
    pub(crate) file_description: Option<String>,
    pub(crate) company_name: Option<String>,
    pub(crate) file_version: Option<String>,
    pub(crate) original_filename: Option<String>,
}

/// Returns version-resource strings for one executable or DLL.
///
/// `None` means the file is missing, carries no readable version resource, or
/// the resource is malformed. Callers treat the metadata as optional evidence.
pub(crate) fn file_version_metadata(path: &Path) -> Option<FileVersionMetadata> {
    if !path.is_file() {
        return None;
    }
    let wide_path = HSTRING::from(path.as_os_str());
    // SAFETY: the path is a valid NUL-terminated wide string and the optional
    // handle argument is unused by this query.
    let size = unsafe { GetFileVersionInfoSizeW(&wide_path, None) };
    if size == 0 || size > MAX_VERSION_RESOURCE_BYTES {
        return None;
    }
    let mut buffer = vec![0_u8; size as usize];
    // SAFETY: `buffer` is writable for exactly `size` bytes.
    unsafe { GetFileVersionInfoW(&wide_path, None, size, buffer.as_mut_ptr().cast()) }.ok()?;

    let mut translations = PREFERRED_TRANSLATIONS.to_vec();
    translations.extend(version_translations(&buffer));
    translations.dedup();

    let lookup = |key: &str| {
        translations.iter().find_map(|(language, code_page)| {
            version_string(&buffer, *language, *code_page, key)
        })
    };
    let metadata = FileVersionMetadata {
        product_name: lookup("ProductName"),
        file_description: lookup("FileDescription"),
        company_name: lookup("CompanyName"),
        file_version: lookup("FileVersion").or_else(|| fixed_file_version(&buffer)),
        original_filename: lookup("OriginalFilename"),
    };

    if metadata.product_name.is_none()
        && metadata.file_description.is_none()
        && metadata.company_name.is_none()
        && metadata.file_version.is_none()
        && metadata.original_filename.is_none()
    {
        return None;
    }
    Some(metadata)
}

fn version_translations(buffer: &[u8]) -> Vec<(u16, u16)> {
    let query = HSTRING::from(r"\VarFileInfo\Translation");
    let mut pointer = std::ptr::null_mut::<c_void>();
    let mut byte_length = 0_u32;
    // SAFETY: the buffer comes from `GetFileVersionInfoW`; the returned pointer
    // is only read for the byte length reported by the same call.
    if !unsafe { VerQueryValueW(buffer.as_ptr().cast(), &query, &mut pointer, &mut byte_length) }
        .as_bool()
        || pointer.is_null()
        || byte_length < 4
    {
        return Vec::new();
    }
    let words = unsafe { slice::from_raw_parts(pointer.cast::<u16>(), byte_length as usize / 2) };
    words
        .as_chunks::<2>()
        .0
        .iter()
        .map(|pair| (pair[0], pair[1]))
        .collect()
}

fn version_string(buffer: &[u8], language: u16, code_page: u16, key: &str) -> Option<String> {
    let query = HSTRING::from(format!(
        r"\StringFileInfo\{language:04x}{code_page:04x}\{key}"
    ));
    let mut pointer = std::ptr::null_mut::<c_void>();
    let mut character_length = 0_u32;
    // SAFETY: the buffer comes from `GetFileVersionInfoW`; the returned pointer
    // is only read for the character length reported by the same call.
    if !unsafe { VerQueryValueW(buffer.as_ptr().cast(), &query, &mut pointer, &mut character_length) }
        .as_bool()
        || pointer.is_null()
        || character_length == 0
    {
        return None;
    }
    let value = unsafe {
        slice::from_raw_parts(
            pointer.cast::<u16>(),
            character_length.saturating_sub(1) as usize,
        )
    };
    let value = String::from_utf16_lossy(value).trim().to_owned();
    (!value.is_empty()).then_some(value)
}

/// Reads the binary `VS_FIXEDFILEINFO` block when the string table omits a
/// `FileVersion` value.
fn fixed_file_version(buffer: &[u8]) -> Option<String> {
    let query = HSTRING::from(r"\");
    let mut pointer = std::ptr::null_mut::<c_void>();
    let mut byte_length = 0_u32;
    // SAFETY: the buffer comes from `GetFileVersionInfoW`; the query returns a
    // pointer to `VS_FIXEDFILEINFO` sized by `byte_length`.
    if !unsafe { VerQueryValueW(buffer.as_ptr().cast(), &query, &mut pointer, &mut byte_length) }
        .as_bool()
        || pointer.is_null()
        || byte_length < (VS_FIXEDFILEINFO_DWORDS * 4) as u32
    {
        return None;
    }
    let words = unsafe { slice::from_raw_parts(pointer.cast::<u32>(), VS_FIXEDFILEINFO_DWORDS) };
    if words[0] != VS_FFI_SIGNATURE {
        return None;
    }
    let file_version_ms = words[2];
    let file_version_ls = words[3];
    Some(format!(
        "{}.{}.{}.{}",
        file_version_ms >> 16,
        file_version_ms & 0xFFFF,
        file_version_ls >> 16,
        file_version_ls & 0xFFFF
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_path_yields_no_metadata() {
        let path = std::env::temp_dir().join("systools-file-version-missing-fixture.exe");
        assert!(file_version_metadata(&path).is_none());
    }

    #[test]
    fn a_directory_is_not_a_version_resource() {
        assert!(file_version_metadata(&std::env::temp_dir()).is_none());
    }
}
