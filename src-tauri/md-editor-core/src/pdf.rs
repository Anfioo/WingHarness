//! Native PDF export through WebView2's `PrintToPdf`.
//!
//! The frontend first puts the window into a print state (see
//! `src/features/md-editor/export/pdf.ts`), then calls the command, which lands
//! here. Only the Windows build can print without a dialog; everywhere else the
//! command reports `unsupported` and the frontend falls back to `window.print()`.

#[cfg(target_os = "windows")]
mod windows_impl {
    use std::sync::mpsc;
    use std::time::Duration;

    use tauri::webview::PlatformWebview;
    use tauri::WebviewWindow;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2_2, ICoreWebView2_7, ICoreWebView2Controller2, ICoreWebView2Environment6,
        ICoreWebView2PrintSettings, COREWEBVIEW2_COLOR,
    };
    use webview2_com::PrintToPdfCompletedHandler;
    use windows::core::{Interface, PCWSTR};

    use crate::error::{MdEditorError, MdEditorResult};
    use crate::models::MdPdfOptions;

    /// A WebView2 print that never reports back must not pin a blocking task
    /// forever; a 20-page document finishes in seconds, so three minutes only
    /// trips on a genuinely stuck runtime.
    const PRINT_TIMEOUT: Duration = Duration::from_secs(180);

    /// `PrintToPdf` paints the page-margin area with the controller's default
    /// background colour. Opaque white keeps that area blank instead of tinted.
    const WHITE: COREWEBVIEW2_COLOR = COREWEBVIEW2_COLOR {
        A: 255,
        R: 255,
        G: 255,
        B: 255,
    };

    /// Restore value used when the controller does not hand its colour back.
    /// It matches `backgroundColor` in `tauri.conf.json`, so a failed read still
    /// leaves the window looking the way it started.
    const FALLBACK_BACKGROUND: COREWEBVIEW2_COLOR = COREWEBVIEW2_COLOR {
        A: 255,
        R: 245,
        G: 245,
        B: 245,
    };

    pub fn print_to_pdf(window: &WebviewWindow, options: &MdPdfOptions) -> MdEditorResult<()> {
        let (sender, receiver) = mpsc::channel();
        let options = options.clone();

        window
            .with_webview(move |platform| {
                // The completion handler reports through a clone so this sender
                // can still carry an error raised before the handler exists.
                let reporter = sender.clone();
                if let Err(error) = unsafe { start_print(platform, &options, reporter) } {
                    let _ = sender.send(Err(error));
                }
            })
            .map_err(|error| {
                MdEditorError::internal(format!("Could not reach the webview: {error}"))
            })?;

        match receiver.recv_timeout(PRINT_TIMEOUT) {
            Ok(result) => result,
            Err(mpsc::RecvTimeoutError::Timeout) => Err(MdEditorError::internal(
                "PDF export timed out: WebView2 did not finish printing within 180 seconds.",
            )),
            Err(mpsc::RecvTimeoutError::Disconnected) => Err(MdEditorError::internal(
                "PDF export ended before WebView2 reported a result.",
            )),
        }
    }

    /// # Safety
    ///
    /// Must run on the webview's UI thread, which `with_webview` guarantees.
    unsafe fn start_print(
        platform: PlatformWebview,
        options: &MdPdfOptions,
        sender: mpsc::Sender<MdEditorResult<()>>,
    ) -> MdEditorResult<()> {
        let controller = platform.controller();
        let core = controller
            .CoreWebView2()
            .map_err(|error| com_error("Could not obtain the WebView2 core", error))?;

        // `PrintToPdf` arrived with interface 7. An older Evergreen Runtime does
        // not expose it, and no amount of retrying will help, so report the
        // distinct `unsupported` code and let the UI fall back to `window.print()`.
        let core7 = core.cast::<ICoreWebView2_7>().map_err(|_| {
            MdEditorError::unsupported(
                "This WebView2 runtime is too old for native PDF export; update the WebView2 Runtime.",
            )
        })?;

        let settings = create_print_settings(&core, options)?;

        // DefaultBackgroundColor is what PrintToPdf paints the physical page
        // margin area with, so leaving the app's tinted background in place
        // draws a grey ring around every page. Switch to white for the print
        // and restore the original value once WebView2 reports back.
        //
        // The cast has to start from the *controller*: casting ICoreWebView2 to
        // ICoreWebView2Controller2 always fails with E_NOINTERFACE because the
        // two interfaces sit in different inheritance chains. A controller that
        // does not expose interface 2 only means we skip the fix — a grey ring
        // is preferable to blocking the export.
        let controller2 = controller.cast::<ICoreWebView2Controller2>().ok();
        let mut original = FALLBACK_BACKGROUND;
        if let Some(controller2) = &controller2 {
            let mut current = COREWEBVIEW2_COLOR::default();
            if controller2.DefaultBackgroundColor(&mut current).is_ok() {
                original = current;
            }
            let _ = controller2.SetDefaultBackgroundColor(WHITE);
        }

        let restore = controller2.clone();
        let completed = PrintToPdfCompletedHandler::create(Box::new(move |result, printed| {
            if let Some(controller2) = &restore {
                let _ = controller2.SetDefaultBackgroundColor(original);
            }
            let _ = sender.send(match result {
                // WebView2 can return S_OK for a print that produced nothing.
                Ok(()) if printed => Ok(()),
                Ok(()) => Err(MdEditorError::internal(
                    "WebView2 finished printing without producing a PDF.",
                )),
                Err(error) => Err(com_error("WebView2 could not write the PDF", error)),
            });
            Ok(())
        }));

        let path = wide_path(&options.path);
        if let Err(error) = core7.PrintToPdf(PCWSTR(path.as_ptr()), &settings, &completed) {
            if let Some(controller2) = &controller2 {
                let _ = controller2.SetDefaultBackgroundColor(original);
            }
            return Err(com_error("WebView2 refused to start printing", error));
        }

        Ok(())
    }

    /// Print settings come from the environment (interface 6), not the core.
    /// Sizes are inches; the frontend converts millimetres before calling.
    unsafe fn create_print_settings(
        core: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2,
        options: &MdPdfOptions,
    ) -> MdEditorResult<ICoreWebView2PrintSettings> {
        let settings = (|| -> windows::core::Result<ICoreWebView2PrintSettings> {
            let environment = core.cast::<ICoreWebView2_2>()?.Environment()?;
            let factory = environment.cast::<ICoreWebView2Environment6>()?;
            let settings = factory.CreatePrintSettings()?;
            settings.SetPageWidth(options.page_width)?;
            settings.SetPageHeight(options.page_height)?;
            settings.SetMarginTop(options.margins.top)?;
            settings.SetMarginBottom(options.margins.bottom)?;
            settings.SetMarginLeft(options.margins.left)?;
            settings.SetMarginRight(options.margins.right)?;
            // Backgrounds carry the code-block and table fills; the header and
            // footer would add a URL and page numbers the export does not want.
            settings.SetShouldPrintBackgrounds(true)?;
            settings.SetShouldPrintHeaderAndFooter(false)?;
            Ok(settings)
        })();

        settings.map_err(|error| com_error("Could not configure the PDF page", error))
    }

    fn wide_path(path: &str) -> Vec<u16> {
        path.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn com_error(context: &str, error: windows::core::Error) -> MdEditorError {
        MdEditorError::internal(format!("{context}: {error}"))
    }
}

#[cfg(target_os = "windows")]
pub use windows_impl::print_to_pdf;

/// No dialog-free print API exists off Windows, so the caller falls back to the
/// system print dialog on the frontend.
#[cfg(not(target_os = "windows"))]
pub fn print_to_pdf(
    _window: &tauri::WebviewWindow,
    _options: &crate::models::MdPdfOptions,
) -> crate::error::MdEditorResult<()> {
    Err(crate::error::MdEditorError::unsupported(
        "Native PDF export is only available on Windows.",
    ))
}

#[cfg(test)]
mod tests {
    use crate::models::MdPdfOptions;

    /// The payload the frontend actually sends: camelCase field names, margins
    /// nested under `margins`, and every size already in inches.
    #[test]
    fn decodes_the_frontend_payload() {
        let payload = serde_json::json!({
            "path": "C:\\out\\doc.pdf",
            "pageWidth": 8.27,
            "pageHeight": 11.69,
            "margins": { "top": 0.79, "right": 0.79, "bottom": 0.79, "left": 0.79 }
        });

        let options: MdPdfOptions = serde_json::from_value(payload).expect("payload must decode");

        assert_eq!(options.path, "C:\\out\\doc.pdf");
        assert_eq!(options.page_width, 8.27);
        assert_eq!(options.page_height, 11.69);
        assert_eq!(options.margins.top, 0.79);
        assert_eq!(options.margins.right, 0.79);
        assert_eq!(options.margins.bottom, 0.79);
        assert_eq!(options.margins.left, 0.79);
    }

    /// `margins` defaults to zero so a caller that only wants the default page
    /// geometry does not have to spell it out.
    #[test]
    fn margins_are_optional() {
        let payload = serde_json::json!({
            "path": "doc.pdf",
            "pageWidth": 8.5,
            "pageHeight": 11.0
        });

        let options: MdPdfOptions = serde_json::from_value(payload).expect("payload must decode");

        assert_eq!(options.margins.top, 0.0);
        assert_eq!(options.margins.left, 0.0);
    }
}
