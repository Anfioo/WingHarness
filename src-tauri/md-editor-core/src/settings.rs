//! `settings.json`: clamped editor preferences.
//!
//! The frontend sends the whole object back, so a bad field only ever affects
//! that field. Out-of-range numbers are clamped rather than rejected: the UI
//! gets to keep the user's intent as closely as the allowed range permits.

use crate::error::MdEditorResult;
use crate::models::MdEditorSettings;
use crate::paths;
use crate::store::{load_json, save_json};

/// PDF page sizes the export renders; anything else falls back to A4.
const PDF_PAGES: [&str; 2] = ["a4", "letter"];
const DEFAULT_PDF_PAGE: &str = "a4";

/// Read the settings, clamped to the ranges the UI documents.
pub fn get() -> MdEditorResult<MdEditorSettings> {
    let path = paths::settings_path()?;
    Ok(clamp(load_json::<MdEditorSettings>(&path)))
}

/// Clamp and persist the whole settings object, returning what was stored.
pub fn set(settings: MdEditorSettings) -> MdEditorResult<MdEditorSettings> {
    let path = paths::settings_path()?;
    let settings = clamp(settings);
    save_json(&path, &settings)?;
    Ok(settings)
}

fn clamp(mut settings: MdEditorSettings) -> MdEditorSettings {
    settings.version = 1;

    settings.appearance.font_size = clamp_f64(settings.appearance.font_size, 10.0, 24.0, 14.0);
    settings.appearance.line_height =
        clamp_f64(settings.appearance.line_height, 1.2, 2.4, 1.7);
    settings.appearance.content_width = settings.appearance.content_width.clamp(480, 1600);

    settings.behavior.tab_size = settings.behavior.tab_size.clamp(1, 8);
    settings.behavior.auto_save_interval_sec =
        settings.behavior.auto_save_interval_sec.clamp(5, 600);

    settings.view.split_ratio = clamp_f64(settings.view.split_ratio, 0.2, 0.8, 0.5);
    settings.view.outline_width = settings.view.outline_width.clamp(160, 400);

    settings.export.image_scale = clamp_scale(settings.export.image_scale);
    settings.export.pdf_margin_mm = clamp_f64(settings.export.pdf_margin_mm, 0.0, 50.0, 15.0);
    settings.export.pdf_page = clamp_pdf_page(&settings.export.pdf_page);

    settings
}

fn clamp_f64(value: f64, min: f64, max: f64, fallback: f64) -> f64 {
    if value.is_nan() {
        fallback
    } else {
        value.clamp(min, max)
    }
}

/// The image scale moves in 0.25 steps so the canvas math stays predictable.
fn clamp_scale(value: f64) -> f64 {
    if value.is_nan() {
        return 2.0;
    }
    (value.clamp(1.0, 3.0) * 4.0).round() / 4.0
}

fn clamp_pdf_page(page: &str) -> String {
    let normalized = page.trim().to_ascii_lowercase();
    if PDF_PAGES.contains(&normalized.as_str()) {
        normalized
    } else {
        DEFAULT_PDF_PAGE.to_owned()
    }
}
