// Part of the one-mail module, adapted from OneMail
// (https://github.com/zhihui-hu/one-mail), AGPL-3.0-only.
// See `src-tauri/one-mail-core/UPSTREAM.md` for the porting record.

/**
 * Mirrors `src-tauri/one-mail-core/src/models.rs` field for field.
 *
 * The Rust side serialises structs as camelCase and enums as snake_case, so
 * every name here is the frozen contract with the backend. Adding, renaming or
 * dropping a field without the same change in `models.rs` breaks every
 * one-mail track.
 */

export type AuthKind = "oauth2" | "app_password" | "password" | "bridge" | "manual";

export type Security = "ssl_tls" | "starttls" | "none";

export type FolderRole =
  | "inbox"
  | "sent"
  | "drafts"
  | "trash"
  | "junk"
  | "archive"
  | "all_mail"
  | "important"
  | "starred"
  | "custom";

export type AccountStatus =
  "active" | "disabled" | "syncing" | "auth_error" | "sync_error" | "network_error";

export type BodyStatus = "none" | "loading" | "ready" | "error";

export type BodyDisplayMode = "text" | "html";

export type RemoteImagesPolicy = "block" | "load";

export type SyncMode = "refresh" | "full";

export type ComposeKind = "new" | "reply" | "reply_all" | "forward";

export type OutboxStatus = "draft" | "queued" | "sending" | "sent" | "failed" | "cancelled";

/** The stage carried by `one-mail:sync-progress`. */
export type SyncStage = "connecting" | "folders" | "headers" | "saving" | "done" | "error";

// ---------------------------------------------------------------------------
// Providers and accounts
// ---------------------------------------------------------------------------

export interface ProviderPreset {
  key: string;
  displayName: string;
  domains: string[];
  authType: AuthKind;
  imapHost: string;
  imapPort: number;
  imapSecurity: Security;
  smtpHost: string | null;
  smtpPort: number | null;
  smtpSecurity: Security | null;
  smtpAuthType: AuthKind | null;
  smtpRequiresAuth: boolean;
  requiresEnableImap: boolean;
  requiresAppPassword: boolean;
  setupHelpUrl: string | null;
  notes: string | null;
}

export interface AccountSummary {
  accountId: number;
  providerKey: string;
  email: string;
  displayName: string | null;
  accountLabel: string;
  avatarText: string;
  colorKey: string;
  authType: AuthKind;
  imapHost: string;
  imapPort: number;
  imapSecurity: Security;
  smtpHost: string | null;
  smtpPort: number | null;
  smtpSecurity: Security | null;
  smtpAuthType: AuthKind | null;
  smtpEnabled: boolean;
  syncEnabled: boolean;
  status: AccountStatus;
  lastSyncAt: string | null;
  lastError: string | null;
  totalCount: number;
  unreadCount: number;
  latestMessageAt: string | null;
}

export interface AccountInput {
  providerKey: string;
  email: string;
  displayName: string | null;
  accountLabel: string | null;
  authType: AuthKind;
  imapHost: string;
  imapPort: number;
  imapSecurity: Security;
  smtpEnabled: boolean;
  smtpHost: string | null;
  smtpPort: number | null;
  smtpSecurity: Security | null;
  smtpAuthType: AuthKind | null;
  password: string;
  syncEnabled: boolean;
}

export interface AccountUpdateInput {
  accountId: number;
  displayName: string | null;
  accountLabel: string | null;
  imapHost: string | null;
  imapPort: number | null;
  imapSecurity: Security | null;
  smtpEnabled: boolean | null;
  smtpHost: string | null;
  smtpPort: number | null;
  smtpSecurity: Security | null;
  smtpAuthType: AuthKind | null;
  /** `null` keeps the stored password unchanged. */
  password: string | null;
  syncEnabled: boolean | null;
}

export interface AccountTestInput {
  providerKey: string;
  email: string;
  authType: AuthKind;
  imapHost: string;
  imapPort: number;
  imapSecurity: Security;
  smtpEnabled: boolean;
  smtpHost: string | null;
  smtpPort: number | null;
  smtpSecurity: Security | null;
  smtpAuthType: AuthKind | null;
  password: string;
}

export interface ConnectionTestResult {
  imapOk: boolean;
  smtpOk: boolean | null;
  imapError: string | null;
  smtpError: string | null;
}

export interface FolderDiscoveryInput {
  providerKey: string;
  email: string;
  authType: AuthKind;
  imapHost: string;
  imapPort: number;
  imapSecurity: Security;
  password: string;
}

export interface FolderCandidate {
  path: string;
  name: string;
  delimiter: string | null;
  role: FolderRole;
  selectable: boolean;
}

export interface MailFolder {
  folderId: number;
  accountId: number;
  path: string;
  name: string;
  role: FolderRole;
  selectable: boolean;
  syncEnabled: boolean;
  totalCount: number;
  unreadCount: number;
  lastSyncAt: string | null;
}

// ---------------------------------------------------------------------------
// Messages and conversations
// ---------------------------------------------------------------------------

export interface MailAddress {
  name: string | null;
  email: string;
}

export interface MessageAddress {
  kind: string;
  name: string | null;
  email: string;
}

export interface MessageSummary {
  messageId: number;
  accountId: number;
  folderId: number;
  folderPath: string;
  folderRole: FolderRole;
  subject: string | null;
  fromName: string | null;
  fromEmail: string | null;
  to: MailAddress[];
  cc: MailAddress[];
  receivedAt: string | null;
  snippet: string | null;
  isRead: boolean;
  isStarred: boolean;
  hasAttachments: boolean;
  bodyStatus: BodyStatus;
  bodyError: string | null;
}

export interface AttachmentInfo {
  attachmentId: number;
  filename: string;
  mimeType: string | null;
  contentDisposition: string | null;
  sizeBytes: number;
}

export interface MessageBody {
  messageId: number;
  bodyText: string | null;
  bodyHtml: string | null;
}

export interface MessageDetail {
  summary: MessageSummary;
  body: MessageBody | null;
  attachments: AttachmentInfo[];
}

export interface MessageBodyLoad {
  body: MessageBody | null;
  error: string | null;
}

export interface RawMessage {
  headers: string;
  bodyText: string | null;
  bodyHtml: string | null;
  sizeBytes: number;
}

export interface ConversationQuery {
  accountId: number | null;
  keyword: string | null;
  unreadOnly: boolean;
  starredOnly: boolean;
  receivedFrom: string | null;
  receivedBefore: string | null;
  limit: number;
  offset: number;
}

export interface ConversationParticipant {
  name: string | null;
  email: string;
}

export interface ConversationSummary {
  conversationKey: string;
  accountId: number;
  participants: ConversationParticipant[];
  displayName: string;
  lastMessage: MessageSummary;
  messageCount: number;
  unreadCount: number;
  hasAttachments: boolean;
  isStarred: boolean;
}

export interface ConversationPage {
  items: ConversationSummary[];
  total: number;
  hasMore: boolean;
}

export interface ConversationMessagesQuery {
  accountId: number;
  conversationKey: string;
}

export interface ThreadGroup {
  threadKey: string;
  subject: string | null;
  messages: MessageSummary[];
}

export interface ConversationThread {
  conversationKey: string;
  accountId: number;
  participants: ConversationParticipant[];
  groups: ThreadGroup[];
  /** True when the thread holds more messages than the 500 the backend reads. */
  truncated: boolean;
}

export interface SearchQuery {
  accountId: number | null;
  keyword: string;
  unreadOnly: boolean;
  starredOnly: boolean;
  receivedFrom: string | null;
  receivedBefore: string | null;
  limit: number;
  offset: number;
}

export interface SearchHit {
  message: MessageSummary;
  /** Which indexed field matched: `subject`, `from` or `body`. */
  matchedIn: string;
  excerpt: string | null;
}

export interface MessageSearchPage {
  items: SearchHit[];
  total: number;
  hasMore: boolean;
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

export interface SyncInput {
  accountId: number | null;
  mode: SyncMode;
}

export interface FolderSyncReport {
  folderId: number;
  path: string;
  scanned: number;
  inserted: number;
  updated: number;
  error: string | null;
}

export interface SyncReport {
  accountId: number | null;
  folders: FolderSyncReport[];
  newMessageCount: number;
  ok: boolean;
  error: string | null;
}

export interface SyncProgressPayload {
  accountId: number;
  folderPath: string | null;
  stage: SyncStage;
  fetched: number;
  inserted: number;
  error: string | null;
}

export interface SyncStatus {
  running: boolean;
  accountId: number | null;
  startedAt: string | null;
  lastFinishedAt: string | null;
  lastError: string | null;
}

// ---------------------------------------------------------------------------
// Event payloads
// ---------------------------------------------------------------------------

export interface NewMailPayload {
  accountId: number;
  accountLabel: string;
  messages: MessageSummary[];
}

export interface MailboxChangedPayload {
  accountId: number;
  folderId: number | null;
}

export interface OutboxChangedPayload {
  outboxId: number | null;
}

export type AccountsChangedPayload = Record<string, never>;

// ---------------------------------------------------------------------------
// Compose and outbox
// ---------------------------------------------------------------------------

export interface DraftInput {
  outboxId: number | null;
  accountId: number;
  composeKind: ComposeKind;
  relatedMessageId: number | null;
  to: MailAddress[];
  cc: MailAddress[];
  bcc: MailAddress[];
  subject: string;
  bodyText: string;
  bodyHtml: string;
  attachments: DraftAttachmentInput[];
}

export interface DraftAttachmentInput {
  filePath: string | null;
  filename: string;
  mimeType: string | null;
  sizeBytes: number;
}

export interface Draft {
  outboxId: number;
  accountId: number;
  composeKind: ComposeKind;
  relatedMessageId: number | null;
  to: MailAddress[];
  cc: MailAddress[];
  bcc: MailAddress[];
  subject: string;
  bodyText: string;
  bodyHtml: string;
  attachments: DraftAttachmentInput[];
  inReplyTo: string | null;
  referencesHeader: string | null;
  updatedAt: string;
}

export interface SendInput {
  outboxId: number | null;
  accountId: number;
  composeKind: ComposeKind;
  relatedMessageId: number | null;
  to: MailAddress[];
  cc: MailAddress[];
  bcc: MailAddress[];
  subject: string;
  bodyText: string;
  bodyHtml: string;
  attachments: DraftAttachmentInput[];
  inReplyTo: string | null;
  referencesHeader: string | null;
}

export interface SendResult {
  outboxId: number;
  status: OutboxStatus;
  rfc822MessageId: string;
  sentAt: string | null;
  warning: string | null;
}

export interface OutboxItem {
  outboxId: number;
  accountId: number;
  composeKind: ComposeKind;
  status: OutboxStatus;
  subject: string | null;
  to: MailAddress[];
  cc: MailAddress[];
  bcc: MailAddress[];
  snippet: string | null;
  createdAt: string;
  sentAt: string | null;
  lastError: string | null;
  attachmentCount: number;
}

export interface PickedAttachment {
  filePath: string;
  filename: string;
  mimeType: string | null;
  sizeBytes: number;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface OneMailSettings {
  version: number;
  refreshIntervalMinutes: number;
  bodyDisplayMode: BodyDisplayMode;
  remoteImagesPolicy: RemoteImagesPolicy;
  syncWindowDays: number;
  notifyOnNewMail: boolean;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type OneMailErrorCode =
  | "not-found"
  | "invalid-input"
  | "auth-failed"
  | "network"
  | "tls"
  | "protocol"
  | "database"
  | "busy"
  | "not-configured"
  | "not-implemented"
  | "internal";

export interface OneMailError {
  code: OneMailErrorCode;
  message: string;
  detail: unknown;
}

const ONE_MAIL_ERROR_CODES: OneMailErrorCode[] = [
  "not-found",
  "invalid-input",
  "auth-failed",
  "network",
  "tls",
  "protocol",
  "database",
  "busy",
  "not-configured",
  "not-implemented",
  "internal",
];

/** A rejected invoke carries the serialised `OneMailError` as its payload. */
export function isOneMailError(value: unknown): value is OneMailError {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { code?: unknown; message?: unknown };
  return (
    typeof candidate.message === "string" &&
    typeof candidate.code === "string" &&
    ONE_MAIL_ERROR_CODES.includes(candidate.code as OneMailErrorCode)
  );
}

/** The code of a rejected command; unknown failures map to `internal`. */
export function oneMailErrorCode(value: unknown): OneMailErrorCode {
  return isOneMailError(value) ? value.code : "internal";
}
