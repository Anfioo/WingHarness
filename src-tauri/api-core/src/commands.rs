//! The Tauri command surface for the API client. Every command is a thin typed
//! wrapper over the engine modules ([`crate::workspace`], [`crate::send`],
//! [`crate::cancel`]); payloads are the shared [`crate::models`] types.

use std::time::Duration;

use crate::error::{AppError, AppResult};
use crate::models::{
    HttpResponse, ImportApplied, ImportOptions, ImportResult, SendRequest, TextFile, WorkspaceMeta,
    WorkspaceTree,
};
use crate::{cancel, send, workspace};

/// Fetched spec documents are capped by this timeout.
const FETCH_TIMEOUT: Duration = Duration::from_secs(30);
/// Spec documents (local or remote) above this size are rejected.
const MAX_TEXT_BYTES: u64 = 8 * 1024 * 1024;

fn too_large(size: u64) -> AppError {
    AppError::other(format!(
        "the document is {size} bytes; the limit is {MAX_TEXT_BYTES} bytes (8 MiB)"
    ))
}

/// `api_workspace_save` returns only the new revision, not the whole tree.
#[derive(serde::Serialize)]
pub struct WorkspaceSaveResult {
    revision: u64,
}

/// App version, for the frontend's diagnostics line.
#[tauri::command]
pub async fn api_app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// Every saved workspace, as lightweight rows for the list.
#[tauri::command]
pub async fn api_workspaces_list() -> AppResult<Vec<WorkspaceMeta>> {
    workspace::list()
}

/// Create a workspace and return its row.
#[tauri::command]
pub async fn api_workspace_create(name: String) -> AppResult<WorkspaceMeta> {
    workspace::create(&name)
}

/// Rename a workspace and return its updated row.
#[tauri::command]
pub async fn api_workspace_rename(id: String, name: String) -> AppResult<WorkspaceMeta> {
    workspace::rename(&id, &name)
}

/// Delete a workspace and its stored tree.
#[tauri::command]
pub async fn api_workspace_delete(id: String) -> AppResult<()> {
    workspace::delete(&id)
}

/// Load a workspace's full tree.
#[tauri::command]
pub async fn api_workspace_load(id: String) -> AppResult<WorkspaceTree> {
    workspace::load(&id)
}

/// Save a workspace tree and return the new revision. `expected_revision` is the
/// revision the caller believes it holds; a mismatch is rejected with a conflict.
#[tauri::command]
pub async fn api_workspace_save(
    id: String,
    tree: WorkspaceTree,
    expected_revision: Option<u64>,
) -> AppResult<WorkspaceSaveResult> {
    let revision = workspace::save(&id, &tree, expected_revision)?;
    Ok(WorkspaceSaveResult { revision })
}

/// Send a request. `request_id` keys the in-flight entry so it can be cancelled.
#[tauri::command]
pub async fn api_send_request(request_id: String, request: SendRequest) -> AppResult<HttpResponse> {
    // The token unregisters the request from the registry when it drops, so it
    // must outlive the send — the binding below does that for the whole await.
    let token = cancel::register(&request_id);
    send::send(request, token).await
}

/// Cancel an in-flight send; returns whether a live request was found.
#[tauri::command]
pub async fn api_cancel_request(request_id: String) -> AppResult<bool> {
    Ok(cancel::cancel(&request_id))
}

/// Read a local UTF-8 text file (an OpenAPI spec from disk).
#[tauri::command]
pub async fn api_read_text_file(path: String) -> AppResult<TextFile> {
    let size = tokio::fs::metadata(&path).await?.len();
    if size > MAX_TEXT_BYTES {
        return Err(too_large(size));
    }
    let text = tokio::fs::read_to_string(&path).await?;
    let bytes = text.len() as u64;
    Ok(TextFile { text, bytes })
}

/// Fetch a text document over HTTP(S) (an OpenAPI spec from a URL).
#[tauri::command]
pub async fn api_fetch_spec_url(url: String) -> AppResult<TextFile> {
    let parsed = reqwest::Url::parse(&url)?;
    match parsed.scheme() {
        "http" | "https" => {}
        other => {
            return Err(AppError::other(format!(
                "unsupported URL scheme {other:?}; only http and https are allowed"
            )))
        }
    }

    let client = reqwest::Client::builder().timeout(FETCH_TIMEOUT).build()?;
    let response = client.get(parsed).send().await?;
    if let Some(size) = response.content_length() {
        if size > MAX_TEXT_BYTES {
            return Err(too_large(size));
        }
    }
    let body = response.bytes().await?;
    if body.len() as u64 > MAX_TEXT_BYTES {
        return Err(too_large(body.len() as u64));
    }
    Ok(TextFile {
        text: String::from_utf8_lossy(&body).into_owned(),
        bytes: body.len() as u64,
    })
}

/// Merge a parsed import into a workspace, returning the new revision and count.
#[tauri::command]
pub async fn api_import_apply(
    id: String,
    import_result: ImportResult,
    options: ImportOptions,
) -> AppResult<ImportApplied> {
    // The command surface has no expected-revision argument for imports; the
    // engine's optional guard is left open, matching the frontend contract.
    workspace::apply_import(&id, import_result, options, None)
}
