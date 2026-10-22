/// `@font-face` rules for the fonts the theme in use asks for, downloading any
/// the machine does not already have. See [`crate::theme::fonts`].
#[tauri::command]
pub async fn theme_fonts_css(families: Vec<String>) -> Result<String, String> {
    crate::theme::fonts::font_css(families).await
}
