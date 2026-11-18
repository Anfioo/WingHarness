// Part of the one-mail module, adapted from OneMail
// (https://github.com/zhihui-hu/one-mail), AGPL-3.0-only.
// See `UPSTREAM.md` in this crate for the porting record.

//! Account CRUD, folder selection and the connection test.
//!
//! Two rules run through this file:
//!
//! * the password only travels inwards. It is written to `accounts.password`
//!   and never read back out — no DTO here carries it, and every error message
//!   and log line names the account and the host only;
//! * the mailbox address is normalized once (`trim().to_lowercase()`) and the
//!   normalized form is what the unique index sees, so `A@x.com` and `a@x.com`
//!   cannot become two accounts.
//!
//! Folder discovery touches the network, so it happens outside the write
//! transaction, and a failed discovery still leaves a usable account behind —
//! with `status = 'sync_error'` and the reason in `last_error` (redacted).

use sqlx::sqlite::SqliteRow;
use sqlx::{Row, SqlitePool};

use crate::error::{OneMailError, OneMailResult};
use crate::models::{
    AccountInput, AccountStatus, AccountSummary, AccountTestInput, AccountUpdateInput, AuthKind,
    ConnectionTestResult, FolderCandidate, FolderDiscoveryInput, FolderRole, MailFolder, Security,
};
use crate::provider;
use crate::state::OneMailState;
use crate::transport;

/// The fixed palette the account rail paints an avatar with. The key is stored
/// with the account so the colour survives a restart and a different sort order.
const COLOR_KEYS: [&str; 8] = [
    "blue", "green", "amber", "rose", "violet", "cyan", "orange", "slate",
];

const INBOX_PATH: &str = "INBOX";

/// Every account, ordered, or the one the filter names. `?1 IS NULL` keeps this
/// a single prepared statement instead of two hand-assembled SQL strings.
const ACCOUNT_SELECT_BY: &str = "
SELECT a.account_id, a.provider_key, a.email, a.display_name, a.account_label,
       a.avatar_text, a.color_key, a.auth_type, a.imap_host, a.imap_port, a.imap_security,
       a.smtp_host, a.smtp_port, a.smtp_security, a.smtp_auth_type, a.smtp_enabled,
       a.sync_enabled, a.status, a.last_sync_at, a.last_error,
       (SELECT COUNT(*) FROM messages m
         WHERE m.account_id = a.account_id AND m.is_draft = 0) AS total_count,
       (SELECT COUNT(*) FROM messages m
         WHERE m.account_id = a.account_id AND m.is_draft = 0 AND m.is_read = 0) AS unread_count,
       (SELECT MAX(m.received_at) FROM messages m
         WHERE m.account_id = a.account_id AND m.is_draft = 0) AS latest_message_at
FROM accounts a
WHERE (?1 IS NULL OR a.account_id = ?1)
ORDER BY a.sort_order, a.account_id";

const FOLDER_SELECT: &str = "
SELECT folder_id, account_id, path, name, role, is_selectable, sync_enabled,
       total_count, unread_count, last_sync_at
FROM folders
WHERE account_id = ?1
ORDER BY sort_order, name";

/// Every account, oldest first inside its sort position.
pub async fn list(pool: &SqlitePool) -> OneMailResult<Vec<AccountSummary>> {
    summaries(pool, None).await
}

/// Create an account, its INBOX row and — when the network allows — the folders
/// the server reports.
pub async fn create(pool: &SqlitePool, input: AccountInput) -> OneMailResult<AccountSummary> {
    let (email, normalized_email) = resolve_email(&input.email)?;
    let preset = provider::find(&input.provider_key).ok_or_else(|| {
        OneMailError::invalid_input(
            "providerKey",
            "The provider is not one of the built-in presets.",
        )
    })?;
    let provider_key = preset.key.clone();
    let imap_host = required_text(&input.imap_host, "imapHost", "The IMAP host is required.")?;
    validate_port("imapPort", input.imap_port)?;
    let password = required_text(
        &input.password,
        "password",
        "A password or authorization code is required.",
    )?;
    let smtp_host = empty_to_none(input.smtp_host.as_deref());
    validate_smtp(
        input.smtp_enabled,
        smtp_host.as_deref(),
        input.smtp_port,
        input.smtp_security,
    )?;
    let account_label = resolve_account_label(
        input.account_label.as_deref(),
        input.display_name.as_deref(),
        &email,
    );
    let avatar_text = resolve_avatar_text(input.display_name.as_deref(), &email);
    let display_name = empty_to_none(input.display_name.as_deref());
    let smtp_auth_type = Some(input.smtp_auth_type.unwrap_or(input.auth_type));

    if account_exists(pool, &normalized_email).await? {
        return Err(OneMailError::invalid_input(
            "email",
            "This mailbox has already been added.",
        ));
    }

    let now = now_iso();
    let mut transaction = pool
        .begin()
        .await
        .map_err(|error| db_error("start the account transaction", error))?;

    let sort_order: i64 =
        sqlx::query_scalar("SELECT COALESCE(MAX(sort_order), -1) + 1 FROM accounts")
            .fetch_one(&mut *transaction)
            .await
            .map_err(|error| db_error("read the account order", error))?;

    let inserted = sqlx::query(
        "INSERT INTO accounts (
           provider_key, email, normalized_email, display_name, account_label, avatar_text,
           color_key, auth_type, imap_host, imap_port, imap_security,
           smtp_host, smtp_port, smtp_security, smtp_auth_type, smtp_enabled,
           password, sync_enabled, status, sort_order, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, '', ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15,
                   ?16, ?17, 'active', ?18, ?19, ?19)",
    )
    .bind(&provider_key)
    .bind(&email)
    .bind(&normalized_email)
    .bind(&display_name)
    .bind(&account_label)
    .bind(&avatar_text)
    .bind(auth_kind_str(input.auth_type))
    .bind(&imap_host)
    .bind(i64::from(input.imap_port))
    .bind(security_str(input.imap_security))
    .bind(&smtp_host)
    .bind(input.smtp_port.map(i64::from))
    .bind(input.smtp_security.map(security_str))
    .bind(smtp_auth_type.map(auth_kind_str))
    .bind(input.smtp_enabled)
    .bind(&password)
    .bind(input.sync_enabled)
    .bind(sort_order)
    .bind(&now)
    .execute(&mut *transaction)
    .await
    .map_err(|error| db_error("save the account", error))?;

    let account_id = inserted.last_insert_rowid();

    // The colour depends on the row id, which only exists after the insert.
    sqlx::query("UPDATE accounts SET color_key = ?1 WHERE account_id = ?2")
        .bind(resolve_color_key(account_id))
        .bind(account_id)
        .execute(&mut *transaction)
        .await
        .map_err(|error| db_error("save the account colour", error))?;

    insert_inbox(&mut transaction, account_id, &now).await?;

    transaction
        .commit()
        .await
        .map_err(|error| db_error("commit the account", error))?;

    // Discovery is a network round trip and must not hold the transaction open.
    // Unit tests never take it: `transport` is B2's and they may not dial out.
    if !cfg!(test) {
        let discovery = FolderDiscoveryInput {
            provider_key,
            email,
            auth_type: input.auth_type,
            imap_host,
            imap_port: input.imap_port,
            imap_security: input.imap_security,
            password,
        };
        discover_and_store(pool, account_id, &discovery).await?;
    }

    get_summary(pool, account_id).await
}

/// Update the fields the caller supplies. `password: None` keeps the stored
/// password; an empty string is rejected rather than saved.
pub async fn update(pool: &SqlitePool, input: AccountUpdateInput) -> OneMailResult<AccountSummary> {
    let current = load_account(pool, input.account_id).await?.ok_or_else(|| {
        OneMailError::not_found(format!(
            "The mail account {} does not exist.",
            input.account_id
        ))
    })?;

    let display_name = match input.display_name.as_deref() {
        Some(value) => empty_to_none(Some(value)),
        None => current.display_name.clone(),
    };
    let account_label = match input.account_label.as_deref() {
        Some(value) => resolve_account_label(Some(value), display_name.as_deref(), &current.email),
        None => current.account_label.clone(),
    };
    let avatar_text = resolve_avatar_text(display_name.as_deref(), &current.email);

    let imap_host = match input.imap_host.as_deref() {
        Some(value) => required_text(value, "imapHost", "The IMAP host is required.")?,
        None => current.imap_host.clone(),
    };
    let imap_port = input.imap_port.unwrap_or(current.imap_port);
    validate_port("imapPort", imap_port)?;
    let imap_security = input.imap_security.unwrap_or(current.imap_security);

    let smtp_enabled = input.smtp_enabled.unwrap_or(current.smtp_enabled);
    let smtp_host = match input.smtp_host.as_deref() {
        Some(value) => empty_to_none(Some(value)),
        None => current.smtp_host.clone(),
    };
    let smtp_port = match input.smtp_port {
        Some(port) => {
            validate_port("smtpPort", port)?;
            Some(port)
        }
        None => current.smtp_port,
    };
    let smtp_security = input.smtp_security.or(current.smtp_security);
    let smtp_auth_type = input.smtp_auth_type.or(current.smtp_auth_type);
    validate_smtp(smtp_enabled, smtp_host.as_deref(), smtp_port, smtp_security)?;

    let sync_enabled = input.sync_enabled.unwrap_or(current.sync_enabled);
    let password = match input.password.as_deref() {
        Some(value) => Some(required_text(
            value,
            "password",
            "A password or authorization code is required.",
        )?),
        None => None,
    };

    let now = now_iso();
    let mut transaction = pool
        .begin()
        .await
        .map_err(|error| db_error("start the account transaction", error))?;

    sqlx::query(
        "UPDATE accounts SET
           display_name = ?2, account_label = ?3, avatar_text = ?4,
           imap_host = ?5, imap_port = ?6, imap_security = ?7,
           smtp_host = ?8, smtp_port = ?9, smtp_security = ?10, smtp_auth_type = ?11,
           smtp_enabled = ?12, sync_enabled = ?13, updated_at = ?14
         WHERE account_id = ?1",
    )
    .bind(input.account_id)
    .bind(&display_name)
    .bind(&account_label)
    .bind(&avatar_text)
    .bind(&imap_host)
    .bind(i64::from(imap_port))
    .bind(security_str(imap_security))
    .bind(&smtp_host)
    .bind(smtp_port.map(i64::from))
    .bind(smtp_security.map(security_str))
    .bind(smtp_auth_type.map(auth_kind_str))
    .bind(smtp_enabled)
    .bind(sync_enabled)
    .bind(&now)
    .execute(&mut *transaction)
    .await
    .map_err(|error| db_error("update the account", error))?;

    if let Some(password) = password {
        sqlx::query("UPDATE accounts SET password = ?1, updated_at = ?2 WHERE account_id = ?3")
            .bind(&password)
            .bind(&now)
            .bind(input.account_id)
            .execute(&mut *transaction)
            .await
            .map_err(|error| db_error("update the account password", error))?;
    }

    transaction
        .commit()
        .await
        .map_err(|error| db_error("commit the account", error))?;

    get_summary(pool, input.account_id).await
}

/// Delete an account and everything under it. Returns whether a row went away.
pub async fn remove(pool: &SqlitePool, account_id: i64) -> OneMailResult<bool> {
    let mut transaction = pool
        .begin()
        .await
        .map_err(|error| db_error("start the account transaction", error))?;

    // The FTS5 table is a virtual table: it cannot carry a foreign key, so its
    // rows are removed before the cascade takes the messages they describe.
    sqlx::query("DELETE FROM message_search WHERE account_id = ?1")
        .bind(account_id)
        .execute(&mut *transaction)
        .await
        .map_err(|error| db_error("delete the account search rows", error))?;

    let deleted = sqlx::query("DELETE FROM accounts WHERE account_id = ?1")
        .bind(account_id)
        .execute(&mut *transaction)
        .await
        .map_err(|error| db_error("delete the account", error))?;

    transaction
        .commit()
        .await
        .map_err(|error| db_error("commit the account deletion", error))?;

    if deleted.rows_affected() > 0 {
        log::info!("one_mail_account_removed account_id={account_id}");
    }
    Ok(deleted.rows_affected() > 0)
}

/// Hand the credentials to the transport. The protocol work — and the mapping of
/// a failure onto `auth-failed` / `network` / `tls` — belongs to B2.
pub async fn test_connection(
    _state: &OneMailState,
    input: AccountTestInput,
) -> OneMailResult<ConnectionTestResult> {
    transport::test_connection(&input).await
}

/// List the folders on the server without storing them; the account form uses
/// this to let the user pick what to sync.
pub async fn discover_folders(
    _state: &OneMailState,
    input: FolderDiscoveryInput,
) -> OneMailResult<Vec<FolderCandidate>> {
    transport::discover_folders(&input).await
}

/// The stored folders of one account, in display order.
pub async fn list_folders(pool: &SqlitePool, account_id: i64) -> OneMailResult<Vec<MailFolder>> {
    if !account_exists_by_id(pool, account_id).await? {
        return Err(OneMailError::not_found(format!(
            "The mail account {account_id} does not exist."
        )));
    }

    let rows = sqlx::query(FOLDER_SELECT)
        .bind(account_id)
        .fetch_all(pool)
        .await
        .map_err(|error| db_error("read the folders", error))?;

    rows.iter().map(map_folder).collect()
}

/// Replace the synced set with `folder_ids`. INBOX is always synced, whether or
/// not the caller listed it, and a folder id from another account is refused
/// instead of silently ignored.
pub async fn set_folder_sync(
    pool: &SqlitePool,
    account_id: i64,
    folder_ids: Vec<i64>,
) -> OneMailResult<Vec<MailFolder>> {
    let known: Vec<i64> = sqlx::query_scalar("SELECT folder_id FROM folders WHERE account_id = ?1")
        .bind(account_id)
        .fetch_all(pool)
        .await
        .map_err(|error| db_error("read the account folders", error))?;

    if known.is_empty() {
        // Either the account is gone or its folders were never discovered; both
        // are a not-found for the caller.
        if !account_exists_by_id(pool, account_id).await? {
            return Err(OneMailError::not_found(format!(
                "The mail account {account_id} does not exist."
            )));
        }
        return Ok(Vec::new());
    }

    if let Some(unknown) = folder_ids.iter().find(|id| !known.contains(*id)) {
        return Err(OneMailError::invalid_input(
            "folderIds",
            format!("The folder {unknown} does not belong to this account."),
        ));
    }

    let now = now_iso();
    let mut transaction = pool
        .begin()
        .await
        .map_err(|error| db_error("start the folder transaction", error))?;

    sqlx::query("UPDATE folders SET sync_enabled = 0, updated_at = ?2 WHERE account_id = ?1")
        .bind(account_id)
        .bind(&now)
        .execute(&mut *transaction)
        .await
        .map_err(|error| db_error("clear the folder selection", error))?;

    for folder_id in &folder_ids {
        sqlx::query(
            "UPDATE folders SET sync_enabled = 1, updated_at = ?1
             WHERE folder_id = ?2 AND account_id = ?3 AND is_selectable = 1",
        )
        .bind(&now)
        .bind(*folder_id)
        .bind(account_id)
        .execute(&mut *transaction)
        .await
        .map_err(|error| db_error("select a folder", error))?;
    }

    sqlx::query(
        "UPDATE folders SET sync_enabled = 1, updated_at = ?1
         WHERE account_id = ?2 AND role = 'inbox'",
    )
    .bind(&now)
    .bind(account_id)
    .execute(&mut *transaction)
    .await
    .map_err(|error| db_error("force the inbox selection", error))?;

    transaction
        .commit()
        .await
        .map_err(|error| db_error("commit the folder selection", error))?;

    list_folders(pool, account_id).await
}

// ---------------------------------------------------------------------------
// Folder discovery
// ---------------------------------------------------------------------------

/// Discover the folders and store them. A transport failure is recorded on the
/// account instead of failing the create: the account is usable, and the next
/// sync can retry.
async fn discover_and_store(
    pool: &SqlitePool,
    account_id: i64,
    input: &FolderDiscoveryInput,
) -> OneMailResult<()> {
    match transport::discover_folders(input).await {
        Ok(candidates) => store_folders(pool, account_id, &candidates).await,
        Err(error) => {
            // The host, the account id and the code only: never the password.
            log::warn!(
                "one_mail_folder_discovery_failed account_id={account_id} host={} code={:?}",
                input.imap_host,
                error.code
            );
            let message = redact_secret(&error.message, &input.password);
            set_status(pool, account_id, AccountStatus::SyncError, Some(&message)).await
        }
    }
}

async fn store_folders(
    pool: &SqlitePool,
    account_id: i64,
    candidates: &[FolderCandidate],
) -> OneMailResult<()> {
    let now = now_iso();
    let mut transaction = pool
        .begin()
        .await
        .map_err(|error| db_error("start the folder transaction", error))?;

    for (index, candidate) in candidates.iter().enumerate() {
        let is_inbox = candidate.path.eq_ignore_ascii_case(INBOX_PATH);
        let selectable = is_inbox || candidate.selectable;
        // A freshly discovered folder starts unsynced unless it is INBOX; the
        // conflict clause keeps a choice the user already made.
        let sync_enabled = is_inbox;
        let sort_order = if is_inbox { 0 } else { index as i64 + 1 };

        sqlx::query(
            "INSERT INTO folders (
               account_id, path, name, delimiter, role, is_selectable, sync_enabled, sort_order,
               created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)
             ON CONFLICT (account_id, path) DO UPDATE SET
               name = excluded.name,
               delimiter = excluded.delimiter,
               role = excluded.role,
               is_selectable = excluded.is_selectable,
               sort_order = excluded.sort_order,
               updated_at = excluded.updated_at",
        )
        .bind(account_id)
        .bind(&candidate.path)
        .bind(&candidate.name)
        .bind(&candidate.delimiter)
        .bind(folder_role_str(candidate.role))
        .bind(selectable)
        .bind(sync_enabled)
        .bind(sort_order)
        .bind(&now)
        .execute(&mut *transaction)
        .await
        .map_err(|error| db_error("save a folder", error))?;
    }

    insert_inbox(&mut transaction, account_id, &now).await?;

    transaction
        .commit()
        .await
        .map_err(|error| db_error("commit the folders", error))
}

async fn set_status(
    pool: &SqlitePool,
    account_id: i64,
    status: AccountStatus,
    last_error: Option<&str>,
) -> OneMailResult<()> {
    sqlx::query(
        "UPDATE accounts SET status = ?2, last_error = ?3, updated_at = ?4 WHERE account_id = ?1",
    )
    .bind(account_id)
    .bind(account_status_str(status))
    .bind(last_error)
    .bind(now_iso())
    .execute(pool)
    .await
    .map_err(|error| db_error("record the account status", error))?;
    Ok(())
}

async fn insert_inbox(
    transaction: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    account_id: i64,
    now: &str,
) -> OneMailResult<()> {
    sqlx::query(
        "INSERT INTO folders (
           account_id, path, name, role, is_selectable, is_subscribed, sync_enabled, sort_order,
           created_at, updated_at
         ) VALUES (?1, ?2, ?2, 'inbox', 1, 1, 1, 0, ?3, ?3)
         ON CONFLICT (account_id, path) DO UPDATE SET
           sync_enabled = 1, updated_at = excluded.updated_at",
    )
    .bind(account_id)
    .bind(INBOX_PATH)
    .bind(now)
    .execute(&mut **transaction)
    .await
    .map_err(|error| db_error("save the inbox folder", error))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

async fn summaries(
    pool: &SqlitePool,
    account_id: Option<i64>,
) -> OneMailResult<Vec<AccountSummary>> {
    let rows = sqlx::query(ACCOUNT_SELECT_BY)
        .bind(account_id)
        .fetch_all(pool)
        .await
        .map_err(|error| db_error("read the accounts", error))?;

    rows.iter().map(map_account_summary).collect()
}

async fn get_summary(pool: &SqlitePool, account_id: i64) -> OneMailResult<AccountSummary> {
    summaries(pool, Some(account_id))
        .await?
        .into_iter()
        .next()
        .ok_or_else(|| {
            OneMailError::not_found(format!("The mail account {account_id} does not exist."))
        })
}

/// The stored columns `update` needs to keep what the caller left out.
struct StoredAccount {
    email: String,
    display_name: Option<String>,
    account_label: String,
    imap_host: String,
    imap_port: u16,
    imap_security: Security,
    smtp_host: Option<String>,
    smtp_port: Option<u16>,
    smtp_security: Option<Security>,
    smtp_auth_type: Option<AuthKind>,
    smtp_enabled: bool,
    sync_enabled: bool,
}

async fn load_account(pool: &SqlitePool, account_id: i64) -> OneMailResult<Option<StoredAccount>> {
    let row = sqlx::query(
        "SELECT email, display_name, account_label, imap_host, imap_port, imap_security,
                smtp_host, smtp_port, smtp_security, smtp_auth_type, smtp_enabled, sync_enabled
         FROM accounts WHERE account_id = ?1",
    )
    .bind(account_id)
    .fetch_optional(pool)
    .await
    .map_err(|error| db_error("read the account", error))?;

    let Some(row) = row else {
        return Ok(None);
    };

    Ok(Some(StoredAccount {
        email: column_text(&row, "email")?,
        display_name: column_optional_text(&row, "display_name")?,
        account_label: column_text(&row, "account_label")?,
        imap_host: column_text(&row, "imap_host")?,
        imap_port: column_port(&row, "imap_port")?,
        imap_security: parse_security(&column_text(&row, "imap_security")?)?,
        smtp_host: column_optional_text(&row, "smtp_host")?,
        smtp_port: column_optional_port(&row, "smtp_port")?,
        smtp_security: match column_optional_text(&row, "smtp_security")? {
            Some(value) => Some(parse_security(&value)?),
            None => None,
        },
        smtp_auth_type: match column_optional_text(&row, "smtp_auth_type")? {
            Some(value) => Some(parse_auth_kind(&value)?),
            None => None,
        },
        smtp_enabled: column_bool(&row, "smtp_enabled")?,
        sync_enabled: column_bool(&row, "sync_enabled")?,
    }))
}

async fn account_exists(pool: &SqlitePool, normalized_email: &str) -> OneMailResult<bool> {
    sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM accounts WHERE normalized_email = ?1)")
        .bind(normalized_email)
        .fetch_one(pool)
        .await
        .map_err(|error| db_error("check the mailbox", error))
}

async fn account_exists_by_id(pool: &SqlitePool, account_id: i64) -> OneMailResult<bool> {
    sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM accounts WHERE account_id = ?1)")
        .bind(account_id)
        .fetch_one(pool)
        .await
        .map_err(|error| db_error("check the account", error))
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

fn map_account_summary(row: &SqliteRow) -> OneMailResult<AccountSummary> {
    Ok(AccountSummary {
        account_id: column_integer(row, "account_id")?,
        provider_key: column_text(row, "provider_key")?,
        email: column_text(row, "email")?,
        display_name: column_optional_text(row, "display_name")?,
        account_label: column_text(row, "account_label")?,
        avatar_text: column_text(row, "avatar_text")?,
        color_key: column_text(row, "color_key")?,
        auth_type: parse_auth_kind(&column_text(row, "auth_type")?)?,
        imap_host: column_text(row, "imap_host")?,
        imap_port: column_port(row, "imap_port")?,
        imap_security: parse_security(&column_text(row, "imap_security")?)?,
        smtp_host: column_optional_text(row, "smtp_host")?,
        smtp_port: column_optional_port(row, "smtp_port")?,
        smtp_security: match column_optional_text(row, "smtp_security")? {
            Some(value) => Some(parse_security(&value)?),
            None => None,
        },
        smtp_auth_type: match column_optional_text(row, "smtp_auth_type")? {
            Some(value) => Some(parse_auth_kind(&value)?),
            None => None,
        },
        smtp_enabled: column_bool(row, "smtp_enabled")?,
        sync_enabled: column_bool(row, "sync_enabled")?,
        status: parse_account_status(&column_text(row, "status")?)?,
        last_sync_at: column_optional_text(row, "last_sync_at")?,
        last_error: column_optional_text(row, "last_error")?,
        total_count: column_integer(row, "total_count")?,
        unread_count: column_integer(row, "unread_count")?,
        latest_message_at: column_optional_text(row, "latest_message_at")?,
    })
}

fn map_folder(row: &SqliteRow) -> OneMailResult<MailFolder> {
    Ok(MailFolder {
        folder_id: column_integer(row, "folder_id")?,
        account_id: column_integer(row, "account_id")?,
        path: column_text(row, "path")?,
        name: column_text(row, "name")?,
        role: parse_folder_role(&column_text(row, "role")?)?,
        selectable: column_bool(row, "is_selectable")?,
        sync_enabled: column_bool(row, "sync_enabled")?,
        total_count: column_integer(row, "total_count")?,
        unread_count: column_integer(row, "unread_count")?,
        last_sync_at: column_optional_text(row, "last_sync_at")?,
    })
}

fn column_text(row: &SqliteRow, column: &str) -> OneMailResult<String> {
    row.try_get::<String, _>(column)
        .map_err(|error| db_error(&format!("read the {column} column"), error))
}

fn column_optional_text(row: &SqliteRow, column: &str) -> OneMailResult<Option<String>> {
    row.try_get::<Option<String>, _>(column)
        .map_err(|error| db_error(&format!("read the {column} column"), error))
}

fn column_integer(row: &SqliteRow, column: &str) -> OneMailResult<i64> {
    row.try_get::<i64, _>(column)
        .map_err(|error| db_error(&format!("read the {column} column"), error))
}

fn column_port(row: &SqliteRow, column: &str) -> OneMailResult<u16> {
    u16::try_from(column_integer(row, column)?).map_err(|_| {
        OneMailError::database(format!("The stored {column} is not a valid port number."))
    })
}

fn column_optional_port(row: &SqliteRow, column: &str) -> OneMailResult<Option<u16>> {
    match column_integer_optional(row, column)? {
        Some(value) => Ok(Some(u16::try_from(value).map_err(|_| {
            OneMailError::database(format!("The stored {column} is not a valid port number."))
        })?)),
        None => Ok(None),
    }
}

fn column_integer_optional(row: &SqliteRow, column: &str) -> OneMailResult<Option<i64>> {
    row.try_get::<Option<i64>, _>(column)
        .map_err(|error| db_error(&format!("read the {column} column"), error))
}

fn column_bool(row: &SqliteRow, column: &str) -> OneMailResult<bool> {
    Ok(column_integer(row, column)? != 0)
}

// ---------------------------------------------------------------------------
// Enum storage
// ---------------------------------------------------------------------------

fn auth_kind_str(value: AuthKind) -> &'static str {
    value.as_str()
}

fn parse_auth_kind(value: &str) -> OneMailResult<AuthKind> {
    AuthKind::parse(value)
        .ok_or_else(|| OneMailError::database(format!("The stored auth type {value} is unknown.")))
}

fn security_str(value: Security) -> &'static str {
    value.as_str()
}

fn parse_security(value: &str) -> OneMailResult<Security> {
    Security::parse(value).ok_or_else(|| {
        OneMailError::database(format!("The stored security mode {value} is unknown."))
    })
}

fn account_status_str(value: AccountStatus) -> &'static str {
    value.as_str()
}

fn parse_account_status(value: &str) -> OneMailResult<AccountStatus> {
    AccountStatus::parse(value).ok_or_else(|| {
        OneMailError::database(format!("The stored account status {value} is unknown."))
    })
}

fn folder_role_str(value: FolderRole) -> &'static str {
    value.as_str()
}

fn parse_folder_role(value: &str) -> OneMailResult<FolderRole> {
    FolderRole::parse(value)
        .ok_or_else(|| OneMailError::database(format!("The stored folder role {value} is unknown.")))
}

// ---------------------------------------------------------------------------
// Field helpers
// ---------------------------------------------------------------------------

fn now_iso() -> String {
    // Fixed width on purpose: these strings are compared and sorted as text.
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// `User.Name@163.COM ` becomes `("User.Name@163.COM", "user.name@163.com")`:
/// the display form keeps the casing the user typed, the unique index sees the
/// lowered form.
fn resolve_email(raw: &str) -> OneMailResult<(String, String)> {
    let email = raw.trim().to_string();
    let normalized = email.to_lowercase();

    let invalid = || {
        OneMailError::invalid_input("email", "The mailbox address is not a valid email address.")
    };

    let (local, domain) = normalized.split_once('@').ok_or_else(invalid)?;
    if local.is_empty()
        || domain.is_empty()
        || domain.contains('@')
        || !domain.contains('.')
        || domain.starts_with('.')
        || domain.ends_with('.')
        || normalized.chars().any(char::is_whitespace)
    {
        return Err(invalid());
    }

    Ok((email, normalized))
}

fn required_text(value: &str, field: &str, message: &str) -> OneMailResult<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(OneMailError::invalid_input(field, message));
    }
    Ok(trimmed.to_string())
}

fn empty_to_none(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn validate_port(field: &str, port: u16) -> OneMailResult<()> {
    if port == 0 {
        return Err(OneMailError::invalid_input(
            field,
            "The port must be between 1 and 65535.",
        ));
    }
    Ok(())
}

/// An enabled SMTP side needs a host, a port and a security mode; a disabled one
/// needs nothing, and the form may still have the preset values in the fields.
fn validate_smtp(
    enabled: bool,
    host: Option<&str>,
    port: Option<u16>,
    security: Option<Security>,
) -> OneMailResult<()> {
    if !enabled {
        return Ok(());
    }
    if host.map_or(true, |host| host.trim().is_empty()) {
        return Err(OneMailError::invalid_input(
            "smtpHost",
            "The SMTP host is required when sending is enabled.",
        ));
    }
    match port {
        Some(port) => validate_port("smtpPort", port)?,
        None => {
            return Err(OneMailError::invalid_input(
                "smtpPort",
                "The SMTP port is required when sending is enabled.",
            ))
        }
    }
    if security.is_none() {
        return Err(OneMailError::invalid_input(
            "smtpSecurity",
            "The SMTP security mode is required when sending is enabled.",
        ));
    }
    Ok(())
}

/// The rail label: the name the user typed, else the display name, else the
/// local part of the address.
fn resolve_account_label(label: Option<&str>, display_name: Option<&str>, email: &str) -> String {
    if let Some(label) = empty_to_none(label) {
        return label;
    }
    if let Some(name) = empty_to_none(display_name) {
        return name;
    }
    email
        .split('@')
        .next()
        .filter(|local| !local.is_empty())
        .unwrap_or(email)
        .to_string()
}

/// The avatar badge: one character, upper case, from the name or the address.
fn resolve_avatar_text(display_name: Option<&str>, email: &str) -> String {
    let source = empty_to_none(display_name).unwrap_or_else(|| email.to_string());
    let first = source
        .chars()
        .find(|character| !character.is_whitespace())
        .unwrap_or('?');
    first.to_uppercase().to_string()
}

fn resolve_color_key(account_id: i64) -> String {
    let index = account_id.rem_euclid(COLOR_KEYS.len() as i64) as usize;
    COLOR_KEYS[index].to_string()
}

/// Keep a transport message usable as `last_error` without ever echoing the
/// password the connection was made with.
fn redact_secret(message: &str, secret: &str) -> String {
    let secret = secret.trim();
    if secret.is_empty() {
        return message.to_string();
    }
    message.replace(secret, "***")
}

fn db_error(step: &str, error: sqlx::Error) -> OneMailError {
    log::warn!("one_mail_account_store_failed step={step} error={error}");
    OneMailError::database("The mail account data could not be read or written.")
}

#[cfg(test)]
mod tests {
    use super::{
        create, list, list_folders, remove, resolve_account_label, resolve_avatar_text,
        set_folder_sync, update,
    };
    use crate::models::{
        AccountInput, AccountStatus, AccountUpdateInput, AuthKind, FolderRole, Security,
    };
    use crate::store;
    use sqlx::SqlitePool;

    async fn test_pool() -> (tempfile::TempDir, SqlitePool) {
        let directory = tempfile::tempdir().unwrap();
        let pool = store::open_at(&directory.path().join("onemail.db"))
            .await
            .unwrap();
        (directory, pool)
    }

    fn input(email: &str) -> AccountInput {
        AccountInput {
            provider_key: "163".to_string(),
            email: email.to_string(),
            display_name: None,
            account_label: None,
            auth_type: AuthKind::AppPassword,
            imap_host: "imap.163.com".to_string(),
            imap_port: 993,
            imap_security: Security::SslTls,
            smtp_enabled: true,
            smtp_host: Some("smtp.163.com".to_string()),
            smtp_port: Some(465),
            smtp_security: Some(Security::SslTls),
            smtp_auth_type: Some(AuthKind::AppPassword),
            password: "authorization-code".to_string(),
            sync_enabled: true,
        }
    }

    fn update_input(account_id: i64) -> AccountUpdateInput {
        AccountUpdateInput {
            account_id,
            display_name: None,
            account_label: None,
            imap_host: None,
            imap_port: None,
            imap_security: None,
            smtp_enabled: None,
            smtp_host: None,
            smtp_port: None,
            smtp_security: None,
            smtp_auth_type: None,
            password: None,
            sync_enabled: None,
        }
    }

    #[test]
    fn builds_a_label_and_a_badge_from_whatever_is_available() {
        assert_eq!(
            resolve_account_label(Some(" Work "), Some("Ann"), "ann@163.com"),
            "Work"
        );
        assert_eq!(
            resolve_account_label(Some("  "), Some("Ann"), "ann@163.com"),
            "Ann"
        );
        assert_eq!(resolve_account_label(None, None, "ann@163.com"), "ann");

        assert_eq!(resolve_avatar_text(Some("ann"), "ann@163.com"), "A");
        assert_eq!(resolve_avatar_text(None, "bob@163.com"), "B");
        assert_eq!(resolve_avatar_text(Some("  "), "bob@163.com"), "B");
    }

    #[tokio::test]
    async fn normalizes_the_mailbox_and_derives_the_rail_badge() {
        let (_directory, pool) = test_pool().await;

        let created = create(&pool, input("  User.Name@163.COM ")).await.unwrap();

        assert_eq!(created.email, "User.Name@163.COM");
        assert_eq!(created.account_label, "User.Name");
        assert_eq!(created.avatar_text, "U");
        assert_eq!(created.color_key, "green");
        assert_eq!(created.status, AccountStatus::Active);

        let normalized: String =
            sqlx::query_scalar("SELECT normalized_email FROM accounts WHERE account_id = ?1")
                .bind(created.account_id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(normalized, "user.name@163.com");
    }

    #[tokio::test]
    async fn stores_the_canonical_provider_key() {
        let (_directory, pool) = test_pool().await;
        let mut account = input("ann@163.com");
        account.provider_key = "netease163".to_string();

        let created = create(&pool, account).await.unwrap();

        assert_eq!(created.provider_key, "163");
    }

    #[tokio::test]
    async fn the_password_lands_in_the_row_and_nowhere_in_the_summary() {
        let (_directory, pool) = test_pool().await;
        let created = create(&pool, input("ann@163.com")).await.unwrap();

        let stored: String =
            sqlx::query_scalar("SELECT password FROM accounts WHERE account_id = ?1")
                .bind(created.account_id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(stored, "authorization-code");

        // `AccountSummary` has no password field at all: the serialized shape the
        // frontend receives must not carry one either.
        let json = serde_json::to_string(&list(&pool).await.unwrap()).unwrap();
        assert!(!json.contains("authorization-code"));
    }

    #[tokio::test]
    async fn rejects_a_zero_port_and_an_empty_password() {
        let (_directory, pool) = test_pool().await;

        let mut zero_port = input("ann@163.com");
        zero_port.imap_port = 0;
        assert_eq!(
            create(&pool, zero_port).await.unwrap_err().code,
            crate::error::OneMailErrorCode::InvalidInput
        );

        let mut empty_password = input("ann@163.com");
        empty_password.password = "   ".to_string();
        assert_eq!(
            create(&pool, empty_password).await.unwrap_err().code,
            crate::error::OneMailErrorCode::InvalidInput
        );

        let mut empty_host = input("ann@163.com");
        empty_host.imap_host = String::new();
        assert_eq!(
            create(&pool, empty_host).await.unwrap_err().code,
            crate::error::OneMailErrorCode::InvalidInput
        );

        let mut bad_email = input("ann.example.com");
        bad_email.email = "ann.example.com".to_string();
        assert_eq!(
            create(&pool, bad_email).await.unwrap_err().code,
            crate::error::OneMailErrorCode::InvalidInput
        );
    }

    #[tokio::test]
    async fn rejects_an_unknown_provider_and_a_duplicate_mailbox() {
        let (_directory, pool) = test_pool().await;

        let mut unknown = input("ann@163.com");
        unknown.provider_key = "not-a-provider".to_string();
        assert_eq!(
            create(&pool, unknown).await.unwrap_err().code,
            crate::error::OneMailErrorCode::InvalidInput
        );

        create(&pool, input("ann@163.com")).await.unwrap();
        // Same mailbox, different casing: the normalized column refuses it.
        assert_eq!(
            create(&pool, input("ANN@163.com")).await.unwrap_err().code,
            crate::error::OneMailErrorCode::InvalidInput
        );
    }

    #[tokio::test]
    async fn creating_an_account_forces_an_inbox_row() {
        let (_directory, pool) = test_pool().await;
        let created = create(&pool, input("ann@163.com")).await.unwrap();

        let folders = list_folders(&pool, created.account_id).await.unwrap();

        assert_eq!(folders.len(), 1);
        assert_eq!(folders[0].path, "INBOX");
        assert_eq!(folders[0].role, FolderRole::Inbox);
        assert!(folders[0].sync_enabled);
    }

    #[tokio::test]
    async fn update_keeps_the_stored_password_when_none_is_given() {
        let (_directory, pool) = test_pool().await;
        let created = create(&pool, input("ann@163.com")).await.unwrap();

        let mut patch = update_input(created.account_id);
        patch.display_name = Some("Ann".to_string());
        let updated = update(&pool, patch).await.unwrap();
        assert_eq!(updated.display_name.as_deref(), Some("Ann"));
        assert_eq!(updated.avatar_text, "A");

        let stored: String =
            sqlx::query_scalar("SELECT password FROM accounts WHERE account_id = ?1")
                .bind(created.account_id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(stored, "authorization-code");

        let mut with_password = update_input(created.account_id);
        with_password.password = Some("second-code".to_string());
        update(&pool, with_password).await.unwrap();
        let stored: String =
            sqlx::query_scalar("SELECT password FROM accounts WHERE account_id = ?1")
                .bind(created.account_id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(stored, "second-code");
    }

    #[tokio::test]
    async fn update_refuses_an_empty_password_and_a_missing_account() {
        let (_directory, pool) = test_pool().await;
        let created = create(&pool, input("ann@163.com")).await.unwrap();

        let mut blank = update_input(created.account_id);
        blank.password = Some(String::new());
        assert_eq!(
            update(&pool, blank).await.unwrap_err().code,
            crate::error::OneMailErrorCode::InvalidInput
        );

        let missing = update_input(9_999);
        assert_eq!(
            update(&pool, missing).await.unwrap_err().code,
            crate::error::OneMailErrorCode::NotFound
        );
    }

    #[tokio::test]
    async fn removing_an_account_takes_its_mail_and_search_rows_with_it() {
        let (_directory, pool) = test_pool().await;
        let created = create(&pool, input("ann@163.com")).await.unwrap();
        let folders = list_folders(&pool, created.account_id).await.unwrap();
        let folder_id = folders[0].folder_id;

        sqlx::query("INSERT INTO messages (message_id, account_id, folder_id, uid, created_at, updated_at) VALUES (1, ?1, ?2, 7, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')")
            .bind(created.account_id)
            .bind(folder_id)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO message_addresses (message_id, kind, email, normalized_email, created_at) VALUES (1, 'from', 'bob@163.com', 'bob@163.com', '2026-01-01T00:00:00.000Z')")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO message_search (message_id, account_id, folder_id, subject) VALUES (1, ?1, ?2, 'hello')")
            .bind(created.account_id)
            .bind(folder_id)
            .execute(&pool)
            .await
            .unwrap();

        assert!(remove(&pool, created.account_id).await.unwrap());
        assert!(!remove(&pool, created.account_id).await.unwrap());

        for table in ["accounts", "folders", "messages", "message_addresses"] {
            let count: i64 =
                sqlx::query_scalar(sqlx::AssertSqlSafe(format!("SELECT COUNT(*) FROM {table}")))
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            assert_eq!(count, 0, "{table} kept a row");
        }
        let search_rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM message_search")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(search_rows, 0, "the FTS index kept a row");
    }

    #[tokio::test]
    async fn folder_selection_keeps_the_inbox_and_rejects_foreign_ids() {
        let (_directory, pool) = test_pool().await;
        let created = create(&pool, input("ann@163.com")).await.unwrap();
        let inbox_id = list_folders(&pool, created.account_id).await.unwrap()[0].folder_id;
        sqlx::query("INSERT INTO folders (folder_id, account_id, path, name, role, is_selectable, created_at, updated_at) VALUES (5, ?1, 'Sent', 'Sent', 'sent', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')")
            .bind(created.account_id)
            .execute(&pool)
            .await
            .unwrap();

        let selected = set_folder_sync(&pool, created.account_id, vec![5])
            .await
            .unwrap();

        let inbox = selected.iter().find(|folder| folder.folder_id == inbox_id);
        assert!(inbox.unwrap().sync_enabled, "INBOX must stay synced");
        let sent = selected.iter().find(|folder| folder.folder_id == 5);
        assert!(sent.unwrap().sync_enabled);

        assert_eq!(
            set_folder_sync(&pool, created.account_id, vec![9_999])
                .await
                .unwrap_err()
                .code,
            crate::error::OneMailErrorCode::InvalidInput
        );
    }
}
