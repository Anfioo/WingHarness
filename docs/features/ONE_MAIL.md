# Mail

The **Mail** page (`/one-mail`) is WingHarness's local-first mail client. It
appears in the sidebar under **其他** (Other) and is one workspace: the account
rail on the left, the conversation list in the middle, and the open thread on
the right. Compose, the account form, the raw-message view and the outbox open
as overlays inside the page; no second window is created. Its settings live in
the app's Settings window, under the **Mail** item.

The mail engine is a Rust workspace crate, `src-tauri/one-mail-core`. Protocols
stay inside that crate; the page only talks to the 32 `one_mail_*` commands
wrapped by `src/commands/services/one-mail/`.

> **The data directory contains mailbox passwords in clear text.**
> `<data dir>/one-mail/onemail.db` stores each account's IMAP / SMTP password or
> app password verbatim. Do not copy, back up or sync this directory anywhere
> you would not put the passwords themselves. See [Security](#security).

## Feature overview

| Area | Behaviour |
|------|-----------|
| Accounts | 19 built-in provider presets plus a custom IMAP preset; password / app password only; test the connection, discover folders, choose what to sync; INBOX is always synced. |
| Sync | Runs when the page becomes visible and then once per configured interval, plus a manual **Sync now**; cancellable; only mail headers are pulled, bodies on demand. |
| Conversations | Grouped by account and the non-self participants; received and sent mail share one conversation; topics are split by `References` / `In-Reply-To`, with a normalized-subject fallback. |
| Reading | HTML is sanitized before rendering, remote images are blocked per message, quoted history and signatures fold, attachments are shown as metadata, and the raw message is one click away. |
| Composing | New / reply / reply-all / forward, Markdown body with a live HTML + plain-text result, local attachments, drafts and an outbox with retry. |
| Search and filters | Unread, starred, today, yesterday and last-7-days filters, and a keyword filter over subject, participants and cached body text. |
| Settings | Refresh interval, body display mode, remote-image policy, sync window and new-mail notifications. |
| Notifications | A desktop notification for new mail only while the page is visible and the setting is on. |

## Where the data lives

```
<config::dir()>/one-mail/
├── onemail.db        accounts, folders, messages, bodies, attachments, FTS5, outbox
├── onemail.db-wal
├── onemail.db-shm
└── settings.json     refresh interval, body display, remote images, notifications
```

`onemail.db` is SQLite in WAL mode with foreign keys on and `user_version = 1`.
Migration is forward only: a database written by a newer build is left
untouched rather than downgraded. Deleting an account is one `DELETE`; the
folders, messages, addresses, bodies, attachments and outbox rows cascade, and
the FTS5 rows are removed explicitly because SQLite virtual tables cannot carry
foreign keys.

`settings.json` is written atomically through `settings.json.tmp`. A corrupt or
out-of-range document is renamed to `settings.json.bak-<unix seconds>` and
replaced with the defaults.

Nothing is kept in `localStorage`.

## Accounts and providers

The built-in table has 19 services: Gmail, Yahoo Mail, Outlook, 网易 163,
网易 126, QQ 邮箱, 腾讯企业邮, 阿里云邮箱, 阿里云企业邮, 天翼 189, 搜狐邮箱,
新浪邮箱, 移动 139, 21CN 邮箱, 完美邮箱, iCloud Mail, AOL Mail, Yandex Mail and
Mail.ru. The twentieth entry is **Custom IMAP**, where every host, port and
encryption choice is typed by hand. 126 is a separate preset from 163 because
the two use different hosts (`imap.126.com` versus `imap.163.com`).

This release authenticates with a password or an app-specific password.
Providers that need one (Gmail, Outlook, iCloud, Yahoo, 163 and others) say so
in the account form; OAuth, Gmail API and Microsoft Graph are not implemented.

Creating an account also creates its `INBOX` folder and tries to discover the
server's folders. A failed discovery does not roll the account back: it is kept
with `status = sync_error` and a redacted reason. `INBOX` is always synced and
cannot be switched off; other folders sync only when ticked. Updating an
account leaves the email address and provider read-only, and an empty password
keeps the stored one.

## Sync

Every sync follows one state machine: `connecting → folders → headers → saving
→ done | error`, carried by `one-mail:sync-progress` events. A global mutex
allows one sync at a time; a second start is refused with `busy` and the
current status. The lock only guards the running flag and the cancellation
token, never a network request.

- A **full** scan searches `SINCE <syncWindowDays> days ago` and re-reads what
  is already stored, refreshing flags and headers.
- A **refresh** searches `UID <lastUid + 1>:*` and skips UIDs that are already
  in the database.
- A changed `UIDVALIDITY` for a folder purges that folder's local rows and
  restarts its cursor.
- One run pulls at most 200 messages per folder, in `UID FETCH` batches of 100.
  Summary fetch is `(UID FLAGS INTERNALDATE RFC822.SIZE BODY.PEEK[HEADER])`;
  bodies are never downloaded during sync.
- The first visit to an account without a `lastSyncAt` uses **full**, everything
  after that uses **refresh**. Only refresh announces new mail, so a first scan
  does not fire 200 notifications.
- Cancelling stops between batches; what was already written stays. The last
  finished time and the last error are reported by `one_mail_sync_status`.

There is no IDLE, no background poller and no tray unread count. When the page
is hidden its timer stops, and a sync already running is allowed to finish.

A message delivered by SMTP is written to the outbox with `status = sent`. When
the server's Sent folder is synced later, rows whose `Message-ID` already exists
in the outbox are skipped, so the conversation shows one copy.

## Conversations and threads

A conversation key is `<account id>:<sorted non-self addresses>`. Received mail
contributes `From` / `Sender`; sent mail contributes `To` / `Cc`. Addresses that
equal the account's own address are removed, so a conversation names the other
people only. Messages with the same correspondents share a key whatever order
the headers used. A message whose only other participant is on `Bcc` does not
enter the conversation list at all; it appears in the outbox only. Mail without
any other participant gets a per-message key.

Inside a conversation, messages are grouped into topics. `References` and
`In-Reply-To` are resolved against the `Message-ID` values present in the same
conversation; a message with no references at all joins the unreferenced
messages that share its normalized subject (reply and forward prefixes removed,
case folded, Chinese prefixes included). Groups are ordered oldest first, and a
view loads at most 500 messages; the response sets `truncated` when older ones
were dropped, and the pane says so.

Drafts and trash / junk / drafts folders are excluded from conversations.
Messages are shown oldest first, and the list row's avatar colour is derived
from a stable hash of the account's `colorKey` or the correspondent's address.

## Reading a message

Opening a conversation fetches only summaries. Each message card requests its
body when it scrolls into view (`one_mail_message_body_load`); the backend
fetches the raw message with `BODY.PEEK[]`, parses it, caches the plain text and
HTML, the attachment metadata, the participants and its FTS row in one
transaction, and marks the message read locally. A failed load leaves a retry
button, and the request is allowed to retry.

- **HTML**: every body goes through DOMPurify with `script`, `style`, `link`,
  `meta`, `base`, frames, plugins, forms, form controls, SVG, MathML, audio,
  video and canvas forbidden. Inline styles keep only typographic properties.
  Links are limited to `http:`, `https:` and `mailto:` and open in the system
  browser; the webview never navigates.
- **Remote images**: remote `http(s)` images are replaced with a dashed
  placeholder and counted; **Load remote images** releases that one message.
  The settings can change the default, and the per-message button never writes
  back to settings. `cid:` images are not downloaded and are removed.
- **Plain text**: quoted history and signatures fold behind one **Show quoted
  text** toggle. The settings can render every message as text instead of HTML.
- **Attachments**: name, MIME type and decoded size, from the metadata cache.
  Received attachments are not downloaded and cannot be saved in this version.
- **Raw message**: the stored header block plus the cached body, in a dialog.
- **Star and read** change local state only. This release never writes `\Seen`
  or any other flag back to the server.

## Writing mail

The composer is a Markdown editor (CodeMirror 6) with recipient fields for To,
Cc and Bcc. Addresses are parsed when a field loses focus and rendered as
chips; invalid addresses block sending.

- Sending runs `marked` over the Markdown and sends `multipart/alternative`
  with a styled HTML part and a plain-text part.
- Local files can be attached from the system dialog; the path is read only
  when the message is sent. Forwarding cannot attach the original files because
  received attachments are metadata only; the button is disabled with a note.
- Reply and reply-all prefill the sender / public recipients, `Re: <subject>`,
  the quoted body and the `In-Reply-To` / `References` headers. Forward prefills
  `Fwd: <subject>` and the forwarded block, with no recipients and no threading
  headers.
- Closing a changed composer asks **Save draft / Discard / Cancel**. Discarding
  a draft that was already stored deletes it.
- The outbox lists drafts, queued and sending rows, failures and the last sent
  messages. Drafts reopen in the composer, failed rows can be retried or
  deleted, and sent rows are read-only. A message sent with only Bcc recipients
  appears here and is marked as such.
- A successful SMTP send followed by a failed `APPEND` to the Sent folder still
  records the message as sent and returns a warning; the UI shows "sent, but the
  Sent folder could not be updated".

The send state machine is `draft → sending → sent` or `sending → failed`, with
`failed → sending` on retry. The outbox row is written before the socket opens,
so the result always carries a real id. Sending is refused when the account has
no SMTP configuration or `smtp_enabled = 0`.

## Search and filters

The conversation list filters by account, unread, starred and a received-at
range (today, yesterday, last 7 days). The keyword box matches, within the
current account selection:

- the subject and the snippet,
- the sender name and address and every stored participant,
- the plain-text body of messages whose body has already been loaded.

The body only becomes searchable after a message is opened, because sync does
not fetch bodies. The list pages 50 conversations at a time and loads the next
page when scrolled to the end.

The crate also exposes `one_mail_messages_search` (`MessageSearchPage`): an FTS5
`trigram` query over subject, sender, snippet and body, with a `LIKE` fallback
for keywords shorter than three characters and for queries the tokenizer cannot
parse. It returns one row per message with the matching field and an excerpt.
The current page UI uses the conversation filter rather than this command; the
command is the backend entry point for a future full search view.

## Settings

The Settings window's **Mail** partition edits `settings.json` and saves on
every change; a failed write keeps the previous document and shows a toast.

| Setting | Values | Default |
|---------|--------|---------|
| `refreshIntervalMinutes` | 1–1440 | 5 |
| `bodyDisplayMode` | `html` / `text` | `html` |
| `remoteImagesPolicy` | `block` / `load` | `block` |
| `syncWindowDays` | 1–3650 | 90 |
| `notifyOnNewMail` | on / off | on |

Saving emits `one-mail:settings-changed`; the page updates its copy and
reschedules its sync timer. The partition also prints the `one-mail` data
directory and the clear-text password warning.

Notifications go through `@tauri-apps/plugin-notification`. The backend emits
`one-mail:new-mail` (account label plus the new INBOX messages) only at the end
of a refresh; the page shows the notification only when it is visible and
`notifyOnNewMail` is on, and never puts message content in it.

## Architecture

| Rust module | Responsibility |
|-------------|----------------|
| `lib.rs`, `error.rs`, `models.rs` | exports, `OneMailError { code, message, detail? }`, every DTO |
| `paths.rs`, `store.rs`, `schema.rs` | data directory, SQLite pool, DDL and `user_version` migration |
| `provider.rs`, `account.rs`, `settings.rs` | provider table, account CRUD / folder selection / connection test, `settings.json` |
| `transport.rs`, `imap.rs`, `smtp.rs`, `mime.rs` | IMAP connect / fetch, UID selection and sync, lettre send, mailparse |
| `sync.rs`, `conversation.rs`, `search.rs`, `message.rs`, `compose.rs` | orchestration and events, grouping, FTS5, body loading, drafts / outbox |
| `commands.rs`, `state.rs` | the 32 Tauri commands, the pool and sync state, event emission |

The frontend side is `src/pages/one-mail/`, `src/components/one-mail/`,
`src/hooks/use-one-mail-{page,settings}.ts`, `src/commands/services/one-mail/`
and `src/lib/one-mail/`. The page subscribes to the events; the F components
never call `invoke` directly.

Commands: `one_mail_providers_list`; account and folder commands
(`accounts_list`, `account_create/update/remove/test`, `folders_list`,
`folders_discover`, `folders_set_sync`); conversation and message commands
(`conversations_list`, `conversation_messages`, `message_get`,
`message_body_load`, `message_set_read/starred`, `message_raw`,
`messages_search`); sync (`sync_start/cancel/status`); compose
(`compose_save_draft`, `compose_delete_draft`, `compose_reply_draft`,
`compose_forward_draft`, `compose_send`, `compose_retry`,
`compose_pick_attachments`); outbox (`outbox_list/get/delete`); settings
(`settings_get/set`).

Events: `one-mail:sync-progress`, `one-mail:new-mail`,
`one-mail:mailbox-changed`, `one-mail:accounts-changed`,
`one-mail:outbox-changed`, `one-mail:settings-changed`.

## Security

- **Clear-text passwords.** `accounts.password` is stored verbatim in
  `onemail.db`; the UI masks the field and only shows a placeholder once saved.
  `AccountSummary` never carries the password, transport errors name only the
  host, port and stage, and the stored `last_error` is run through a `***`
  replacement of the password. Do not share or sync the `one-mail` data
  directory.
- **Local-only state.** Read / star flags, folder selection and message copies
  are local. Deleting, moving or marking read on the server is out of scope,
  which also means the server and this app can disagree until the next sync.
- **Untrusted HTML.** Bodies are sanitized on every render, external resources
  are opt-in per message, and links open outside the webview.
- **No OAuth.** Only password / app-password authentication is implemented, so
  there are no refresh tokens to store or leak in this release.

## Limitations

- No OAuth, Gmail API or Microsoft Graph.
- No remote delete, move, flag write-back or `.eml` export.
- Received attachments are metadata only; forwarding cannot re-attach them.
- No background polling, IDLE, tray unread badge or notification click-through.
- Sync pulls at most 200 headers per folder per run and a thread shows at most
  500 messages.
- Body search covers only messages that have already been opened.
- The three panels stay side by side and are resizable; there is no automatic
  narrow-screen collapse yet.
- The provider `notes` / `setupHelpUrl` fields are technical help text and are
  not rendered in the account form, which instead relies on localized hints.

## Upstream

The engine and UI are adapted from [OneMail](https://github.com/zhihui-hu/one-mail)
(AGPL-3.0-only, commit `181ccb6`). WingHarness is AGPL-3.0-only as a whole; each
ported file keeps its attribution header and
[`src-tauri/one-mail-core/UPSTREAM.md`](../../src-tauri/one-mail-core/UPSTREAM.md)
records what was kept, rewritten and dropped.
