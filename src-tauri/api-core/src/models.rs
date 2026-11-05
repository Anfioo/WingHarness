//! Request / response / workspace payloads shared with the frontend.
//!
//! These mirror `src/lib/api-core/types.ts` field for field: every field name is
//! camelCase on the wire, optional fields are `Option<T>` and are omitted when
//! absent, and defaultable fields carry `#[serde(default)]` so a partial payload
//! from the UI still deserializes.

use std::collections::HashMap;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// One `key`/`value` row (query params, headers, form fields, env variables).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyValue {
    #[serde(default)]
    pub key: String,
    #[serde(default)]
    pub value: String,
    #[serde(default)]
    pub enabled: bool,
}

/// How a request body is encoded on the wire.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BodyKind {
    #[default]
    None,
    Json,
    Form,
    Multipart,
    Raw,
}

/// A request body, interpreted according to [`BodyKind`].
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestBody {
    #[serde(default)]
    pub kind: BodyKind,
    /// The literal body for `json` and `raw`.
    #[serde(default)]
    pub text: String,
    /// Rows for `form` (`x-www-form-urlencoded`) and `multipart`.
    #[serde(default)]
    pub rows: Vec<KeyValue>,
    /// `multipart` file fields: field name -> local file path.
    #[serde(default)]
    pub file_paths: HashMap<String, String>,
    /// Content type for `raw`; ignored by the other kinds.
    #[serde(default)]
    pub raw_content_type: String,
}

/// Authentication scheme for a request.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AuthKind {
    #[default]
    None,
    Bearer,
    Basic,
    ApiKey,
}

/// Authentication payload. v1 stores these values in plain text inside the
/// request JSON; the UI must warn the user about that.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Auth {
    #[serde(default)]
    pub kind: AuthKind,
    /// `bearer`
    #[serde(default)]
    pub token: String,
    /// `basic`
    #[serde(default)]
    pub username: String,
    /// `basic`
    #[serde(default)]
    pub password: String,
    /// `apiKey` — v1 only supports a header.
    #[serde(default)]
    pub api_key_name: String,
    #[serde(default)]
    pub api_key_value: String,
}

/// A saved request definition inside the collection tree.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestDef {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    /// Upper-case HTTP method, e.g. `GET` / `POST`.
    #[serde(default)]
    pub method: String,
    /// May contain `{{var}}` templates (the engine never resolves them).
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub params: Vec<KeyValue>,
    #[serde(default)]
    pub headers: Vec<KeyValue>,
    #[serde(default)]
    pub body: RequestBody,
    #[serde(default)]
    pub auth: Auth,
    /// Request-private variables; they override the active environment's
    /// variables of the same name when the frontend resolves `{{var}}`.
    #[serde(default)]
    pub variables: Vec<KeyValue>,
    /// `None` uses the engine default (30_000 ms).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
    /// `None` uses the engine default (true).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub follow_redirects: Option<bool>,
}

/// A folder / collection node. Top-level collections are just nodes; there is no
/// wrapping root node.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionNode {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    /// Sub-folders.
    #[serde(default)]
    pub children: Vec<CollectionNode>,
    /// Requests attached directly to this node.
    #[serde(default)]
    pub requests: Vec<RequestDef>,
}

/// A named set of variables (v1 read-only placeholder).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Environment {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub variables: Vec<KeyValue>,
}

/// Summary row stored in the `workspaces.json` index.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceMeta {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub collection_count: u64,
    #[serde(default)]
    pub request_count: u64,
    #[serde(default = "Utc::now")]
    pub updated_at: DateTime<Utc>,
}

/// The full persisted workspace document (`<id>.json`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceTree {
    pub id: String,
    #[serde(default)]
    pub name: String,
    /// Optimistic concurrency; bumped on every successful save.
    #[serde(default)]
    pub revision: u64,
    #[serde(default)]
    pub collections: Vec<CollectionNode>,
    #[serde(default)]
    pub environments: Vec<Environment>,
    #[serde(default = "Utc::now")]
    pub updated_at: DateTime<Utc>,
}

/// The final, frontend-interpolated request the engine actually sends.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendRequest {
    #[serde(default)]
    pub request_id: String,
    #[serde(default)]
    pub method: String,
    /// Already interpolated; the engine does not resolve `{{}}`.
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub params: Vec<KeyValue>,
    #[serde(default)]
    pub headers: Vec<KeyValue>,
    #[serde(default)]
    pub body: RequestBody,
    #[serde(default)]
    pub auth: Auth,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub follow_redirects: Option<bool>,
}

/// A normalized HTTP response for display.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpResponse {
    #[serde(default)]
    pub status: u16,
    #[serde(default)]
    pub status_text: String,
    /// The headers actually sent, including the ones the engine added.
    #[serde(default)]
    pub request_headers: Vec<KeyValue>,
    #[serde(default)]
    pub headers: Vec<KeyValue>,
    #[serde(default)]
    pub final_url: String,
    /// Set for text responses; `None` for binary.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body_text: Option<String>,
    /// Set for binary responses; `None` for text.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body_base64: Option<String>,
    #[serde(default)]
    pub content_type: String,
    #[serde(default)]
    pub is_binary: bool,
    /// Bytes actually received from the wire.
    #[serde(default)]
    pub size_bytes: u64,
    #[serde(default)]
    pub duration_ms: u64,
    /// True when the body exceeded the engine's 32 MB cap and was cut short.
    #[serde(default)]
    pub truncated: bool,
}

/// The parsed output of an OpenAPI document before it is merged into a workspace.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    /// Usually a single collection named after the spec's title.
    #[serde(default)]
    pub collections: Vec<CollectionNode>,
    #[serde(default)]
    pub warnings: Vec<String>,
    /// Base URL inferred from the spec (`servers` / `host`); empty when absent.
    #[serde(default)]
    pub base_url: String,
}

/// Options that shape how an import is applied.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportOptions {
    /// Prefix for the top-level collection names; empty means no prefix.
    #[serde(default)]
    pub name_prefix: String,
    /// Base URL written into the default environment; empty leaves it unchanged.
    #[serde(default)]
    pub base_url: String,
}

/// The result of applying an import.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportApplied {
    pub revision: u64,
    /// Number of requests added by the import.
    pub added: u64,
}

/// A text file read from disk or fetched over the network.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextFile {
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub bytes: u64,
}