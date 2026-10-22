//! Extension and MIME classification for the files the preview serves.
//!
//! Ported from the reference viewer's own `formats.rs`, trimmed to what the
//! preview needs: the extension (with the compound `tar.*` cases handled), a
//! guessed MIME, and whether the extension has a viewer at all.

use std::path::Path;

/// The lowercased extension, or the compound archive form for `tar.*`.
pub fn extension(path: &Path) -> Option<String> {
    let name = path.file_name()?.to_str()?.to_ascii_lowercase();
    for compound in ["tar.gz", "tar.bz2", "tar.xz"] {
        if name.ends_with(&format!(".{compound}")) {
            return Some(compound.to_string());
        }
    }
    path.extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
}

/// A best-effort MIME type, used only to label the preview.
pub fn guess_mime(path: &Path) -> String {
    match extension(path).as_deref() {
        Some("pdf") => "application/pdf",
        Some("docx") | Some("dotx") => {
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        }
        Some("odt") => "application/vnd.oasis.opendocument.text",
        Some("rtf") => "application/rtf",
        Some("xlsx") | Some("xlsm") => {
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        }
        Some("xls") => "application/vnd.ms-excel",
        Some("ods") => "application/vnd.oasis.opendocument.spreadsheet",
        Some("pptx") | Some("pptm") => {
            "application/vnd.openxmlformats-officedocument.presentationml.presentation"
        }
        Some("md") | Some("markdown") => "text/markdown",
        Some("csv") => "text/csv",
        Some("tsv") => "text/tab-separated-values",
        Some("json") => "application/json",
        Some("yaml") | Some("yml") => "application/yaml",
        Some("xml") => "application/xml",
        Some("svg") => "image/svg+xml",
        Some("html") | Some("htm") | Some("xhtml") => "text/html",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("bmp") => "image/bmp",
        Some("ico") => "image/x-icon",
        Some("tif") | Some("tiff") => "image/tiff",
        Some("icns") => "image/icns",
        Some("zip") | Some("jar") | Some("vsix") | Some("apk") => "application/zip",
        Some("7z") => "application/x-7z-compressed",
        Some("rar") => "application/vnd.rar",
        Some("tar") => "application/x-tar",
        Some("tgz") | Some("tar.gz") => "application/gzip",
        Some("epub") => "application/epub+zip",
        Some("xmind") => "application/x-xmind",
        Some("psd") => "image/vnd.adobe.photoshop",
        Some("ttf") => "font/ttf",
        Some("otf") => "font/otf",
        Some("woff") => "font/woff",
        Some("woff2") => "font/woff2",
        Some("mp3") => "audio/mpeg",
        Some("wav") => "audio/wav",
        Some("ogg") | Some("oga") | Some("opus") => "audio/ogg",
        Some("flac") => "audio/flac",
        Some("m4a") => "audio/mp4",
        Some("aac") => "audio/aac",
        Some("mp4") | Some("m4v") => "video/mp4",
        Some("webm") => "video/webm",
        Some("ogv") => "video/ogg",
        Some("mov") => "video/quicktime",
        Some("txt") | Some("log") => "text/plain",
        _ => "application/octet-stream",
    }
    .to_string()
}

/// Every extension the frontend registry can render.
///
/// Kept in step with `src/lib/preview/viewers/registry.ts`; a file outside it
/// still opens (the viewers fall back to text or an "unsupported" pane) but the
/// page can say so up front.
const PREVIEWABLE: &[&str] = &[
    // word
    "docx", "docm", "dotx", "dotm", "odt", "ott", "fodt", "rtf", // spreadsheet
    "xls", "xlsx", "xlsm", "xltx", "xltm", "csv", "tsv", "ods", "ots", "fods",
    // presentation
    "pptx", "pptm", "ppsx", "ppsm", "potx", "potm", "odp", "otp", "fodp", // pdf
    "pdf", // audio
    "mp3", "wav", "ogg", "oga", "opus", "flac", "m4a", "aac", // video
    "mp4", "m4v", "webm", "ogv", "mov", // email
    "eml", // archive
    "zip", "crx", "jar", "vsix", "apk", "tar", "tgz", "tar.gz", "7z", "rar",
    // book
    "epub", "fb2", "cbz", // visual
    "xmind", "psd", "cur", "tif", "tiff", "icns", // image
    "png", "jpg", "jpeg", "pjp", "pjpeg", "gif", "webp", "bmp", "ico", "avif", "apng",
    // vector / font
    "svg", "svgz", "ttf", "otf", "woff", "woff2", // basic
    "md", "markdown", "html", "htm", "xhtml", "json", "yaml", "yml", "xml", "toml", "txt", "log",
    "js", "ts", "tsx", "jsx", "css", "rs", "py", "go", "java", "c", "cpp", "h", "hpp", "cs", "sql",
    "sh", "ps1",
];

/// Whether a path has a viewer in the frontend registry.
pub fn is_previewable(path: &Path) -> bool {
    match extension(path) {
        Some(value) => PREVIEWABLE.contains(&value.as_str()),
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn distinguishes_xml_and_svg_mime_types() {
        assert_eq!(guess_mime(Path::new("data.xml")), "application/xml");
        assert_eq!(guess_mime(Path::new("icon.svg")), "image/svg+xml");
    }

    #[test]
    fn keeps_compound_tar_extensions_intact() {
        assert_eq!(extension(Path::new("a/b.tar.gz")).as_deref(), Some("tar.gz"));
        assert_eq!(extension(Path::new("a/b.TGZ")).as_deref(), Some("tgz"));
        assert_eq!(extension(Path::new("a/b.ZIP")).as_deref(), Some("zip"));
        assert_eq!(extension(Path::new("noext")), None);
    }

    #[test]
    fn knows_which_extensions_have_a_viewer() {
        assert!(is_previewable(Path::new("a.pdf")));
        assert!(is_previewable(Path::new("a.docx")));
        assert!(!is_previewable(Path::new("a.xyz")));
        assert!(!is_previewable(Path::new("noext")));
    }
}