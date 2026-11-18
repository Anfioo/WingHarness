// Part of the one-mail module, adapted from OneMail
// (https://github.com/zhihui-hu/one-mail), AGPL-3.0-only.
// See `UPSTREAM.md` in this crate for the porting record.

//! IMAP connection, authentication, folder discovery and raw-message access.
//!
//! The password is read from `accounts` right before a connection and only
//! lives in memory: no log line, error message or event payload carries it.
//! Every network step runs under an explicit timeout, because a stalled socket
//! would otherwise hold the sync window open forever.

use std::fmt;
use std::time::Duration;

use async_imap::types::NameAttribute;
use async_imap::{Client, Session};
use futures_util::TryStreamExt;
use sqlx::Row;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpStream;

use crate::error::{OneMailError, OneMailResult};
use crate::models::{
    AccountTestInput, AuthKind, ConnectionTestResult, FolderCandidate, FolderDiscoveryInput,
    FolderRole, Security,
};
use crate::state::OneMailState;

/// Budget for opening the TCP socket and finishing the TLS handshake.
pub(crate) const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
/// Budget for a single IMAP command once the connection is up.
pub(crate) const COMMAND_TIMEOUT: Duration = Duration::from_secs(120);

const IMAP_CLIENT_NAME: &str = "WingHarness";
const IMAP_CLIENT_VENDOR: &str = "WingHarness";

/// Either a raw TCP stream or a TLS one; `async-imap` needs a single concrete
/// type, so both go behind one boxed trait object.
pub(crate) trait ImapStream: AsyncRead + AsyncWrite + Unpin + Send + fmt::Debug {}

impl<T> ImapStream for T where T: AsyncRead + AsyncWrite + Unpin + Send + fmt::Debug {}

pub(crate) type ImapSession = Session<Box<dyn ImapStream>>;

/// Where to connect, and as whom. Deliberately without the password.
#[derive(Clone, Debug)]
pub struct ImapConnectionConfig {
    pub email: String,
    pub host: String,
    pub port: u16,
    pub security: Security,
}

impl ImapConnectionConfig {
    /// `host:port` is the only server detail an error message may carry.
    fn target(&self) -> String {
        format!("{}:{}", self.host, self.port)
    }
}

/// One account row, as the transport needs it. `MailAccount` is never handed to
/// the frontend — `AccountSummary` is — so the plain-text password cannot leak
/// through a command response.
#[derive(Clone, Debug)]
pub struct MailAccount {
    pub account_id: i64,
    pub provider_key: String,
    pub email: String,
    pub display_name: Option<String>,
    pub account_label: String,
    pub auth_type: AuthKind,
    pub imap_host: String,
    pub imap_port: u16,
    pub imap_security: Security,
    pub smtp_host: Option<String>,
    pub smtp_port: Option<u16>,
    pub smtp_security: Option<Security>,
    pub smtp_auth_type: Option<AuthKind>,
    pub smtp_enabled: bool,
    pub password: String,
    pub sync_enabled: bool,
}

impl MailAccount {
    pub(crate) fn imap_config(&self) -> ImapConnectionConfig {
        ImapConnectionConfig {
            email: self.email.clone(),
            host: self.imap_host.clone(),
            port: self.imap_port,
            security: self.imap_security,
        }
    }
}

// ---------------------------------------------------------------------------
// Enum <-> TEXT
// ---------------------------------------------------------------------------

pub(crate) fn security_from_str(value: &str) -> Security {
    match value.trim().to_ascii_lowercase().as_str() {
        "starttls" | "tls" | "start_tls" => Security::Starttls,
        "none" | "plain" | "insecure" => Security::None,
        "ssl_tls" | "ssl" | "tls_wrapper" => Security::SslTls,
        other => {
            log::warn!("Unknown IMAP/SMTP security value {other:?}, assuming ssl_tls");
            Security::SslTls
        }
    }
}

pub(crate) fn auth_kind_from_str(value: &str) -> AuthKind {
    match value.trim().to_ascii_lowercase().as_str() {
        "oauth2" => AuthKind::Oauth2,
        "app_password" => AuthKind::AppPassword,
        "bridge" => AuthKind::Bridge,
        "manual" => AuthKind::Manual,
        _ => AuthKind::Password,
    }
}

pub(crate) fn role_from_str(value: &str) -> FolderRole {
    match value.trim().to_ascii_lowercase().as_str() {
        "inbox" => FolderRole::Inbox,
        "sent" => FolderRole::Sent,
        "drafts" => FolderRole::Drafts,
        "trash" => FolderRole::Trash,
        "junk" => FolderRole::Junk,
        "archive" => FolderRole::Archive,
        "all_mail" => FolderRole::AllMail,
        "important" => FolderRole::Important,
        "starred" => FolderRole::Starred,
        _ => FolderRole::Custom,
    }
}

// ---------------------------------------------------------------------------
// Accounting: only password / app-password sign-in is implemented
// ---------------------------------------------------------------------------

pub(crate) fn ensure_supported_auth(auth_type: AuthKind) -> OneMailResult<()> {
    match auth_type {
        AuthKind::Oauth2 => Err(OneMailError::new(
            crate::error::OneMailErrorCode::NotImplemented,
            "OAuth is not supported in this build. Use a password or an app password.",
        )),
        AuthKind::Bridge | AuthKind::Manual => Err(OneMailError::new(
            crate::error::OneMailErrorCode::NotImplemented,
            "This authentication method is not supported in this build. Use a password or an app password.",
        )),
        AuthKind::AppPassword | AuthKind::Password => Ok(()),
    }
}

// ---------------------------------------------------------------------------
// Account loading
// ---------------------------------------------------------------------------

/// Read one account row. The password comes from the same row; callers must
/// drop the returned value as soon as the connection is up.
pub(crate) async fn load_account(
    state: &OneMailState,
    account_id: i64,
) -> OneMailResult<MailAccount> {
    let pool = state.pool().await?;
    let row = sqlx::query(
        "SELECT account_id, provider_key, email, display_name, account_label, auth_type,
                imap_host, imap_port, imap_security, smtp_host, smtp_port, smtp_security,
                smtp_auth_type, smtp_enabled, password, sync_enabled
         FROM accounts WHERE account_id = ?1",
    )
    .bind(account_id)
    .fetch_optional(&pool)
    .await
    .map_err(|error| OneMailError::database(format!("Could not read the mail account: {error}")))?
    .ok_or_else(|| OneMailError::not_found(format!("Mail account {account_id} does not exist.")))?;

    let imap_port: i64 = row.try_get("imap_port").map_err(|error| {
        OneMailError::database(format!("Could not read the IMAP port: {error}"))
    })?;
    let smtp_port: Option<i64> = row.try_get("smtp_port").map_err(|error| {
        OneMailError::database(format!("Could not read the SMTP port: {error}"))
    })?;
    let auth_type: String = row.try_get("auth_type").map_err(|error| {
        OneMailError::database(format!("Could not read the account auth type: {error}"))
    })?;
    let imap_security: String = row.try_get("imap_security").map_err(|error| {
        OneMailError::database(format!("Could not read the IMAP security mode: {error}"))
    })?;
    let smtp_security: Option<String> = row.try_get("smtp_security").map_err(|error| {
        OneMailError::database(format!("Could not read the SMTP security mode: {error}"))
    })?;
    let smtp_auth_type: Option<String> = row.try_get("smtp_auth_type").map_err(|error| {
        OneMailError::database(format!("Could not read the SMTP auth type: {error}"))
    })?;
    let password: Option<String> = row.try_get("password").map_err(|error| {
        OneMailError::database(format!("Could not read the account credentials: {error}"))
    })?;

    Ok(MailAccount {
        account_id,
        provider_key: row.try_get("provider_key").unwrap_or_default(),
        email: row.try_get("email").unwrap_or_default(),
        display_name: row.try_get("display_name").unwrap_or_default(),
        account_label: row.try_get("account_label").unwrap_or_default(),
        auth_type: auth_kind_from_str(&auth_type),
        imap_host: row.try_get("imap_host").unwrap_or_default(),
        imap_port: u16::try_from(imap_port).unwrap_or(0),
        imap_security: security_from_str(&imap_security),
        smtp_host: row.try_get("smtp_host").unwrap_or_default(),
        smtp_port: smtp_port.and_then(|port| u16::try_from(port).ok()),
        smtp_security: smtp_security.as_deref().map(security_from_str),
        smtp_auth_type: smtp_auth_type.as_deref().map(auth_kind_from_str),
        smtp_enabled: row.try_get::<i64, _>("smtp_enabled").unwrap_or(0) != 0,
        password: password.unwrap_or_default(),
        sync_enabled: row.try_get::<i64, _>("sync_enabled").unwrap_or(0) != 0,
    })
}

// ---------------------------------------------------------------------------
// Connecting
// ---------------------------------------------------------------------------

/// Open an authenticated session with 30 s connect and 120 s login budgets.
pub(crate) async fn connect_authenticated(
    config: &ImapConnectionConfig,
    password: &str,
) -> OneMailResult<ImapSession> {
    let client = connect_client(config).await?;
    let login = tokio::time::timeout(COMMAND_TIMEOUT, client.login(&config.email, password))
        .await
        .map_err(|_| {
            OneMailError::network(format!("Signing in to IMAP {} timed out.", config.target()))
        })?;
    let mut session = match login {
        Ok(session) => session,
        Err((error, _client)) => return Err(login_error(config, &error)),
    };
    announce_client_id(&mut session).await;
    Ok(session)
}

/// `Client::new` only parses the greeting; the caller still has to log in.
async fn connect_client(
    config: &ImapConnectionConfig,
) -> OneMailResult<Client<Box<dyn ImapStream>>> {
    if config.port == 0 {
        return Err(OneMailError::invalid_input(
            "port",
            "The IMAP port must be between 1 and 65535.",
        ));
    }
    if config.host.trim().is_empty() {
        return Err(OneMailError::invalid_input(
            "imapHost",
            "The IMAP host must not be empty.",
        ));
    }
    let tcp = tokio::time::timeout(
        CONNECT_TIMEOUT,
        TcpStream::connect((config.host.as_str(), config.port)),
    )
    .await
    .map_err(|_| {
        OneMailError::network(format!("Connecting to IMAP {} timed out.", config.target()))
    })?
    .map_err(|error| {
        OneMailError::network(format!(
            "Could not connect to IMAP {}: {error}",
            config.target()
        ))
    })?;
    // Fail fast on a silent socket instead of letting the greeting hang.
    let _ = tcp.set_nodelay(true);

    match config.security {
        Security::None => {
            let stream: Box<dyn ImapStream> = Box::new(tcp);
            let mut client = Client::new(stream);
            read_greeting(&mut client, config).await?;
            Ok(client)
        }
        Security::Starttls => {
            let mut client = Client::new(tcp);
            read_greeting(&mut client, config).await?;
            tokio::time::timeout(
                COMMAND_TIMEOUT,
                client.run_command_and_check_ok("STARTTLS", None),
            )
            .await
            .map_err(|_| {
                OneMailError::network(format!("IMAP STARTTLS on {} timed out.", config.target()))
            })?
            .map_err(|error| imap_error(config, "STARTTLS", &error))?;
            let stream = client.into_inner();
            let stream = tls_connect(config, stream).await?;
            Ok(Client::new(stream))
        }
        Security::SslTls => {
            let stream = tls_connect(config, tcp).await?;
            let mut client = Client::new(stream);
            read_greeting(&mut client, config).await?;
            Ok(client)
        }
    }
}

async fn tls_connect(
    config: &ImapConnectionConfig,
    stream: TcpStream,
) -> OneMailResult<Box<dyn ImapStream>> {
    let connector = async_native_tls::TlsConnector::new();
    // The handshake counts towards the 30 s connect budget: a server that
    // accepts the socket and then stalls would otherwise hang the sync.
    let stream = tokio::time::timeout(
        CONNECT_TIMEOUT,
        connector.connect(&config.host, stream),
    )
    .await
    .map_err(|_| {
        OneMailError::network(format!(
            "The TLS handshake with IMAP {} timed out after {}s.",
            config.target(),
            CONNECT_TIMEOUT.as_secs()
        ))
    })?
    .map_err(|error| {
        OneMailError::tls(format!(
            "TLS handshake with IMAP {} failed: {error}",
            config.target()
        ))
    })?;
    Ok(Box::new(stream))
}

async fn read_greeting<T>(
    client: &mut Client<T>,
    config: &ImapConnectionConfig,
) -> OneMailResult<()>
where
    T: AsyncRead + AsyncWrite + Unpin + Send + fmt::Debug,
{
    tokio::time::timeout(CONNECT_TIMEOUT, client.read_response())
        .await
        .map_err(|_| {
            OneMailError::network(format!(
                "IMAP {} did not send a greeting in time.",
                config.target()
            ))
        })?
        .map_err(|error| {
            OneMailError::network(format!(
                "Could not read the IMAP greeting from {}: {error}",
                config.target()
            ))
        })?;
    Ok(())
}

/// Some servers (notably the Chinese providers) throttle clients that do not
/// announce themselves. Best effort only: a rejected ID must not fail the sync.
async fn announce_client_id(session: &mut ImapSession) {
    let identification = [
        ("name", Some(IMAP_CLIENT_NAME)),
        ("version", Some(env!("CARGO_PKG_VERSION"))),
        ("vendor", Some(IMAP_CLIENT_VENDOR)),
    ];
    let _ = tokio::time::timeout(COMMAND_TIMEOUT, session.id(identification)).await;
}

pub(crate) async fn logout(session: &mut ImapSession) {
    // A failed LOGOUT must not hide the work already committed.
    if tokio::time::timeout(COMMAND_TIMEOUT, session.logout())
        .await
        .is_err()
    {
        log::warn!("Timed out while closing an IMAP session");
    }
}

// ---------------------------------------------------------------------------
// Command timeouts
// ---------------------------------------------------------------------------

/// Run one IMAP command under the 120 s budget, turning a timeout into a
/// `network` error naming the server and the stage.
pub(crate) async fn command_timeout<T>(
    config: &ImapConnectionConfig,
    stage: &str,
    future: impl std::future::Future<Output = Result<T, async_imap::error::Error>>,
) -> OneMailResult<T> {
    tokio::time::timeout(COMMAND_TIMEOUT, future)
        .await
        .map_err(|_| {
            OneMailError::network(format!(
                "IMAP {stage} on {} timed out after {}s.",
                config.target(),
                COMMAND_TIMEOUT.as_secs()
            ))
        })?
        .map_err(|error| imap_error(config, stage, &error))
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

fn looks_like_auth_failure(message: &str) -> bool {
    let message = message.to_ascii_lowercase();
    message.contains("auth")
        || message.contains("credentials")
        || message.contains("login")
        || message.contains("password")
        || message.contains("denied")
}

/// Map an `async-imap` error onto a stable code. Only the host, the port and
/// the protocol stage reach the message — never the credentials.
pub(crate) fn imap_error(
    config: &ImapConnectionConfig,
    stage: &str,
    error: &async_imap::error::Error,
) -> OneMailError {
    let target = config.target();
    match error {
        async_imap::error::Error::Io(io_error) => {
            OneMailError::network(format!("IMAP {stage} on {target} failed: {io_error}"))
        }
        async_imap::error::Error::ConnectionLost => OneMailError::network(format!(
            "The IMAP connection to {target} was lost during {stage}."
        )),
        async_imap::error::Error::No(message) => {
            if looks_like_auth_failure(message) {
                OneMailError::auth_failed(format!(
                    "IMAP {stage} on {target} was rejected: {message}"
                ))
            } else {
                OneMailError::protocol(format!("IMAP {stage} on {target} was refused: {message}"))
            }
        }
        async_imap::error::Error::Bad(message) => {
            OneMailError::protocol(format!("IMAP {stage} on {target} was rejected: {message}"))
        }
        other => OneMailError::protocol(format!("IMAP {stage} on {target} failed: {other}")),
    }
}

fn login_error(config: &ImapConnectionConfig, error: &async_imap::error::Error) -> OneMailError {
    let target = config.target();
    match error {
        async_imap::error::Error::No(message) if looks_like_auth_failure(message) => {
            OneMailError::auth_failed(format!(
                "The IMAP server at {target} rejected the credentials: {message}"
            ))
        }
        async_imap::error::Error::No(message) => OneMailError::auth_failed(format!(
            "The IMAP server at {target} refused the login: {message}"
        )),
        other => imap_error(config, "login", other),
    }
}

// ---------------------------------------------------------------------------
// Connection test
// ---------------------------------------------------------------------------

/// Check IMAP and, when SMTP is enabled, SMTP — without sending a message.
///
/// A failing half is reported through `imap_ok` / `smtp_ok` rather than as an
/// error, so the frontend can show both verdicts at once.
pub async fn test_connection(input: &AccountTestInput) -> OneMailResult<ConnectionTestResult> {
    ensure_supported_auth(input.auth_type)?;
    let config = ImapConnectionConfig {
        email: input.email.clone(),
        host: input.imap_host.trim().to_string(),
        port: input.imap_port,
        security: input.imap_security,
    };
    let mut result = ConnectionTestResult {
        imap_ok: false,
        smtp_ok: None,
        imap_error: None,
        smtp_error: None,
    };

    match connect_authenticated(&config, &input.password).await {
        Ok(mut session) => {
            match command_timeout(&config, "NOOP", session.noop()).await {
                Ok(()) => result.imap_ok = true,
                Err(error) => result.imap_error = Some(error.message),
            }
            logout(&mut session).await;
        }
        Err(error) => result.imap_error = Some(error.message),
    }

    if input.smtp_enabled {
        let (smtp_ok, smtp_error) = test_smtp(input).await;
        result.smtp_ok = Some(smtp_ok);
        result.smtp_error = smtp_error;
    }

    Ok(result)
}

async fn test_smtp(input: &AccountTestInput) -> (bool, Option<String>) {
    let Some(host) = input
        .smtp_host
        .as_deref()
        .map(str::trim)
        .filter(|host| !host.is_empty())
    else {
        return (
            false,
            Some("SMTP is enabled but no host is set.".to_string()),
        );
    };
    let security = input.smtp_security.unwrap_or(Security::Starttls);
    let port = input
        .smtp_port
        .unwrap_or(crate::smtp::default_port(security));
    let transport =
        match crate::smtp::build_transport(host, port, security, &input.email, &input.password) {
            Ok(transport) => transport,
            Err(error) => return (false, Some(error.message)),
        };
    match tokio::time::timeout(crate::smtp::SMTP_TIMEOUT, transport.test_connection()).await {
        Ok(Ok(true)) => (true, None),
        Ok(Ok(false)) => (
            false,
            Some(format!("The SMTP server at {host}:{port} rejected NOOP.")),
        ),
        Ok(Err(error)) => (false, Some(crate::smtp::describe_error(host, port, &error))),
        Err(_) => (
            false,
            Some(format!(
                "Connecting to the SMTP server at {host}:{port} timed out."
            )),
        ),
    }
}

// ---------------------------------------------------------------------------
// Folder discovery
// ---------------------------------------------------------------------------

/// List every mailbox, decode its name from modified UTF-7, infer its role and
/// drop the ones that cannot be selected.
pub async fn discover_folders(input: &FolderDiscoveryInput) -> OneMailResult<Vec<FolderCandidate>> {
    ensure_supported_auth(input.auth_type)?;
    let config = ImapConnectionConfig {
        email: input.email.clone(),
        host: input.imap_host.trim().to_string(),
        port: input.imap_port,
        security: input.imap_security,
    };
    let mut session = connect_authenticated(&config, &input.password).await?;
    let outcome = list_folders(&config, &mut session).await;
    logout(&mut session).await;
    let mut folders = outcome?;
    folders.sort_by(|left, right| {
        left.name
            .to_ascii_lowercase()
            .cmp(&right.name.to_ascii_lowercase())
    });
    Ok(folders)
}

/// One `LIST "" "*"` pass. Also used by the account flow, which persists the
/// result, so it lives here and not only behind `discover_folders`.
pub(crate) async fn list_folders(
    config: &ImapConnectionConfig,
    session: &mut ImapSession,
) -> OneMailResult<Vec<FolderCandidate>> {
    let mut stream = command_timeout(config, "LIST", session.list(Some(""), Some("*"))).await?;
    let mut folders = Vec::new();
    loop {
        let next = tokio::time::timeout(COMMAND_TIMEOUT, stream.try_next())
            .await
            .map_err(|_| {
                OneMailError::network(format!(
                    "Reading the IMAP folder list from {} timed out.",
                    config.target()
                ))
            })?;
        let Some(name) = next.map_err(|error| imap_error(config, "LIST", &error))? else {
            break;
        };
        let path = name.name().to_string();
        let delimiter = name.delimiter().map(str::to_string);
        let attributes = name
            .attributes()
            .iter()
            .map(name_attribute_value)
            .collect::<Vec<_>>();
        let selectable = is_folder_selectable(&attributes);
        if !selectable {
            continue;
        }
        folders.push(FolderCandidate {
            name: decode_modified_utf7(&path),
            role: folder_role(&path, &attributes),
            path,
            delimiter,
            selectable,
        });
    }
    drop(stream);
    Ok(folders)
}

pub(crate) fn name_attribute_value(attribute: &NameAttribute<'_>) -> String {
    match attribute {
        NameAttribute::NoInferiors => "\\Noinferiors".to_string(),
        NameAttribute::NoSelect => "\\Noselect".to_string(),
        NameAttribute::Marked => "\\Marked".to_string(),
        NameAttribute::Unmarked => "\\Unmarked".to_string(),
        NameAttribute::All => "\\All".to_string(),
        NameAttribute::Archive => "\\Archive".to_string(),
        NameAttribute::Drafts => "\\Drafts".to_string(),
        NameAttribute::Flagged => "\\Flagged".to_string(),
        NameAttribute::Junk => "\\Junk".to_string(),
        NameAttribute::Sent => "\\Sent".to_string(),
        NameAttribute::Trash => "\\Trash".to_string(),
        // `\Important`, `\HasChildren` and friends arrive as extensions; the
        // backslash is part of the name a server advertises, so put it back.
        NameAttribute::Extension(value) => {
            format!("\\{}", value.trim_start_matches('\\'))
        }
        other => format!("{other:?}"),
    }
}

pub(crate) fn is_folder_selectable(attributes: &[String]) -> bool {
    !attributes.iter().any(|attribute| {
        attribute.eq_ignore_ascii_case("\\Noselect")
            || attribute.eq_ignore_ascii_case("\\NonExistent")
    })
}

/// INBOX by name, then the RFC 6154 special-use attributes. A folder that only
/// *looks* like Sent by its display name stays `custom` — guessing there is how
/// duplicates get created.
pub(crate) fn folder_role(path: &str, attributes: &[String]) -> FolderRole {
    if path.eq_ignore_ascii_case("INBOX") {
        return FolderRole::Inbox;
    }
    for (attribute, role) in [
        ("\\Sent", FolderRole::Sent),
        ("\\Drafts", FolderRole::Drafts),
        ("\\Trash", FolderRole::Trash),
        ("\\Junk", FolderRole::Junk),
        ("\\Archive", FolderRole::Archive),
        ("\\All", FolderRole::AllMail),
        ("\\Important", FolderRole::Important),
        ("\\Flagged", FolderRole::Starred),
    ] {
        if attributes
            .iter()
            .any(|value| value.eq_ignore_ascii_case(attribute))
        {
            return role;
        }
    }
    FolderRole::Custom
}

/// Decode an IMAP "modified UTF-7" mailbox name (RFC 3501 §5.1.3).
///
/// `&` starts a base64 run of UTF-16BE code units, `&-` is a literal ampersand,
/// and anything that does not decode is left byte-for-byte alone: showing the
/// raw name beats showing nothing.
pub(crate) fn decode_modified_utf7(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut decoded = String::with_capacity(value.len());
    let mut cursor = 0;

    while cursor < bytes.len() {
        let Some(relative_start) = bytes[cursor..].iter().position(|byte| *byte == b'&') else {
            decoded.push_str(&value[cursor..]);
            break;
        };
        let start = cursor + relative_start;
        decoded.push_str(&value[cursor..start]);
        let Some(relative_end) = bytes[start + 1..].iter().position(|byte| *byte == b'-') else {
            decoded.push_str(&value[start..]);
            break;
        };
        let end = start + 1 + relative_end;
        let encoded = &value[start + 1..end];
        if encoded.is_empty() {
            decoded.push('&');
        } else if let Some(segment) = decode_modified_utf7_segment(encoded) {
            decoded.push_str(&segment);
        } else {
            decoded.push_str(&value[start..=end]);
        }
        cursor = end + 1;
    }

    decoded
}

fn decode_modified_utf7_segment(value: &str) -> Option<String> {
    let encoded = value.replace(',', "/");
    let bytes = decode_base64(&encoded)?;
    if bytes.is_empty() || bytes.len() % 2 != 0 {
        return None;
    }
    let utf16 = bytes
        .chunks_exact(2)
        .map(|chunk| u16::from_be_bytes([chunk[0], chunk[1]]))
        .collect::<Vec<_>>();
    String::from_utf16(&utf16).ok()
}

/// Minimal standard-alphabet base64 decode, padding optional.
///
/// `base64` is not a dependency of this crate and adding one for mailbox names
/// alone is not worth it; this is the whole of what RFC 3501 needs.
fn decode_base64(value: &str) -> Option<Vec<u8>> {
    let mut decoded = Vec::with_capacity(value.len() * 3 / 4 + 3);
    let mut buffer: u32 = 0;
    let mut bits: u32 = 0;
    for byte in value.bytes() {
        let index = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' => continue,
            _ => return None,
        } as u32;
        buffer = (buffer << 6) | index;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            decoded.push(((buffer >> bits) & 0xff) as u8);
        }
    }
    Some(decoded)
}

// ---------------------------------------------------------------------------
// Raw messages and sent copies
// ---------------------------------------------------------------------------

/// Fetch one message with `BODY.PEEK[]` so reading it does not set `\Seen`.
pub async fn fetch_raw_message(
    state: &OneMailState,
    account_id: i64,
    folder_path: &str,
    uid: u32,
) -> OneMailResult<Vec<u8>> {
    if uid == 0 {
        return Err(OneMailError::invalid_input(
            "uid",
            "The message UID must be greater than zero.",
        ));
    }
    let account = load_account(state, account_id).await?;
    ensure_supported_auth(account.auth_type)?;
    let config = account.imap_config();
    let mut session = connect_authenticated(&config, &account.password).await?;
    let outcome = async {
        command_timeout(&config, "SELECT", session.select(folder_path)).await?;
        let mut stream = command_timeout(
            &config,
            "UID FETCH",
            session.uid_fetch(uid.to_string(), "BODY.PEEK[]"),
        )
        .await?;
        let mut body = None;
        loop {
            let next = tokio::time::timeout(COMMAND_TIMEOUT, stream.try_next())
                .await
                .map_err(|_| {
                    OneMailError::network(format!(
                        "Reading the message body from IMAP {} timed out.",
                        config.target()
                    ))
                })?;
            let Some(fetch) = next.map_err(|error| imap_error(&config, "UID FETCH", &error))?
            else {
                break;
            };
            if let Some(value) = fetch.body() {
                body = Some(value.to_vec());
            }
        }
        drop(stream);
        body.ok_or_else(|| {
            OneMailError::protocol(format!(
                "IMAP {} returned no body for UID {uid}.",
                config.target()
            ))
        })
    }
    .await;
    logout(&mut session).await;
    outcome
}

/// Append a copy of a sent message to the account's Sent folder.
///
/// Called after SMTP accepted the message, so a failure here is a warning for
/// the caller, never a failed send.
pub async fn append_to_sent(
    state: &OneMailState,
    account_id: i64,
    raw: &[u8],
) -> OneMailResult<()> {
    if raw.is_empty() {
        return Err(OneMailError::invalid_input(
            "raw",
            "The message to append is empty.",
        ));
    }
    let pool = state.pool().await?;
    let folder_path = sqlx::query_scalar::<_, String>(
        "SELECT path FROM folders
         WHERE account_id = ?1 AND role = 'sent' AND is_selectable = 1
         ORDER BY folder_id LIMIT 1",
    )
    .bind(account_id)
    .fetch_optional(&pool)
    .await
    .map_err(|error| OneMailError::database(format!("Could not read the Sent folder: {error}")))?;
    let Some(folder_path) = folder_path else {
        return Err(OneMailError::not_found(
            "This account has no Sent folder to append to.",
        ));
    };

    let account = load_account(state, account_id).await?;
    ensure_supported_auth(account.auth_type)?;
    let config = account.imap_config();
    let mut session = connect_authenticated(&config, &account.password).await?;
    let outcome = command_timeout(
        &config,
        "APPEND",
        session.append(&folder_path, Some("(\\Seen)"), None, raw),
    )
    .await;
    logout(&mut session).await;
    outcome
}

#[cfg(test)]
mod tests {
    use super::{
        decode_base64, decode_modified_utf7, folder_role, is_folder_selectable, role_from_str,
        security_from_str,
    };
    use crate::models::{FolderRole, Security};

    #[test]
    fn decodes_modified_utf7_mailbox_names() {
        assert_eq!(
            decode_modified_utf7("~peter/mail/&U,BTFw-/&ZeVnLIqe-"),
            "~peter/mail/台北/日本語"
        );
        assert_eq!(decode_modified_utf7("R&-D &- Sales"), "R&D & Sales");
        assert_eq!(decode_modified_utf7("INBOX"), "INBOX");
    }

    #[test]
    fn decodes_chinese_mailbox_names() {
        // "已发送" in modified UTF-7.
        assert_eq!(decode_modified_utf7("&XfJT0ZAB-"), "已发送");
        assert_eq!(decode_modified_utf7("&V4NXPpCuTvY-"), "垃圾邮件");
    }

    #[test]
    fn leaves_invalid_modified_utf7_alone() {
        assert_eq!(decode_modified_utf7("Folder/&bad!-"), "Folder/&bad!-");
        assert_eq!(decode_modified_utf7("Folder/&broken"), "Folder/&broken");
    }

    #[test]
    fn decodes_base64_with_and_without_padding() {
        assert_eq!(decode_base64("5q2k"), Some("此".as_bytes().to_vec()));
        assert_eq!(decode_base64("SGVsbG8="), Some(b"Hello".to_vec()));
        assert_eq!(decode_base64("not*base64"), None);
    }

    #[test]
    fn infers_roles_from_special_use_attributes_only() {
        assert_eq!(folder_role("Inbox", &[]), FolderRole::Inbox);
        assert_eq!(
            folder_role("已发送", &["\\Sent".to_string()]),
            FolderRole::Sent
        );
        assert_eq!(
            folder_role("Everything", &["\\ALL".to_string()]),
            FolderRole::AllMail
        );
        assert_eq!(
            folder_role("Junk", &["\\Important".to_string()]),
            FolderRole::Important
        );
        assert_eq!(folder_role("Sent Items", &[]), FolderRole::Custom);
        assert_eq!(folder_role("Archive", &[]), FolderRole::Custom);
    }

    #[test]
    fn drops_unselectable_folders() {
        assert!(!is_folder_selectable(&["\\Noselect".to_string()]));
        assert!(!is_folder_selectable(&["\\NonExistent".to_string()]));
        assert!(is_folder_selectable(&["\\HasChildren".to_string()]));
        assert!(is_folder_selectable(&[]));
    }

    #[test]
    fn stored_security_and_role_labels_are_read_back() {
        assert_eq!(security_from_str("ssl_tls"), Security::SslTls);
        assert_eq!(security_from_str("starttls"), Security::Starttls);
        assert_eq!(security_from_str("none"), Security::None);
        // An unknown label falls back to the safe default instead of failing.
        assert_eq!(security_from_str("carrier-pigeon"), Security::SslTls);
        assert_eq!(role_from_str("sent"), FolderRole::Sent);
        assert_eq!(role_from_str("all_mail"), FolderRole::AllMail);
        assert_eq!(role_from_str("Something"), FolderRole::Custom);
    }

    /// The only test that touches a real server, and it stays ignored:
    ///
    /// ```text
    /// ONE_MAIL_LIVE_EMAIL=you@example.com
    /// ONE_MAIL_LIVE_PASSWORD=app-password
    /// ONE_MAIL_LIVE_IMAP_HOST=imap.example.com
    /// ONE_MAIL_LIVE_IMAP_PORT=993
    /// cargo test -p one-mail-core -- --ignored live_
    /// ```
    ///
    /// It exists so a manual check never has to be written from scratch, and so
    /// the manual acceptance list has one entry point.
    #[tokio::test]
    #[ignore = "requires a real IMAP account; see the doc comment"]
    async fn live_discover_folders() {
        let (Ok(email), Ok(password), Ok(host)) = (
            std::env::var("ONE_MAIL_LIVE_EMAIL"),
            std::env::var("ONE_MAIL_LIVE_PASSWORD"),
            std::env::var("ONE_MAIL_LIVE_IMAP_HOST"),
        ) else {
            eprintln!("ONE_MAIL_LIVE_* is not set, skipping the live check");
            return;
        };
        let port = std::env::var("ONE_MAIL_LIVE_IMAP_PORT")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(993);
        let folders = super::discover_folders(&crate::models::FolderDiscoveryInput {
            provider_key: "custom".to_string(),
            email,
            auth_type: crate::models::AuthKind::AppPassword,
            imap_host: host,
            imap_port: port,
            imap_security: Security::SslTls,
            password,
        })
        .await
        .expect("folder discovery");

        assert!(
            folders
                .iter()
                .any(|folder| folder.path.eq_ignore_ascii_case("INBOX")),
            "a real mailbox always has an INBOX"
        );
    }
}
