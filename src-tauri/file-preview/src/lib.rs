//! The file preview backend: the raw bytes of the git-svn working copy.
//!
//! The viewers themselves are entirely frontend — pdf.js, exceljs, mammoth and
//! the rest parse in the webview. This crate does the one thing they cannot:
//! hand back a file's bytes, confined to the working copy the app is
//! configured to serve.
//!
//! The root is not known here. The app resolves it from its own config and
//! installs a provider at startup (see [`provide_root`]); the crate calls it on
//! every request, so a config change takes effect on the next read rather than
//! needing the backend restarted.

mod commands;
mod confine;
mod meta;
mod mime;

use std::path::PathBuf;
use std::sync::OnceLock;

pub use commands::{preview_bytes, preview_metadata};
pub use meta::PreviewMeta;

/// The largest file the preview will read into memory.
///
/// The whole file lands in a `Uint8Array` and usually a blob beside it, so this
/// is a guard against a stray multi-gigabyte file, not a policy: 64 MiB is
/// generous for a PDF, image or short video and cheap to hold twice.
pub const PREVIEW_MAX_BYTES: u64 = 64 * 1024 * 1024;

/// Resolves the working copy root, or says why it cannot.
type RootProvider = fn() -> Result<PathBuf, String>;

static ROOT_PROVIDER: OnceLock<RootProvider> = OnceLock::new();

/// Installs how this crate finds the working copy root.
///
/// Called once from the app's setup, and only once — a second call is ignored.
/// The provider is expected to resolve the path fresh on each call, so the
/// crate never caches a root the user may have since changed.
pub fn provide_root(provider: RootProvider) {
    let _ = ROOT_PROVIDER.set(provider);
}

pub(crate) fn root() -> Result<PathBuf, String> {
    ROOT_PROVIDER
        .get()
        .ok_or_else(|| "文件预览后端未初始化。".to_string())?()
}