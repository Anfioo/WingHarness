// Part of the one-mail module, adapted from OneMail
// (https://github.com/zhihui-hu/one-mail), AGPL-3.0-only.
// See `UPSTREAM.md` in this crate for the porting record.

//! Every DTO, input and enum crossing the command boundary.
//!
//! Struct names and fields are the frozen contract with
//! `src/commands/services/one-mail/types.ts`: structs serialize in camelCase,
//! enums in snake_case. `OneMailErrorCode` lives in `error.rs` and is
//! kebab-case. Do not rename a field without updating the TypeScript mirror in
//! the same change.

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthKind {
    Oauth2,
    AppPassword,
    Password,
    Bridge,
    Manual,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Security {
    SslTls,
    Starttls,
    None,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FolderRole {
    Inbox,
    Sent,
    Drafts,
    Trash,
    Junk,
    Archive,
    AllMail,
    Important,
    Starred,
    Custom,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AccountStatus {
    Active,
    Disabled,
    Syncing,
    AuthError,
    SyncError,
    NetworkError,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BodyStatus {
    None,
    Loading,
    Ready,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BodyDisplayMode {
    Text,
    Html,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RemoteImagesPolicy {
    Block,
    Load,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SyncMode {
    Refresh,
    Full,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ComposeKind {
    New,
    Reply,
    ReplyAll,
    Forward,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OutboxStatus {
    Draft,
    Queued,
    Sending,
    Sent,
    Failed,
    Cancelled,
}

// ---------------------------------------------------------------------------
// Enum <-> stored text
// ---------------------------------------------------------------------------
//
// The SQLite columns store the same snake_case strings the enums serialize as.
// Every lane goes through these two methods instead of keeping a private copy,
// so a new variant cannot drift between the store, the transport and the
// conversation queries.

impl AuthKind {
    pub fn as_str(self) -> &'static str {
        match self {
            AuthKind::Oauth2 => "oauth2",
            AuthKind::AppPassword => "app_password",
            AuthKind::Password => "password",
            AuthKind::Bridge => "bridge",
            AuthKind::Manual => "manual",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "oauth2" => Some(AuthKind::Oauth2),
            "app_password" => Some(AuthKind::AppPassword),
            "password" => Some(AuthKind::Password),
            "bridge" => Some(AuthKind::Bridge),
            "manual" => Some(AuthKind::Manual),
            _ => None,
        }
    }
}

impl Security {
    pub fn as_str(self) -> &'static str {
        match self {
            Security::SslTls => "ssl_tls",
            Security::Starttls => "starttls",
            Security::None => "none",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "ssl_tls" => Some(Security::SslTls),
            "starttls" => Some(Security::Starttls),
            "none" => Some(Security::None),
            _ => None,
        }
    }
}

impl FolderRole {
    pub fn as_str(self) -> &'static str {
        match self {
            FolderRole::Inbox => "inbox",
            FolderRole::Sent => "sent",
            FolderRole::Drafts => "drafts",
            FolderRole::Trash => "trash",
            FolderRole::Junk => "junk",
            FolderRole::Archive => "archive",
            FolderRole::AllMail => "all_mail",
            FolderRole::Important => "important",
            FolderRole::Starred => "starred",
            FolderRole::Custom => "custom",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "inbox" => Some(FolderRole::Inbox),
            "sent" => Some(FolderRole::Sent),
            "drafts" => Some(FolderRole::Drafts),
            "trash" => Some(FolderRole::Trash),
            "junk" => Some(FolderRole::Junk),
            "archive" => Some(FolderRole::Archive),
            "all_mail" => Some(FolderRole::AllMail),
            "important" => Some(FolderRole::Important),
            "starred" => Some(FolderRole::Starred),
            "custom" => Some(FolderRole::Custom),
            _ => None,
        }
    }
}

impl AccountStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            AccountStatus::Active => "active",
            AccountStatus::Disabled => "disabled",
            AccountStatus::Syncing => "syncing",
            AccountStatus::AuthError => "auth_error",
            AccountStatus::SyncError => "sync_error",
            AccountStatus::NetworkError => "network_error",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "active" => Some(AccountStatus::Active),
            "disabled" => Some(AccountStatus::Disabled),
            "syncing" => Some(AccountStatus::Syncing),
            "auth_error" => Some(AccountStatus::AuthError),
            "sync_error" => Some(AccountStatus::SyncError),
            "network_error" => Some(AccountStatus::NetworkError),
            _ => None,
        }
    }
}

impl BodyStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            BodyStatus::None => "none",
            BodyStatus::Loading => "loading",
            BodyStatus::Ready => "ready",
            BodyStatus::Error => "error",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "none" => Some(BodyStatus::None),
            "loading" => Some(BodyStatus::Loading),
            "ready" => Some(BodyStatus::Ready),
            "error" => Some(BodyStatus::Error),
            _ => None,
        }
    }
}

impl BodyDisplayMode {
    pub fn as_str(self) -> &'static str {
        match self {
            BodyDisplayMode::Text => "text",
            BodyDisplayMode::Html => "html",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "text" => Some(BodyDisplayMode::Text),
            "html" => Some(BodyDisplayMode::Html),
            _ => None,
        }
    }
}

impl RemoteImagesPolicy {
    pub fn as_str(self) -> &'static str {
        match self {
            RemoteImagesPolicy::Block => "block",
            RemoteImagesPolicy::Load => "load",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "block" => Some(RemoteImagesPolicy::Block),
            "load" => Some(RemoteImagesPolicy::Load),
            _ => None,
        }
    }
}

impl SyncMode {
    pub fn as_str(self) -> &'static str {
        match self {
            SyncMode::Refresh => "refresh",
            SyncMode::Full => "full",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "refresh" => Some(SyncMode::Refresh),
            "full" => Some(SyncMode::Full),
            _ => None,
        }
    }
}

impl ComposeKind {
    pub fn as_str(self) -> &'static str {
        match self {
            ComposeKind::New => "new",
            ComposeKind::Reply => "reply",
            ComposeKind::ReplyAll => "reply_all",
            ComposeKind::Forward => "forward",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "new" => Some(ComposeKind::New),
            "reply" => Some(ComposeKind::Reply),
            "reply_all" => Some(ComposeKind::ReplyAll),
            "forward" => Some(ComposeKind::Forward),
            _ => None,
        }
    }
}

impl OutboxStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            OutboxStatus::Draft => "draft",
            OutboxStatus::Queued => "queued",
            OutboxStatus::Sending => "sending",
            OutboxStatus::Sent => "sent",
            OutboxStatus::Failed => "failed",
            OutboxStatus::Cancelled => "cancelled",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "draft" => Some(OutboxStatus::Draft),
            "queued" => Some(OutboxStatus::Queued),
            "sending" => Some(OutboxStatus::Sending),
            "sent" => Some(OutboxStatus::Sent),
            "failed" => Some(OutboxStatus::Failed),
            "cancelled" => Some(OutboxStatus::Cancelled),
            _ => None,
        }
    }
}

// ---------------------------------------------------------------------------
// Providers and accounts
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderPreset {
    pub key: String,
    pub display_name: String,
    pub domains: Vec<String>,
    pub auth_type: AuthKind,
    pub imap_host: String,
    pub imap_port: u16,
    pub imap_security: Security,
    pub smtp_host: Option<String>,
    pub smtp_port: Option<u16>,
    pub smtp_security: Option<Security>,
    pub smtp_auth_type: Option<AuthKind>,
    pub smtp_requires_auth: bool,
    pub requires_enable_imap: bool,
    pub requires_app_password: bool,
    pub setup_help_url: Option<String>,
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountSummary {
    pub account_id: i64,
    pub provider_key: String,
    pub email: String,
    pub display_name: Option<String>,
    pub account_label: String,
    pub avatar_text: String,
    pub color_key: String,
    pub auth_type: AuthKind,
    pub imap_host: String,
    pub imap_port: u16,
    pub imap_security: Security,
    pub smtp_host: Option<String>,
    pub smtp_port: Option<u16>,
    pub smtp_security: Option<Security>,
    pub smtp_auth_type: Option<AuthKind>,
    pub smtp_enabled: bool,
    pub sync_enabled: bool,
    pub status: AccountStatus,
    pub last_sync_at: Option<String>,
    pub last_error: Option<String>,
    pub total_count: i64,
    pub unread_count: i64,
    pub latest_message_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountInput {
    pub provider_key: String,
    pub email: String,
    pub display_name: Option<String>,
    pub account_label: Option<String>,
    pub auth_type: AuthKind,
    pub imap_host: String,
    pub imap_port: u16,
    pub imap_security: Security,
    pub smtp_enabled: bool,
    pub smtp_host: Option<String>,
    pub smtp_port: Option<u16>,
    pub smtp_security: Option<Security>,
    pub smtp_auth_type: Option<AuthKind>,
    pub password: String,
    pub sync_enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountUpdateInput {
    pub account_id: i64,
    pub display_name: Option<String>,
    pub account_label: Option<String>,
    pub imap_host: Option<String>,
    pub imap_port: Option<u16>,
    pub imap_security: Option<Security>,
    pub smtp_enabled: Option<bool>,
    pub smtp_host: Option<String>,
    pub smtp_port: Option<u16>,
    pub smtp_security: Option<Security>,
    pub smtp_auth_type: Option<AuthKind>,
    /// `None` keeps the stored password unchanged.
    pub password: Option<String>,
    pub sync_enabled: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountTestInput {
    pub provider_key: String,
    pub email: String,
    pub auth_type: AuthKind,
    pub imap_host: String,
    pub imap_port: u16,
    pub imap_security: Security,
    pub smtp_enabled: bool,
    pub smtp_host: Option<String>,
    pub smtp_port: Option<u16>,
    pub smtp_security: Option<Security>,
    pub smtp_auth_type: Option<AuthKind>,
    pub password: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionTestResult {
    pub imap_ok: bool,
    pub smtp_ok: Option<bool>,
    pub imap_error: Option<String>,
    pub smtp_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderDiscoveryInput {
    pub provider_key: String,
    pub email: String,
    pub auth_type: AuthKind,
    pub imap_host: String,
    pub imap_port: u16,
    pub imap_security: Security,
    pub password: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderCandidate {
    pub path: String,
    pub name: String,
    pub delimiter: Option<String>,
    pub role: FolderRole,
    pub selectable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MailFolder {
    pub folder_id: i64,
    pub account_id: i64,
    pub path: String,
    pub name: String,
    pub role: FolderRole,
    pub selectable: bool,
    pub sync_enabled: bool,
    pub total_count: i64,
    pub unread_count: i64,
    pub last_sync_at: Option<String>,
}

// ---------------------------------------------------------------------------
// Messages and conversations
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MailAddress {
    pub name: Option<String>,
    pub email: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageAddress {
    pub kind: String,
    pub name: Option<String>,
    pub email: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageSummary {
    pub message_id: i64,
    pub account_id: i64,
    pub folder_id: i64,
    pub folder_path: String,
    pub folder_role: FolderRole,
    pub subject: Option<String>,
    pub from_name: Option<String>,
    pub from_email: Option<String>,
    pub to: Vec<MailAddress>,
    pub cc: Vec<MailAddress>,
    pub received_at: Option<String>,
    pub snippet: Option<String>,
    pub is_read: bool,
    pub is_starred: bool,
    pub has_attachments: bool,
    pub body_status: BodyStatus,
    pub body_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentInfo {
    pub attachment_id: i64,
    pub filename: String,
    pub mime_type: Option<String>,
    pub content_disposition: Option<String>,
    pub size_bytes: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageBody {
    pub message_id: i64,
    pub body_text: Option<String>,
    pub body_html: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageDetail {
    pub summary: MessageSummary,
    pub body: Option<MessageBody>,
    pub attachments: Vec<AttachmentInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageBodyLoad {
    pub body: Option<MessageBody>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RawMessage {
    pub headers: String,
    pub body_text: Option<String>,
    pub body_html: Option<String>,
    pub size_bytes: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationQuery {
    pub account_id: Option<i64>,
    pub keyword: Option<String>,
    pub unread_only: bool,
    pub starred_only: bool,
    pub received_from: Option<String>,
    pub received_before: Option<String>,
    /// 1..=200; the frontend sends 50.
    pub limit: u32,
    pub offset: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationParticipant {
    pub name: Option<String>,
    pub email: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationSummary {
    pub conversation_key: String,
    pub account_id: i64,
    pub participants: Vec<ConversationParticipant>,
    pub display_name: String,
    pub last_message: MessageSummary,
    pub message_count: u32,
    pub unread_count: u32,
    pub has_attachments: bool,
    pub is_starred: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationPage {
    pub items: Vec<ConversationSummary>,
    pub total: u32,
    pub has_more: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationMessagesQuery {
    pub account_id: i64,
    pub conversation_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadGroup {
    pub thread_key: String,
    pub subject: Option<String>,
    pub messages: Vec<MessageSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationThread {
    pub conversation_key: String,
    pub account_id: i64,
    pub participants: Vec<ConversationParticipant>,
    pub groups: Vec<ThreadGroup>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchQuery {
    pub account_id: Option<i64>,
    pub keyword: String,
    pub unread_only: bool,
    pub starred_only: bool,
    pub received_from: Option<String>,
    pub received_before: Option<String>,
    pub limit: u32,
    pub offset: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub message: MessageSummary,
    /// Which indexed field matched: `subject`, `from` or `body`.
    pub matched_in: String,
    pub excerpt: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageSearchPage {
    pub items: Vec<SearchHit>,
    pub total: u32,
    pub has_more: bool,
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncInput {
    pub account_id: Option<i64>,
    pub mode: SyncMode,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderSyncReport {
    pub folder_id: i64,
    pub path: String,
    pub scanned: u32,
    pub inserted: u32,
    pub updated: u32,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    pub account_id: Option<i64>,
    pub folders: Vec<FolderSyncReport>,
    pub new_message_count: u32,
    pub ok: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncProgressPayload {
    pub account_id: i64,
    pub folder_path: Option<String>,
    /// One of `connecting`, `folders`, `headers`, `saving`, `done`, `error`.
    pub stage: String,
    pub fetched: u32,
    pub inserted: u32,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub running: bool,
    pub account_id: Option<i64>,
    pub started_at: Option<String>,
    pub last_finished_at: Option<String>,
    pub last_error: Option<String>,
}

// ---------------------------------------------------------------------------
// Event payloads
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewMailPayload {
    pub account_id: i64,
    pub account_label: String,
    pub messages: Vec<MessageSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MailboxChangedPayload {
    pub account_id: i64,
    pub folder_id: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutboxChangedPayload {
    pub outbox_id: Option<i64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountsChangedPayload {}

// ---------------------------------------------------------------------------
// Compose and outbox
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftInput {
    pub outbox_id: Option<i64>,
    pub account_id: i64,
    pub compose_kind: ComposeKind,
    pub related_message_id: Option<i64>,
    pub to: Vec<MailAddress>,
    pub cc: Vec<MailAddress>,
    pub bcc: Vec<MailAddress>,
    pub subject: String,
    pub body_text: String,
    pub body_html: String,
    pub attachments: Vec<DraftAttachmentInput>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftAttachmentInput {
    pub file_path: Option<String>,
    pub filename: String,
    pub mime_type: Option<String>,
    pub size_bytes: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Draft {
    pub outbox_id: i64,
    pub account_id: i64,
    pub compose_kind: ComposeKind,
    pub related_message_id: Option<i64>,
    pub to: Vec<MailAddress>,
    pub cc: Vec<MailAddress>,
    pub bcc: Vec<MailAddress>,
    pub subject: String,
    pub body_text: String,
    pub body_html: String,
    pub attachments: Vec<DraftAttachmentInput>,
    pub in_reply_to: Option<String>,
    pub references_header: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendInput {
    pub outbox_id: Option<i64>,
    pub account_id: i64,
    pub compose_kind: ComposeKind,
    pub related_message_id: Option<i64>,
    pub to: Vec<MailAddress>,
    pub cc: Vec<MailAddress>,
    pub bcc: Vec<MailAddress>,
    pub subject: String,
    pub body_text: String,
    pub body_html: String,
    pub attachments: Vec<DraftAttachmentInput>,
    pub in_reply_to: Option<String>,
    pub references_header: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendResult {
    pub outbox_id: i64,
    pub status: OutboxStatus,
    pub rfc822_message_id: String,
    pub sent_at: Option<String>,
    pub warning: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutboxItem {
    pub outbox_id: i64,
    pub account_id: i64,
    pub compose_kind: ComposeKind,
    pub status: OutboxStatus,
    pub subject: Option<String>,
    pub to: Vec<MailAddress>,
    pub cc: Vec<MailAddress>,
    pub bcc: Vec<MailAddress>,
    pub snippet: Option<String>,
    pub created_at: String,
    pub sent_at: Option<String>,
    pub last_error: Option<String>,
    pub attachment_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PickedAttachment {
    pub file_path: String,
    pub filename: String,
    pub mime_type: Option<String>,
    pub size_bytes: i64,
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OneMailSettings {
    pub version: u32,
    pub refresh_interval_minutes: u32,
    pub body_display_mode: BodyDisplayMode,
    pub remote_images_policy: RemoteImagesPolicy,
    pub sync_window_days: u32,
    pub notify_on_new_mail: bool,
}

impl Default for OneMailSettings {
    fn default() -> Self {
        Self {
            version: 1,
            refresh_interval_minutes: 5,
            body_display_mode: BodyDisplayMode::Html,
            remote_images_policy: RemoteImagesPolicy::Block,
            sync_window_days: 90,
            notify_on_new_mail: true,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_enum_round_trips_through_its_stored_text() {
        for value in [
            AuthKind::Oauth2,
            AuthKind::AppPassword,
            AuthKind::Password,
            AuthKind::Bridge,
            AuthKind::Manual,
        ] {
            assert_eq!(AuthKind::parse(value.as_str()), Some(value));
        }
        for value in [Security::SslTls, Security::Starttls, Security::None] {
            assert_eq!(Security::parse(value.as_str()), Some(value));
        }
        for value in [
            FolderRole::Inbox,
            FolderRole::Sent,
            FolderRole::Drafts,
            FolderRole::Trash,
            FolderRole::Junk,
            FolderRole::Archive,
            FolderRole::AllMail,
            FolderRole::Important,
            FolderRole::Starred,
            FolderRole::Custom,
        ] {
            assert_eq!(FolderRole::parse(value.as_str()), Some(value));
        }
        for value in [
            AccountStatus::Active,
            AccountStatus::Disabled,
            AccountStatus::Syncing,
            AccountStatus::AuthError,
            AccountStatus::SyncError,
            AccountStatus::NetworkError,
        ] {
            assert_eq!(AccountStatus::parse(value.as_str()), Some(value));
        }
        for value in [
            BodyStatus::None,
            BodyStatus::Loading,
            BodyStatus::Ready,
            BodyStatus::Error,
        ] {
            assert_eq!(BodyStatus::parse(value.as_str()), Some(value));
        }
        for value in [BodyDisplayMode::Text, BodyDisplayMode::Html] {
            assert_eq!(BodyDisplayMode::parse(value.as_str()), Some(value));
        }
        for value in [RemoteImagesPolicy::Block, RemoteImagesPolicy::Load] {
            assert_eq!(RemoteImagesPolicy::parse(value.as_str()), Some(value));
        }
        for value in [SyncMode::Refresh, SyncMode::Full] {
            assert_eq!(SyncMode::parse(value.as_str()), Some(value));
        }
        for value in [
            ComposeKind::New,
            ComposeKind::Reply,
            ComposeKind::ReplyAll,
            ComposeKind::Forward,
        ] {
            assert_eq!(ComposeKind::parse(value.as_str()), Some(value));
        }
        for value in [
            OutboxStatus::Draft,
            OutboxStatus::Queued,
            OutboxStatus::Sending,
            OutboxStatus::Sent,
            OutboxStatus::Failed,
            OutboxStatus::Cancelled,
        ] {
            assert_eq!(OutboxStatus::parse(value.as_str()), Some(value));
        }
    }

    #[test]
    fn stored_text_matches_the_serialized_values() {
        assert_eq!(FolderRole::AllMail.as_str(), "all_mail");
        assert_eq!(ComposeKind::ReplyAll.as_str(), "reply_all");
        assert_eq!(AuthKind::AppPassword.as_str(), "app_password");
        assert_eq!(Security::SslTls.as_str(), "ssl_tls");
        assert_eq!(AccountStatus::NetworkError.as_str(), "network_error");
        assert_eq!(OutboxStatus::Cancelled.as_str(), "cancelled");
        assert_eq!(AuthKind::parse("not_a_kind"), None);
    }
}
