//! HTML relative resources.
//!
//! A previewed HTML document may reference images, stylesheets and fonts that
//! sit next to it. The reference is resolved against the document's directory
//! and both sides are canonicalized, so a `..` chain, an absolute path or a
//! symlink cannot walk out of that directory.

use std::fs;
use std::path::{Component, Path};

use crate::error::{SpacePreviewError, SpacePreviewResult};
use crate::state::PreviewState;

/// The largest single resource a document may embed.
pub const MAX_RESOURCE: u64 = 32 * 1024 * 1024;

/// The resource types the HTML viewer can inline. The frontend engine requests
/// exactly these; anything else is refused rather than handed to the webview.
const EXTENSIONS: &[&str] = &[
    "css", "png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "woff", "woff2", "ttf", "otf",
];

/// Read the resource `path` references from `base`, the HTML document.
///
/// `base` must already be admitted through `sp_inspect_file`; `path` is the
/// reference as written in the document and only has to resolve below the
/// document's own directory.
pub fn read_html_resource(
    path: &Path,
    base: &Path,
    state: &PreviewState,
) -> SpacePreviewResult<Vec<u8>> {
    let document = state.check(base)?;
    let root = document.parent().ok_or_else(|| {
        SpacePreviewError::invalid_input("The HTML document has no parent directory.")
    })?;

    // `join` would replace `root` with an absolute or prefixed reference, so
    // refuse those before touching the filesystem.
    if path.is_absolute()
        || path.has_root()
        || path
            .components()
            .any(|component| matches!(component, Component::Prefix(_)))
    {
        return Err(SpacePreviewError::not_authorized(
            "A resource must be relative to the HTML document's directory.",
        ));
    }

    let candidate = root.join(path);
    let resource =
        fs::canonicalize(&candidate).map_err(|error| crate::io::file_error(&candidate, error))?;
    if !resource.starts_with(root) {
        return Err(SpacePreviewError::not_authorized(
            "A resource must stay inside the HTML document's directory.",
        ));
    }

    let metadata =
        fs::metadata(&resource).map_err(|error| crate::io::file_error(&resource, error))?;
    if !metadata.is_file() {
        return Err(SpacePreviewError::invalid_input(
            "Only regular files can be read as resources.",
        ));
    }
    if metadata.len() > MAX_RESOURCE {
        return Err(SpacePreviewError::too_large(format!(
            "A resource is limited to {MAX_RESOURCE} bytes."
        )));
    }

    let extension = resource
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !EXTENSIONS.contains(&extension.as_str()) {
        return Err(SpacePreviewError::unsupported(
            "This resource type cannot be embedded.",
        ));
    }

    fs::read(&resource).map_err(|error| crate::io::file_error(&resource, error))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    static SEQUENCE: AtomicU64 = AtomicU64::new(0);

    struct Fixture {
        directory: PathBuf,
        document: PathBuf,
        state: PreviewState,
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.directory);
        }
    }

    fn fixture(label: &str) -> Fixture {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_nanos())
            .unwrap_or_default();
        let sequence = SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let directory = std::env::temp_dir().join(format!(
            "space-preview-b3-html-{label}-{}-{stamp}-{sequence}",
            std::process::id()
        ));
        fs::create_dir_all(&directory).unwrap();
        let document = directory.join("page.html");
        fs::write(&document, b"<html></html>").unwrap();
        let state = PreviewState::default();
        state.allow(&document).unwrap();
        Fixture {
            directory,
            document,
            state,
        }
    }

    #[test]
    fn reads_a_sibling_resource() {
        let fixture = fixture("sibling");
        fs::write(fixture.directory.join("image.png"), b"png").unwrap();

        let bytes =
            read_html_resource(Path::new("image.png"), &fixture.document, &fixture.state).unwrap();

        assert_eq!(bytes, b"png");
    }

    #[test]
    fn reads_a_nested_resource() {
        let fixture = fixture("nested");
        fs::create_dir_all(fixture.directory.join("styles")).unwrap();
        fs::write(fixture.directory.join("styles/main.css"), b"body{}").unwrap();

        let bytes = read_html_resource(
            Path::new("styles/main.css"),
            &fixture.document,
            &fixture.state,
        )
        .unwrap();

        assert_eq!(bytes, b"body{}");
    }

    #[test]
    fn rejects_a_parent_escape() {
        let fixture = fixture("escape");
        let outside = fixture.directory.parent().unwrap().join("outside.png");
        fs::write(&outside, b"png").unwrap();

        let error = read_html_resource(
            Path::new("../outside.png"),
            &fixture.document,
            &fixture.state,
        )
        .unwrap_err();

        let _ = fs::remove_file(&outside);
        assert_eq!(error.code, "not-authorized");
    }

    #[test]
    fn rejects_a_resource_on_another_path() {
        let fixture = fixture("absolute");
        let outside = if cfg!(windows) {
            PathBuf::from(r"D:\preview-escape.png")
        } else {
            PathBuf::from("/preview-escape.png")
        };

        let error = read_html_resource(&outside, &fixture.document, &fixture.state).unwrap_err();

        assert_eq!(error.code, "not-authorized");
    }

    #[test]
    fn rejects_a_directory() {
        let fixture = fixture("directory");
        fs::create_dir_all(fixture.directory.join("assets")).unwrap();

        let error =
            read_html_resource(Path::new("assets"), &fixture.document, &fixture.state).unwrap_err();

        assert_eq!(error.code, "invalid-input");
    }

    #[test]
    fn rejects_an_unsupported_type() {
        let fixture = fixture("type");
        fs::write(fixture.directory.join("script.js"), b"alert(1)").unwrap();

        let error = read_html_resource(Path::new("script.js"), &fixture.document, &fixture.state)
            .unwrap_err();

        assert_eq!(error.code, "unsupported");
    }

    #[test]
    fn requires_the_document_to_be_inspected() {
        let fixture = fixture("unauthorized");

        let error = read_html_resource(
            Path::new("image.png"),
            &fixture.document,
            &PreviewState::default(),
        )
        .unwrap_err();

        assert_eq!(error.code, "not-authorized");
    }

    #[test]
    fn reports_a_missing_resource() {
        let fixture = fixture("missing");

        let error = read_html_resource(Path::new("absent.png"), &fixture.document, &fixture.state)
            .unwrap_err();

        assert_eq!(error.code, "not-found");
    }
}
