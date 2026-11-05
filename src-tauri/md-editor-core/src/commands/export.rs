//! Export commands. HTML and PNG are written by the frontend through
//! `save_text_file` / `md_editor_save_binary`; only PDF needs the native side.

// The print helper lives at `src/pdf.rs`. It is attached to this module instead
// of being declared in `lib.rs`, which the module coordinator owns.
#[path = "../pdf.rs"]
mod pdf;

use crate::error::{MdEditorError, MdEditorResult};
use crate::models::MdPdfOptions;

/// Print the current window to `options.path` through WebView2's `PrintToPdf`.
///
/// `window` is injected by Tauri, not sent by the frontend. Printing has to run
/// on the webview's UI thread and then blocks until WebView2 reports back, so it
/// goes onto a blocking task: occupying an async worker for the whole print
/// would stall the other commands.
#[tauri::command]
pub async fn md_editor_export_pdf(
    window: tauri::WebviewWindow,
    options: MdPdfOptions,
) -> MdEditorResult<()> {
    if options.path.trim().is_empty() {
        return Err(MdEditorError::invalid_input(
            "path",
            "The PDF export path must not be empty.",
        ));
    }

    tauri::async_runtime::spawn_blocking(move || pdf::print_to_pdf(&window, &options))
        .await
        .map_err(|error| MdEditorError::internal(format!("PDF export task failed: {error}")))?
}
