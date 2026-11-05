use crate::error::SystoolsResult;
use crate::models::{ScanNameExclusion, SystoolsPrefs};

// Startup items.

#[tauri::command]
pub async fn systools_startup_scan(
    app: tauri::AppHandle,
) -> SystoolsResult<crate::startup::models::StartupCatalog> {
    crate::startup::commands::scan(&app).await
}

#[tauri::command]
pub fn systools_startup_cancel_scan() -> SystoolsResult<()> {
    crate::startup::commands::cancel_scan()
}

#[tauri::command]
pub async fn systools_startup_prepare_change(
    selection: crate::startup::models::StartupChangeSelection,
) -> SystoolsResult<crate::startup::models::StartupChangePlan> {
    crate::startup::commands::prepare_change(selection).await
}

#[tauri::command]
pub async fn systools_startup_execute_change(
    plan_id: String,
    authorization_prompt: String,
) -> SystoolsResult<crate::startup::models::StartupChangeResult> {
    crate::startup::commands::execute_change(plan_id, authorization_prompt).await
}

#[tauri::command]
pub fn systools_startup_cancel_change() -> SystoolsResult<()> {
    crate::startup::commands::cancel_change()
}

// Application uninstall.

#[tauri::command]
pub async fn systools_uninstall_scan(
    app: tauri::AppHandle,
) -> SystoolsResult<crate::applications::models::ApplicationUninstallScanResult> {
    crate::applications::commands::scan(&app).await
}

#[tauri::command]
pub fn systools_uninstall_cancel_scan() -> SystoolsResult<()> {
    crate::applications::commands::cancel_scan()
}

#[tauri::command]
pub async fn systools_uninstall_describe_identity(
    application_id: String,
    catalog_revision: String,
) -> SystoolsResult<crate::applications::models::ApplicationUninstallIdentity> {
    crate::applications::commands::describe_identity(application_id, catalog_revision).await
}

#[tauri::command]
pub async fn systools_uninstall_close_applications(
    request: crate::applications::models::ApplicationUninstallCloseRequest,
    catalog_revision: String,
) -> SystoolsResult<crate::applications::models::ApplicationUninstallCloseResponse> {
    crate::applications::commands::close_applications(request, catalog_revision).await
}

#[tauri::command]
pub async fn systools_uninstall_prepare_batch(
    selections: Vec<crate::applications::models::ApplicationUninstallBatchSelection>,
    catalog_revision: String,
) -> SystoolsResult<crate::applications::models::ApplicationUninstallBatchPreparation> {
    crate::applications::commands::prepare_batch(selections, catalog_revision).await
}

#[tauri::command]
pub async fn systools_uninstall_execute_batch(
    app: tauri::AppHandle,
    plan: crate::applications::models::ApplicationUninstallBatchPlan,
    dry_run: bool,
    authorization_prompt: String,
) -> SystoolsResult<crate::applications::models::ApplicationUninstallBatchResult> {
    crate::applications::commands::execute_batch(&app, plan, dry_run, authorization_prompt).await
}

#[tauri::command]
pub fn systools_uninstall_cancel_execution() -> SystoolsResult<()> {
    crate::applications::commands::cancel_execution()
}

#[tauri::command]
pub async fn systools_uninstall_remove_record(application_id: String) -> SystoolsResult<()> {
    crate::applications::commands::remove_record(application_id).await
}

#[tauri::command]
pub async fn systools_uninstall_open_windows_apps() -> SystoolsResult<()> {
    crate::applications::commands::open_windows_apps().await
}

#[tauri::command]
pub async fn systools_leftovers_scan(
    app: tauri::AppHandle,
) -> SystoolsResult<crate::applications::models::ApplicationLeftoverScanResult> {
    crate::applications::commands::scan_leftovers(&app).await
}

#[tauri::command]
pub async fn systools_leftovers_execute(
    reviewed_items: Vec<crate::applications::models::ApplicationLeftoverPlanItem>,
    dry_run: bool,
    operation_id: String,
) -> SystoolsResult<crate::applications::models::ApplicationLeftoverResult> {
    crate::applications::commands::execute_leftovers(reviewed_items, dry_run, operation_id).await
}

#[tauri::command]
pub fn systools_leftovers_cancel() -> SystoolsResult<()> {
    crate::applications::commands::cancel_leftovers()
}

#[tauri::command]
pub async fn systools_application_icons(
    app: tauri::AppHandle,
    paths: Vec<String>,
) -> SystoolsResult<Vec<crate::applications::models::ApplicationIcon>> {
    crate::applications::commands::load_icons(&app, paths).await
}

// System settings.

#[tauri::command]
pub async fn systools_system_settings_scan(
) -> SystoolsResult<crate::system_settings::models::SystemSettingsCatalog> {
    crate::system_settings::commands::scan().await
}

#[tauri::command]
pub fn systools_system_settings_cancel_scan() -> SystoolsResult<()> {
    crate::system_settings::commands::cancel_scan()
}

#[tauri::command]
pub async fn systools_system_settings_prepare_change(
    selection: crate::system_settings::models::SystemSettingsChangeSelection,
) -> SystoolsResult<crate::system_settings::models::SystemSettingsChangePlan> {
    crate::system_settings::commands::prepare_change(selection).await
}

#[tauri::command]
pub async fn systools_system_settings_execute_change(
    plan_id: String,
) -> SystoolsResult<crate::system_settings::models::SystemSettingsChangeResult> {
    crate::system_settings::commands::execute_change(plan_id).await
}

// Disk analysis.

#[tauri::command]
pub async fn systools_analysis_scan(
    app: tauri::AppHandle,
    path: Option<String>,
    refresh: bool,
    excluded_paths: Vec<String>,
    excluded_names: Option<Vec<ScanNameExclusion>>,
    scan_mode: Option<crate::storage::analysis::models::AnalysisScanMode>,
) -> SystoolsResult<crate::storage::analysis::models::AnalysisResult> {
    crate::storage::analysis::commands::scan(
        &app,
        path,
        refresh,
        excluded_paths,
        excluded_names,
        scan_mode,
    )
    .await
}

#[tauri::command]
pub fn systools_analysis_cancel() -> SystoolsResult<()> {
    crate::storage::analysis::commands::cancel()
}

#[tauri::command]
pub async fn systools_analysis_remainder_list(
    request: crate::storage::analysis::models::AnalysisRemainderRequest,
) -> SystoolsResult<crate::storage::analysis::models::AnalysisRemainderPage> {
    crate::storage::analysis::commands::remainder_list(request).await
}

#[tauri::command]
pub async fn systools_analysis_remainder_release(snapshot_id: u64) -> SystoolsResult<()> {
    crate::storage::analysis::commands::remainder_release(snapshot_id).await
}

#[tauri::command]
pub async fn systools_analysis_export(
    window: tauri::Window,
    request: crate::reporting::AnalysisExportRequest,
    dialog_title: String,
) -> SystoolsResult<Option<crate::reporting::AnalysisExportReceipt>> {
    crate::storage::analysis::commands::export(window, request, dialog_title).await
}

#[tauri::command]
pub async fn systools_analysis_delete_entries(
    scan_id: u64,
    selected_paths: Vec<String>,
) -> SystoolsResult<crate::storage::analysis::models::AnalysisDeleteBatchResult> {
    crate::storage::analysis::commands::delete_entries(scan_id, selected_paths).await
}

// Large files.

#[tauri::command]
pub async fn systools_large_files_scan(
    app: tauri::AppHandle,
    roots: Vec<String>,
    minimum_bytes: u64,
    scan_mode: crate::storage::large_files::models::LargeFileScanMode,
    excluded_paths: Vec<String>,
    excluded_names: Option<Vec<ScanNameExclusion>>,
) -> SystoolsResult<crate::storage::large_files::models::LargeFilesResult> {
    crate::storage::large_files::commands::scan(
        &app,
        roots,
        minimum_bytes,
        scan_mode,
        excluded_paths,
        excluded_names,
    )
    .await
}

#[tauri::command]
pub async fn systools_large_files_filter(
    scan_id: u64,
    minimum_bytes: u64,
) -> SystoolsResult<crate::storage::large_files::models::LargeFilesResult> {
    crate::storage::large_files::commands::filter(scan_id, minimum_bytes).await
}

#[tauri::command]
pub fn systools_large_files_cancel() -> SystoolsResult<()> {
    crate::storage::large_files::commands::cancel()
}

#[tauri::command]
pub async fn systools_large_files_delete(
    scan_id: u64,
    selected_paths: Vec<String>,
) -> SystoolsResult<crate::storage::PermanentDeleteBatchResult> {
    crate::storage::large_files::commands::delete(scan_id, selected_paths).await
}

// Duplicate files.

#[tauri::command]
pub async fn systools_duplicates_scan(
    app: tauri::AppHandle,
    locations: Vec<crate::storage::duplicates::models::DuplicateScanLocation>,
    minimum_bytes: u64,
    excluded_paths: Vec<String>,
    excluded_names: Option<Vec<ScanNameExclusion>>,
) -> SystoolsResult<crate::storage::duplicates::models::DuplicateFilesResult> {
    crate::storage::duplicates::commands::scan(
        &app,
        locations,
        minimum_bytes,
        excluded_paths,
        excluded_names,
    )
    .await
}

#[tauri::command]
pub fn systools_duplicates_cancel() -> SystoolsResult<()> {
    crate::storage::duplicates::commands::cancel()
}

#[tauri::command]
pub async fn systools_duplicates_page(
    scan_id: u64,
    offset: u64,
    limit: u64,
) -> SystoolsResult<crate::storage::duplicates::models::DuplicateGroupPage> {
    crate::storage::duplicates::commands::page(scan_id, offset, limit).await
}

#[tauri::command]
pub async fn systools_duplicates_delete(
    scan_id: u64,
    candidates: Vec<crate::storage::PermanentDeleteCandidate>,
) -> SystoolsResult<crate::storage::PermanentDeleteBatchResult> {
    crate::storage::duplicates::commands::delete(scan_id, candidates).await
}

// Filesystem and shell helpers.

#[tauri::command]
pub async fn systools_volumes_list(
    refresh: Option<bool>,
) -> SystoolsResult<Vec<crate::filesystem::commands::VolumeInfo>> {
    crate::filesystem::commands::volumes_list(refresh).await
}

#[tauri::command]
pub async fn systools_system_disk() -> SystoolsResult<crate::filesystem::commands::VolumeInfo> {
    crate::filesystem::commands::system_disk().await
}

#[tauri::command]
pub async fn systools_filter_directory_paths(
    paths: Vec<String>,
) -> SystoolsResult<crate::filesystem::commands::DirectorySelectionOutcome> {
    crate::filesystem::commands::filter_directory_paths(paths).await
}

#[tauri::command]
pub async fn systools_reveal_in_file_manager(path: String) -> SystoolsResult<()> {
    crate::filesystem::commands::reveal_in_file_manager(path).await
}

#[tauri::command]
pub async fn systools_open_analysis_entry(
    scan_id: u64,
    selected_path: String,
) -> SystoolsResult<()> {
    crate::filesystem::commands::open_analysis_entry(scan_id, selected_path).await
}

#[tauri::command]
pub async fn systools_open_large_file_entry(
    scan_id: u64,
    selected_path: String,
) -> SystoolsResult<()> {
    crate::filesystem::commands::open_large_file_entry(scan_id, selected_path).await
}

#[tauri::command]
pub async fn systools_open_duplicate_entry(
    scan_id: u64,
    selected_path: String,
) -> SystoolsResult<()> {
    crate::filesystem::commands::open_duplicate_entry(scan_id, selected_path).await
}

#[tauri::command]
pub async fn systools_file_icons(
    app: tauri::AppHandle,
    requests: Vec<crate::filesystem::commands::FileIconRequest>,
) -> SystoolsResult<crate::filesystem::commands::FileIconBatch> {
    crate::filesystem::commands::file_icons(&app, requests).await
}

// Persisted preferences.

#[tauri::command]
pub fn systools_prefs_get() -> SystoolsResult<SystoolsPrefs> {
    crate::prefs::get()
}

#[tauri::command]
pub fn systools_prefs_set(prefs: SystoolsPrefs) -> SystoolsResult<()> {
    crate::prefs::set(prefs)
}
