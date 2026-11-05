//! Elevated startup helper entry point.
//!
//! The desktop process prepares a nonce-bound request file, asks
//! `platform::elevation` to launch this process over the shoulder, and both
//! sides meet on two files inside the caller's temporary directory. The helper
//! re-reads and re-verifies every requested item; it never accepts a command or
//! a registry path directly.

use std::{
    collections::BTreeSet,
    ffi::OsString,
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};

use crate::{
    platform::contracts::{
        PlatformError, PlatformErrorCode, PlatformMutationState, PlatformResult,
    },
    startup::platform::{
        PlatformStartupArtifact, PlatformStartupChangeRequest, PlatformStartupChangeResult,
        PlatformStartupConfiguredState, PlatformStartupDesiredState,
    },
};

pub(crate) const HELPER_FLAG: &str = "--systools-startup-helper-v1";
const PROTOCOL: &str = "systools-startup-helper-v1";
const MAX_MESSAGE_BYTES: u64 = 1024 * 1024;
const MAX_BATCH_ITEMS: usize = 128;
const HELPER_SUCCESS_EXIT_CODE: i32 = 0;
const HELPER_FAILURE_EXIT_CODE: i32 = 70;
static NEXT_REQUEST_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HelperRequest {
    protocol: String,
    nonce: String,
    items: Vec<HelperRequestItem>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HelperRequestItem {
    source_id: String,
    provider_item_id: String,
    expected_artifact_digest: String,
    desired_state: WireState,
}

#[derive(Debug, Clone)]
pub(crate) struct StartupHelperChangeRequest {
    pub(crate) source_id: String,
    pub(crate) provider_item_id: String,
    pub(crate) expected_artifact_digest: String,
    pub(crate) desired_state: PlatformStartupDesiredState,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HelperResponse {
    protocol: String,
    nonce: String,
    items: Vec<HelperResponseItem>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HelperResponseItem {
    outcome: Option<WireOutcome>,
    error_code: Option<WireErrorCode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    diagnostic: Option<String>,
    #[serde(default)]
    mutation_possible: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
enum WireState {
    Enabled,
    Disabled,
    Removed,
    Unknown,
    NotApplicable,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WireOutcome {
    previous_state: WireState,
    configured_state: WireState,
    verified: bool,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
enum WireErrorCode {
    AccessDenied,
    UserCancelled,
    ItemChanged,
    InvalidData,
    InvalidPath,
    Io,
    OperationFailed,
    Unsupported,
}

/// Runs the narrow startup helper mode before the desktop runtime is initialized.
///
/// Returning `None` means the process was launched normally. Helper mode accepts
/// exactly two absolute message paths and never starts Tauri or a WebView.
pub(crate) fn run(arguments: &[OsString]) -> Option<i32> {
    let flag = arguments.get(1).and_then(|value| value.to_str());
    if flag != Some(HELPER_FLAG) {
        return flag
            .is_some_and(|value| value.starts_with("--systools-startup-helper-"))
            .then_some(HELPER_FAILURE_EXIT_CODE);
    }
    let exit_code = match helper_paths(arguments).and_then(|(request, response)| {
        execute_helper_request(&request, &response)
            .and_then(|value| write_helper_response(&response, &value))
    }) {
        Ok(()) => HELPER_SUCCESS_EXIT_CODE,
        Err(error) => {
            log::warn!(
                "systools_startup_helper_failed reason={:?} diagnostic={}",
                error.code(),
                bounded_diagnostic(&error, 512)
            );
            HELPER_FAILURE_EXIT_CODE
        }
    };
    Some(exit_code)
}

pub(crate) fn change_with_privileges(
    request: &PlatformStartupChangeRequest,
    authorization_prompt: Option<&str>,
) -> PlatformResult<PlatformStartupChangeResult> {
    let mut results = change_many_with_privileges(&[request], authorization_prompt)?;
    results.pop().ok_or_else(|| {
        PlatformError::new(
            PlatformErrorCode::InvalidData,
            "startup helper returned no change result",
        )
    })?
}

/// Applies all privileged requests in one elevated process.
///
/// Each item is still independently allowlisted, re-read, mutated, and verified
/// by the helper. Sharing only the process boundary prevents repeated
/// authorization prompts without granting the desktop process reusable
/// administrator authority.
pub(crate) fn change_many_with_privileges(
    requests: &[&PlatformStartupChangeRequest],
    authorization_prompt: Option<&str>,
) -> PlatformResult<Vec<PlatformResult<PlatformStartupChangeResult>>> {
    if requests.is_empty() || requests.len() > MAX_BATCH_ITEMS {
        return Err(PlatformError::new(
            PlatformErrorCode::InvalidData,
            "startup helper batch size is invalid",
        ));
    }
    let source_count = requests
        .iter()
        .map(|request| request.source_id.as_str())
        .collect::<BTreeSet<_>>()
        .len();
    log::info!(
        "systools_startup_helper_change_started item_count={} source_count={}",
        requests.len(),
        source_count
    );
    let nonce = unique_nonce();
    let paths = message_paths(&nonce)?;
    let request_message = HelperRequest {
        protocol: PROTOCOL.to_owned(),
        nonce: nonce.clone(),
        items: requests
            .iter()
            .map(|request| HelperRequestItem {
                source_id: request.source_id.clone(),
                provider_item_id: request.provider_item_id.clone(),
                expected_artifact_digest: artifact_digest(&request.expected_artifact),
                desired_state: request.desired_state.into(),
            })
            .collect(),
    };
    if let Err(error) = write_private_message(&paths.request, &request_message) {
        let _ = fs::remove_file(&paths.request);
        return Err(error);
    }
    let launch_result = launch_elevated(&paths.request, &paths.response, authorization_prompt);
    let response_result = launch_result.and_then(|()| read_message(&paths.response));
    let _ = fs::remove_file(&paths.request);
    let _ = fs::remove_file(&paths.response);
    let response: HelperResponse = match response_result {
        Ok(response) => response,
        Err(error) => {
            log::warn!(
                "systools_startup_helper_change_failed item_count={} source_count={} reason={:?} mutation_state={:?}",
                requests.len(),
                source_count,
                error.code(),
                error.mutation_state()
            );
            return Err(error);
        }
    };
    if response.protocol != PROTOCOL || response.nonce != nonce {
        return Err(PlatformError::new(
            PlatformErrorCode::InvalidData,
            "startup helper response correlation failed",
        ));
    }
    if response.items.len() != requests.len() {
        return Err(PlatformError::new(
            PlatformErrorCode::InvalidData,
            "startup helper response item count is invalid",
        ));
    }
    let failed_count = response
        .items
        .iter()
        .filter(|item| item.error_code.is_some() || item.outcome.is_none())
        .count();
    log::info!(
        "systools_startup_helper_change_finished item_count={} source_count={} succeeded_count={} failed_count={}",
        requests.len(),
        source_count,
        requests.len().saturating_sub(failed_count),
        failed_count
    );
    Ok(response
        .items
        .into_iter()
        .enumerate()
        .map(|(index, item)| {
            if let Some(error_code) = item.error_code {
                let diagnostic = item
                    .diagnostic
                    .as_deref()
                    .unwrap_or("startup helper rejected the requested change");
                log::warn!(
                    "systools_startup_helper_item_failed provider_item_id={} desired_state={:?} diagnostic={}",
                    requests[index].provider_item_id,
                    requests[index].desired_state,
                    bounded_text(diagnostic, 512)
                );
                let error = PlatformError::new(error_code.into(), diagnostic);
                return Err(if item.mutation_possible {
                    error.with_possible_side_effects()
                } else {
                    error
                });
            }
            let outcome = item.outcome.ok_or_else(|| {
                PlatformError::new(
                    PlatformErrorCode::InvalidData,
                    "startup helper returned no change outcome",
                )
            })?;
            Ok(PlatformStartupChangeResult {
                previous_state: outcome.previous_state.into(),
                configured_state: outcome.configured_state.into(),
                verified: outcome.verified,
            })
        })
        .collect())
}

struct MessagePaths {
    request: PathBuf,
    response: PathBuf,
}

fn message_paths(nonce: &str) -> PlatformResult<MessagePaths> {
    let directory = helper_temporary_directory();
    if !directory.is_absolute() {
        return Err(PlatformError::invalid_path(
            "startup helper temporary directory is not absolute",
        ));
    }
    Ok(MessagePaths {
        request: directory.join(format!("systools-startup-{nonce}.request.json")),
        response: directory.join(format!("systools-startup-{nonce}.response.json")),
    })
}

fn helper_paths(arguments: &[OsString]) -> PlatformResult<(PathBuf, PathBuf)> {
    if arguments.len() != 4 {
        return Err(PlatformError::new(
            PlatformErrorCode::InvalidData,
            "startup helper argument count is invalid",
        ));
    }
    let request = PathBuf::from(&arguments[2]);
    let response = PathBuf::from(&arguments[3]);
    if !request.is_absolute() || !response.is_absolute() || request == response {
        return Err(PlatformError::invalid_path(
            "startup helper message paths are invalid",
        ));
    }
    let temporary_directory = helper_temporary_directory();
    if request.parent() != Some(temporary_directory.as_path())
        || response.parent() != Some(temporary_directory.as_path())
    {
        return Err(PlatformError::invalid_path(
            "startup helper messages are outside the temporary directory",
        ));
    }
    Ok((request, response))
}

fn helper_temporary_directory() -> PathBuf {
    std::env::temp_dir()
}

fn execute_helper_request(
    request_path: &Path,
    response_path: &Path,
) -> PlatformResult<HelperResponse> {
    validate_request_file(request_path)?;
    let request: HelperRequest = read_message(request_path)?;
    if request.protocol != PROTOCOL || !valid_nonce(&request.nonce) {
        return Err(PlatformError::new(
            PlatformErrorCode::InvalidData,
            "startup helper request protocol is invalid",
        ));
    }
    let expected_paths = message_paths(&request.nonce)?;
    if request_path != expected_paths.request || response_path != expected_paths.response {
        return Err(PlatformError::invalid_path(
            "startup helper message names do not match the request nonce",
        ));
    }
    let has_invalid_state = request.items.iter().any(|item| {
        !matches!(
            item.desired_state,
            WireState::Enabled | WireState::Disabled | WireState::Removed
        )
    });
    if request.items.is_empty() || request.items.len() > MAX_BATCH_ITEMS || has_invalid_state {
        return Err(PlatformError::new(
            PlatformErrorCode::InvalidData,
            "startup helper batch payload is invalid",
        ));
    }
    let dispatch_items = helper_dispatch_items(&request.items);
    let outcomes = platform_helper_change_many(&dispatch_items);
    if outcomes.len() != dispatch_items.len() {
        return Err(PlatformError::new(
            PlatformErrorCode::InvalidData,
            "startup helper platform batch result count is invalid",
        ));
    }
    let items = outcomes
        .into_iter()
        .map(|outcome| match outcome {
            Ok(outcome) => HelperResponseItem {
                outcome: Some(WireOutcome {
                    previous_state: outcome.previous_state.into(),
                    configured_state: outcome.configured_state.into(),
                    verified: outcome.verified,
                }),
                error_code: None,
                diagnostic: None,
                mutation_possible: false,
            },
            Err(error) => HelperResponseItem {
                outcome: None,
                error_code: Some(error.code().into()),
                diagnostic: Some(bounded_diagnostic(&error, 1024)),
                mutation_possible: error.mutation_state() == PlatformMutationState::MayHaveChanged,
            },
        })
        .collect();
    Ok(HelperResponse {
        protocol: PROTOCOL.to_owned(),
        nonce: request.nonce,
        items,
    })
}

fn helper_dispatch_items(items: &[HelperRequestItem]) -> Vec<StartupHelperChangeRequest> {
    items
        .iter()
        .map(|item| StartupHelperChangeRequest {
            source_id: item.source_id.clone(),
            provider_item_id: item.provider_item_id.clone(),
            expected_artifact_digest: item.expected_artifact_digest.clone(),
            desired_state: item.desired_state.into(),
        })
        .collect()
}

#[cfg(windows)]
fn platform_helper_change_many(
    requests: &[StartupHelperChangeRequest],
) -> Vec<PlatformResult<PlatformStartupChangeResult>> {
    crate::platform::windows::startup::helper_change_many(requests)
}

#[cfg(not(windows))]
fn platform_helper_change_many(
    requests: &[StartupHelperChangeRequest],
) -> Vec<PlatformResult<PlatformStartupChangeResult>> {
    requests
        .iter()
        .map(|_| {
            Err(PlatformError::new(
                PlatformErrorCode::Unsupported,
                "startup helper is unavailable on this platform",
            ))
        })
        .collect()
}

/// Authorizes a configured-state mutation.
///
/// The digest deliberately excludes volatile runtime observations and display
/// metadata. A scheduled task may start or stop while the user reads the
/// confirmation or accepts UAC; that does not change the target being toggled.
/// Provider identity, target, triggers, scope, capability, configured state,
/// backing path, modification token, and safety diagnostics remain covered so
/// meaningful drift fails closed.
pub(crate) fn artifact_digest(artifact: &PlatformStartupArtifact) -> String {
    let mutation_snapshot = (
        &artifact.provider_item_id,
        artifact.source_kind,
        artifact.scope,
        &artifact.triggers,
        &artifact.configuration_path,
        &artifact.target,
        artifact.configured_state,
        artifact.control_capability,
        artifact.modified_at_ms,
        &artifact.diagnostics,
    );
    blake3::hash(format!("{mutation_snapshot:?}").as_bytes())
        .to_hex()
        .to_string()
}

fn validate_request_file(path: &Path) -> PlatformResult<()> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| PlatformError::io("inspect startup helper request", &error))?;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.len() > MAX_MESSAGE_BYTES
    {
        return Err(PlatformError::new(
            PlatformErrorCode::InvalidData,
            "startup helper request file is invalid",
        ));
    }
    Ok(())
}

fn read_message<T: for<'de> Deserialize<'de>>(path: &Path) -> PlatformResult<T> {
    let mut file = fs::File::open(path)
        .map_err(|error| PlatformError::io("open startup helper message", &error))?;
    let metadata = file
        .metadata()
        .map_err(|error| PlatformError::io("inspect startup helper message", &error))?;
    if metadata.len() > MAX_MESSAGE_BYTES {
        return Err(PlatformError::new(
            PlatformErrorCode::InvalidData,
            "startup helper message exceeds its size limit",
        ));
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.read_to_end(&mut bytes)
        .map_err(|error| PlatformError::io("read startup helper message", &error))?;
    serde_json::from_slice(&bytes).map_err(|_| {
        PlatformError::new(
            PlatformErrorCode::InvalidData,
            "startup helper message is invalid",
        )
    })
}

fn write_private_message<T: Serialize>(path: &Path, message: &T) -> PlatformResult<()> {
    write_new_file(path, message, "create startup helper request")
}

fn write_helper_response<T: Serialize>(path: &Path, message: &T) -> PlatformResult<()> {
    write_new_file(path, message, "create startup helper response")
}

fn write_new_file<T: Serialize>(
    path: &Path,
    message: &T,
    operation: &'static str,
) -> PlatformResult<()> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    let mut file = options
        .open(path)
        .map_err(|error| PlatformError::io(operation, &error))?;
    serde_json::to_writer(&mut file, message).map_err(|_| {
        PlatformError::new(
            PlatformErrorCode::InvalidData,
            "serialize startup helper message failed",
        )
    })?;
    file.flush()
        .and_then(|()| file.sync_all())
        .map_err(|error| PlatformError::io("persist startup helper message", &error))
}

fn unique_nonce() -> String {
    let sequence = NEXT_REQUEST_ID.fetch_add(1, Ordering::Relaxed);
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let digest = blake3::hash(format!("{}-{timestamp}-{sequence}", std::process::id()).as_bytes());
    digest.to_hex()[..32].to_string()
}

fn valid_nonce(value: &str) -> bool {
    value.len() == 32 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn bounded_text(value: &str, limit: usize) -> String {
    let mut text: String = value.chars().filter(|character| !character.is_control()).collect();
    if text.chars().count() > limit {
        text = text.chars().take(limit.saturating_sub(12)).collect();
        text.push_str(" [truncated]");
    }
    text
}

fn bounded_diagnostic(error: &PlatformError, limit: usize) -> String {
    bounded_text(error.diagnostic(), limit)
}

impl From<PlatformStartupDesiredState> for WireState {
    fn from(value: PlatformStartupDesiredState) -> Self {
        match value {
            PlatformStartupDesiredState::Enabled => Self::Enabled,
            PlatformStartupDesiredState::Disabled => Self::Disabled,
            PlatformStartupDesiredState::Removed => Self::Removed,
        }
    }
}

impl From<WireState> for PlatformStartupDesiredState {
    fn from(value: WireState) -> Self {
        match value {
            WireState::Enabled => Self::Enabled,
            WireState::Disabled => Self::Disabled,
            WireState::Removed => Self::Removed,
            WireState::Unknown | WireState::NotApplicable => Self::Disabled,
        }
    }
}

impl From<PlatformStartupConfiguredState> for WireState {
    fn from(value: PlatformStartupConfiguredState) -> Self {
        match value {
            PlatformStartupConfiguredState::Enabled => Self::Enabled,
            PlatformStartupConfiguredState::Disabled => Self::Disabled,
            PlatformStartupConfiguredState::Unknown => Self::Unknown,
            PlatformStartupConfiguredState::NotApplicable => Self::NotApplicable,
        }
    }
}

impl From<WireState> for PlatformStartupConfiguredState {
    fn from(value: WireState) -> Self {
        match value {
            WireState::Enabled => Self::Enabled,
            WireState::Disabled => Self::Disabled,
            WireState::Removed => Self::NotApplicable,
            WireState::Unknown => Self::Unknown,
            WireState::NotApplicable => Self::NotApplicable,
        }
    }
}

impl From<PlatformErrorCode> for WireErrorCode {
    fn from(value: PlatformErrorCode) -> Self {
        match value {
            PlatformErrorCode::AccessDenied => Self::AccessDenied,
            PlatformErrorCode::UserCancelled => Self::UserCancelled,
            PlatformErrorCode::ItemChanged => Self::ItemChanged,
            PlatformErrorCode::InvalidData => Self::InvalidData,
            PlatformErrorCode::InvalidPath => Self::InvalidPath,
            PlatformErrorCode::Io => Self::Io,
            PlatformErrorCode::OperationFailed => Self::OperationFailed,
            PlatformErrorCode::Unsupported => Self::Unsupported,
        }
    }
}

impl From<WireErrorCode> for PlatformErrorCode {
    fn from(value: WireErrorCode) -> Self {
        match value {
            WireErrorCode::AccessDenied => Self::AccessDenied,
            WireErrorCode::UserCancelled => Self::UserCancelled,
            WireErrorCode::ItemChanged => Self::ItemChanged,
            WireErrorCode::InvalidData => Self::InvalidData,
            WireErrorCode::InvalidPath => Self::InvalidPath,
            WireErrorCode::Io => Self::Io,
            WireErrorCode::OperationFailed => Self::OperationFailed,
            WireErrorCode::Unsupported => Self::Unsupported,
        }
    }
}

#[cfg(windows)]
fn launch_elevated(
    request: &Path,
    response: &Path,
    _authorization_prompt: Option<&str>,
) -> PlatformResult<()> {
    windows_launcher::launch(request, response)
}

#[cfg(not(windows))]
fn launch_elevated(
    _request: &Path,
    _response: &Path,
    _authorization_prompt: Option<&str>,
) -> PlatformResult<()> {
    Err(PlatformError::new(
        PlatformErrorCode::Unsupported,
        "startup helper is unavailable on this platform",
    ))
}

#[cfg(windows)]
mod windows_launcher {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, WAIT_OBJECT_0},
        System::Threading::{GetExitCodeProcess, WaitForSingleObject, INFINITE},
    };

    use super::*;

    pub(super) fn launch(request: &Path, response: &Path) -> PlatformResult<()> {
        let process =
            crate::platform::elevation::launch_platform(crate::platform::elevation::LaunchRequest::Startup {
                request: request.to_owned(),
                response: response.to_owned(),
            })?;
        let wait = unsafe { WaitForSingleObject(process, INFINITE) };
        let mut exit_code = HELPER_FAILURE_EXIT_CODE as u32;
        let exit_read = unsafe { GetExitCodeProcess(process, &mut exit_code) };
        unsafe {
            CloseHandle(process);
        }
        if wait != WAIT_OBJECT_0 || exit_read == 0 || exit_code != HELPER_SUCCESS_EXIT_CODE as u32 {
            return Err(PlatformError::operation_failed(
                "startup helper process failed",
            ));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normal_arguments_do_not_enter_helper_mode() {
        assert_eq!(run(&[OsString::from("Systools")]), None);
        assert_eq!(
            run(&[
                OsString::from("Systools"),
                OsString::from("--systools-startup-helper-v0")
            ]),
            Some(HELPER_FAILURE_EXIT_CODE)
        );
    }

    #[test]
    fn helper_paths_reject_relative_and_foreign_messages() {
        assert!(helper_paths(&[
            OsString::from("Systools"),
            OsString::from(HELPER_FLAG),
            OsString::from("request.json"),
            OsString::from("response.json"),
        ])
        .is_err());

        let outside = helper_temporary_directory().join("systools-helper-outside");
        assert!(helper_paths(&[
            OsString::from("Systools"),
            OsString::from(HELPER_FLAG),
            outside.join("request.json").into_os_string(),
            outside.join("response.json").into_os_string(),
        ])
        .is_err());
    }

    #[test]
    fn request_file_names_must_match_the_embedded_nonce() {
        let path_nonce = unique_nonce();
        let paths = message_paths(&path_nonce).expect("helper paths");
        let request = HelperRequest {
            protocol: PROTOCOL.to_owned(),
            nonce: unique_nonce(),
            items: vec![HelperRequestItem {
                source_id: "test.startup".to_owned(),
                provider_item_id: "fixture".to_owned(),
                expected_artifact_digest: "fixture-digest".to_owned(),
                desired_state: WireState::Disabled,
            }],
        };
        write_private_message(&paths.request, &request).expect("write request");
        let result = execute_helper_request(&paths.request, &paths.response);
        let _ = fs::remove_file(&paths.request);
        let _ = fs::remove_file(&paths.response);
        assert!(result.is_err());
    }

    #[test]
    fn empty_batches_fail_before_platform_dispatch() {
        let nonce = unique_nonce();
        let paths = message_paths(&nonce).expect("helper paths");
        let request = HelperRequest {
            protocol: PROTOCOL.to_owned(),
            nonce,
            items: Vec::new(),
        };
        write_private_message(&paths.request, &request).expect("write request");
        let result = execute_helper_request(&paths.request, &paths.response);
        let _ = fs::remove_file(&paths.request);
        assert_eq!(
            result.expect_err("empty batch").code(),
            PlatformErrorCode::InvalidData
        );
    }

    #[test]
    fn privileged_batch_rejects_empty_requests_before_launching() {
        assert_eq!(
            change_many_with_privileges(&[], None)
                .expect_err("empty batch")
                .code(),
            PlatformErrorCode::InvalidData
        );
    }

    #[test]
    fn bounded_text_strips_control_characters_and_marks_truncation() {
        let text = bounded_text("line\none\u{0}two", 16);
        assert!(!text.contains('\n'));
        let long = bounded_text(&"a".repeat(64), 16);
        assert!(long.ends_with("[truncated]"));
        assert_eq!(long.chars().count(), 16);
    }
}
