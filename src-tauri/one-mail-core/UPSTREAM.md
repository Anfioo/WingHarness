# Porting record: OneMail

This crate is adapted from [OneMail](https://github.com/zhihui-hu/one-mail).

- Upstream commit: `181ccb62ef183c2d873ffccc5e6478c17c8c7ab1` (2026-11-18)
- Upstream licence: GNU Affero General Public License v3.0 only
  (AGPL-3.0-only). The upstream repository has no `LICENSE` file; its
  `README.md` and `README.en.md` state the licence.
- Upstream copyright: Huzhihui and the OneMail contributors.
- This crate and the whole of WingHarness are AGPL-3.0-only. The root
  `LICENSE` is the GNU AGPL-3.0 text; `licenses/GPL-3.0.txt` is kept for the
  GPL upstreams of other modules.

Every source file in this crate keeps an attribution header pointing here. The
frontend files derived from OneMail carry the same header with a relative path
to this document. The feature guide is
[`docs/features/ONE_MAIL.md`](../../docs/features/ONE_MAIL.md).

## What was kept

- The account model: provider presets, IMAP / SMTP host and port fields,
  security modes, password / app-password authentication, folder discovery and
  the rule that `INBOX` is always synced.
- IMAP synchronisation: one session per account, `UID SEARCH` with a UID cursor,
  a date window, batched `UID FETCH` of headers, `UIDVALIDITY` reset handling,
  and the per-folder message cap.
- MIME handling through `mailparse`: headers, RFC 2047 decoding, address groups,
  `multipart/alternative`, attachment metadata only, charset decoding
  (including GB18030), snippets and the HTML-to-text helper.
- SMTP sending through `lettre`: `multipart/alternative`, attachments, threading
  headers, and `APPEND` to the Sent folder.
- Conversation behaviour: person-centric aggregation, received and sent mail in
  one conversation, the exclusion of self addresses and Bcc-only records,
  reference-based topic grouping with a normalized-subject fallback.
- The compose surface: new / reply / reply-all / forward, draft persistence,
  the outbox, retry and the Bcc-only indicator.
- The reading surface: sanitized HTML, per-message remote-image opt-in, folded
  quotes and signatures, attachment metadata and the raw-message view.

## What was rewritten

- **Persistence.** Upstream's `db/mod.rs` and `schema.sql` were replaced with
  sqlx 0.9 over SQLite (`store.rs`, `schema.rs`), `PRAGMA user_version`
  migrations, WAL, foreign keys and cascading account deletion. OAuth tables,
  sync runs and the remote-operation queue are gone.
- **Command layer.** The upstream `src-tauri/src/commands/data/**` modules were
  rewritten as one crate with a 32-command surface (`commands.rs`) and camelCase
  DTOs (`models.rs`). The root Tauri crate only mounts the commands.
- **Errors.** A single `OneMailError { code, message, detail? }` with a stable
  code set replaces the upstream error shapes; user-facing text is localized in
  the frontend.
- **Events.** Sync progress, new mail, mailbox changes, account changes, outbox
  changes and settings changes are emitted by this crate; upstream used a
  different event set and a background supervisor.
- **Frontend.** The upstream UI (jotai, react-query, tiptap, its own i18n and
  CSS) was not carried over. The pages are React 19 + TypeScript + Tailwind v4
  + shadcn/ui, the editor is CodeMirror 6 with Markdown, the strings live under
  `oneMail.*` in both locales, and HTML is sanitized with DOMPurify.
- **Search.** The FTS5 `trigram` index and the short-query `LIKE` fallback are
  this port's design; the SQL and the filters were written here.

## What was dropped

- OAuth (Google / Microsoft) and the `SyncProvider` implementations for Gmail
  API and Microsoft Graph. Only a trait boundary and documentation remain.
- The AI assistant (`src-tauri/src/ai/**`), the `.onemail` backup and restore
  commands, and the old `.sql` import.
- The background supervisor (`background.rs`): no resident polling, no IDLE,
  no tray unread count and no notification click-through.
- Remote writes: deleting, moving or flagging messages on the server, and
  reading / downloading received attachments.
- The upstream window helpers, theme switching, tray icon, auto-updater and
  source i18n / CSS.

## Per-file notes (AGPL §5(a))

| File | Origin and changes |
|------|--------------------|
| `Cargo.toml` | New crate. Dependencies match the planned set; `license = "AGPL-3.0-only"`. |
| `src/lib.rs` | New module layout and exports. |
| `src/error.rs` | New error type and codes. |
| `src/paths.rs` | New: config directory, database and settings paths, atomic write and corrupt-file backup. |
| `src/models.rs` | New DTOs mirroring the command surface; enums carry `as_str` / `parse` so every lane shares one stored representation. |
| `src/state.rs` | New: lazily opened pool, the single sync lock, event names and shutdown. |
| `src/commands.rs` | Rewritten from `src-tauri/src/commands/data/**`; thin forwards plus the events a domain function cannot emit. |
| `src/schema.rs` | Rewritten from `src-tauri/src/db/schema.sql`; no OAuth / sync-run / operation tables, `user_version` migration, FTS5 index. |
| `src/store.rs` | Rewritten from `src-tauri/src/db/mod.rs` using sqlx; WAL, foreign keys, busy timeout, forward-only migration. |
| `src/provider.rs` | New static table derived from the upstream account form's provider list (19 services plus custom). 126 is a separate key because it has its own hosts. |
| `src/account.rs` | Reworked from `src-tauri/src/commands/data/accounts/mod.rs`; sqlx queries, folder selection and redacted errors. |
| `src/settings.rs` | Rewritten from the general part of `src-tauri/src/commands/data/settings.rs`; backend and AI settings dropped, bounds validated. |
| `src/transport.rs` | Adapted from `src-tauri/src/mail/transport/mod.rs` and `folders.rs`; OAuth removed, connection and TLS timeouts added, a small modified-UTF-7 decoder replaces the upstream base64 dependency. |
| `src/imap.rs` | Adapted from `src-tauri/src/mail/sync/imap.rs`; UID selection and batching kept, sqlx persistence and the event/error model rewritten. |
| `src/smtp.rs` | Adapted from `src-tauri/src/mail/smtp.rs`; lettre 0.11 API, this crate's errors, `APPEND` via the formatted message. |
| `src/mime.rs` | Adapted from `src-tauri/src/mail/body/{mod,participants,format}.rs`; metadata-only attachments, a header-only entry point for sync, and this crate's types. |
| `src/sync.rs` | Adapted from `src-tauri/src/mail/sync/mod.rs`; Gmail / Graph branches removed, the lock and progress events rewritten, cancellation added. |
| `src/conversation.rs` | Reworked from `src-tauri/src/commands/data/conversations.rs`; sqlx, participant-set keys, reference grouping and the truncation flag. |
| `src/search.rs` | New FTS5 search with the `LIKE` fallback and the local filters. |
| `src/message.rs` | Reworked from `src-tauri/src/commands/data/messages/mod.rs`; lazy `BODY.PEEK[]` fetch, one-transaction persistence and local read state. |
| `src/compose.rs` | Reworked from `src-tauri/src/commands/data/compose.rs`; the outbox state machine, a testable `MailSender` seam, MIME guessing by extension and the send/retry split. |
| `../src/pages/one-mail/**`, `../src/components/one-mail/**`, `../src/hooks/use-one-mail-*.ts`, `../src/lib/one-mail/**`, `../src/commands/services/one-mail/**` | Behaviour port of the upstream UI, rewritten for this app's router, hooks, i18n, component library and editor. No upstream file is byte-identical. |
