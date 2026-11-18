// Part of the one-mail module, adapted from OneMail
// (https://github.com/zhihui-hu/one-mail), AGPL-3.0-only.
// See `UPSTREAM.md` in this crate for the porting record.

//! Message assembly and sending through `lettre`, plus the optional copy into
//! the account's Sent folder.
//!
//! A copy that cannot be appended is a warning, never a failed send: SMTP has
//! already accepted the message and telling the user it failed would be a lie.

use std::fs;
use std::time::Duration;

use lettre::message::{header::ContentType, Attachment, Mailbox, Message, MultiPart, SinglePart};
use lettre::transport::smtp::authentication::Credentials;
use lettre::transport::smtp::AsyncSmtpTransport;
use lettre::{AsyncTransport, Tokio1Executor};
use sqlx::Row;

use crate::error::{OneMailError, OneMailResult};
use crate::models::{MailAddress, OutboxStatus, Security, SendInput, SendResult};
use crate::state::OneMailState;
use crate::transport::MailAccount;

/// Budget for connecting, handshaking and finishing one SMTP conversation.
pub(crate) const SMTP_TIMEOUT: Duration = Duration::from_secs(30);

/// Port to use when the account left it blank: implicit TLS is 465, STARTTLS is
/// 587.
pub(crate) fn default_port(security: Security) -> u16 {
    match security {
        Security::SslTls => 465,
        Security::Starttls | Security::None => 587,
    }
}

/// Build the async SMTP transport for a plain-text credential.
pub(crate) fn build_transport(
    host: &str,
    port: u16,
    security: Security,
    email: &str,
    password: &str,
) -> OneMailResult<AsyncSmtpTransport<Tokio1Executor>> {
    if host.trim().is_empty() {
        return Err(OneMailError::not_configured("The SMTP host is not set."));
    }
    if port == 0 {
        return Err(OneMailError::invalid_input(
            "smtpPort",
            "The SMTP port must be between 1 and 65535.",
        ));
    }
    let builder = match security {
        Security::SslTls => AsyncSmtpTransport::<Tokio1Executor>::relay(host),
        Security::Starttls => AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(host),
        Security::None => Ok(AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(
            host,
        )),
    }
    .map_err(|error| {
        OneMailError::tls(format!(
            "Could not prepare the SMTP TLS settings for {host}:{port}: {error}"
        ))
    })?;
    Ok(builder
        .port(port)
        .credentials(Credentials::new(email.to_string(), password.to_string()))
        .timeout(Some(SMTP_TIMEOUT))
        .build())
}

/// Map a `lettre` failure onto a stable code. The message names the server and
/// the phase only — never the credential that was used.
pub(crate) fn map_error(
    host: &str,
    port: u16,
    error: &lettre::transport::smtp::Error,
) -> OneMailError {
    let description = describe_error(host, port, error);
    if error.is_tls() {
        return OneMailError::tls(description);
    }
    if let Some(code) = error.status() {
        if matches!(u16::from(code), 530 | 534 | 535) {
            return OneMailError::auth_failed(description);
        }
    }
    if error.is_timeout() {
        return OneMailError::network(description);
    }
    if error.is_permanent() || error.is_response() || error.is_client() {
        return OneMailError::protocol(description);
    }
    OneMailError::network(description)
}

/// The sanitized one-line form of an SMTP failure, for warnings and for the
/// connection test's `smtp_error`.
pub(crate) fn describe_error(
    host: &str,
    port: u16,
    error: &lettre::transport::smtp::Error,
) -> String {
    if error.is_tls() {
        return format!("TLS handshake with the SMTP server at {host}:{port} failed: {error}");
    }
    match error.status() {
        Some(code) if matches!(u16::from(code), 530 | 534 | 535) => {
            format!("The SMTP server at {host}:{port} rejected the credentials: {error}")
        }
        Some(_) => format!("The SMTP server at {host}:{port} refused the message: {error}"),
        None => format!("Could not talk to the SMTP server at {host}:{port}: {error}"),
    }
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

/// Send one message and, when the account has a Sent folder, append a copy.
pub async fn send(
    state: &OneMailState,
    account_id: i64,
    input: &SendInput,
) -> OneMailResult<SendResult> {
    let account = crate::transport::load_account(state, account_id).await?;
    crate::transport::ensure_supported_auth(account.auth_type)?;
    if !account.smtp_enabled {
        return Err(OneMailError::not_configured(
            "Sending is disabled for this account.",
        ));
    }
    let Some(host) = account
        .smtp_host
        .as_deref()
        .map(str::trim)
        .filter(|host| !host.is_empty())
        .map(str::to_string)
    else {
        return Err(OneMailError::not_configured(
            "This account has no SMTP host configured.",
        ));
    };
    if account.password.is_empty() {
        return Err(OneMailError::not_configured(
            "This account has no password stored. Edit the account and save one.",
        ));
    }
    if input.to.is_empty() && input.cc.is_empty() && input.bcc.is_empty() {
        return Err(OneMailError::invalid_input(
            "to",
            "A message needs at least one recipient.",
        ));
    }
    if let Some(smtp_auth_type) = account.smtp_auth_type {
        crate::transport::ensure_supported_auth(smtp_auth_type)?;
    }

    let security = account.smtp_security.unwrap_or(Security::Starttls);
    let port = account.smtp_port.unwrap_or_else(|| default_port(security));
    let message_id = message_id_for(state, input).await?;
    let message = build_message(&account, input, &message_id)?;
    // Format before sending: the same bytes go to the server and later to the
    // Sent folder, so the stored copy is byte-identical to what was delivered.
    let raw = message.formatted();

    let transport = build_transport(&host, port, security, &account.email, &account.password)?;
    let outcome = tokio::time::timeout(SMTP_TIMEOUT, transport.send(message)).await;
    match outcome {
        Ok(Ok(_response)) => {}
        Ok(Err(error)) => return Err(map_error(&host, port, &error)),
        Err(_) => {
            return Err(OneMailError::network(format!(
                "Sending through the SMTP server at {host}:{port} timed out after {}s.",
                SMTP_TIMEOUT.as_secs()
            )))
        }
    }

    let sent_at = now_iso8601();
    let warning = match crate::transport::append_to_sent(state, account_id, &raw).await {
        Ok(()) => None,
        Err(error) => {
            log::warn!(
                "Could not append the sent message of account {account_id} to its Sent folder: {}",
                error.message
            );
            Some(format!(
                "The message was sent, but the copy in the Sent folder could not be saved: {}",
                error.message
            ))
        }
    };

    Ok(SendResult {
        outbox_id: input.outbox_id.unwrap_or(0),
        status: OutboxStatus::Sent,
        rfc822_message_id: message_id,
        sent_at: Some(sent_at),
        warning,
    })
}

fn now_iso8601() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

/// Reuse the Message-ID already stored for the draft, so a retry does not look
/// like a second message; otherwise mint one.
async fn message_id_for(state: &OneMailState, input: &SendInput) -> OneMailResult<String> {
    if let Some(outbox_id) = input.outbox_id {
        let pool = state.pool().await?;
        let stored =
            sqlx::query("SELECT rfc822_message_id FROM outbox_messages WHERE outbox_id = ?1")
                .bind(outbox_id)
                .fetch_optional(&pool)
                .await
                .map_err(|error| {
                    OneMailError::database(format!(
                        "Could not read the outgoing message record: {error}"
                    ))
                })?;
        if let Some(row) = stored {
            let value: Option<String> = row.try_get("rfc822_message_id").unwrap_or_default();
            if let Some(value) = value.map(|value| value.trim().to_string()) {
                if !value.is_empty() {
                    return Ok(value);
                }
            }
        }
    }
    Ok(format!("<{}@one-mail.local>", uuid::Uuid::new_v4()))
}

/// Assemble the message: `multipart/alternative` for the body, wrapped in a
/// `multipart/mixed` when there are attachments.
pub(crate) fn build_message(
    account: &MailAccount,
    input: &SendInput,
    message_id: &str,
) -> OneMailResult<Message> {
    let from_email = parse_address(&account.email)?;
    let from_name = account
        .display_name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_string)
        .or_else(|| {
            let label = account.account_label.trim();
            (!label.is_empty()).then(|| label.to_string())
        });
    let mut builder = Message::builder()
        .from(Mailbox::new(from_name, from_email))
        .message_id(Some(message_id.to_string()));

    for address in &input.to {
        builder = builder.to(mailbox_of(address)?);
    }
    for address in &input.cc {
        builder = builder.cc(mailbox_of(address)?);
    }
    for address in &input.bcc {
        builder = builder.bcc(mailbox_of(address)?);
    }
    if let Some(in_reply_to) = non_empty(input.in_reply_to.as_deref()) {
        builder = builder.in_reply_to(in_reply_to.to_string());
    }
    if let Some(references) = non_empty(input.references_header.as_deref()) {
        builder = builder.references(references.to_string());
    }
    builder = builder.subject(input.subject.clone());

    let body = if input.body_html.trim().is_empty() {
        MultiPart::mixed().singlepart(SinglePart::plain(input.body_text.clone()))
    } else {
        MultiPart::mixed().multipart(
            MultiPart::alternative()
                .singlepart(SinglePart::plain(input.body_text.clone()))
                .singlepart(SinglePart::html(input.body_html.clone())),
        )
    };

    let mut mixed = body;
    for attachment in &input.attachments {
        let path = attachment
            .file_path
            .as_deref()
            .map(str::trim)
            .filter(|path| !path.is_empty())
            .ok_or_else(|| {
                OneMailError::invalid_input(
                    "attachments",
                    format!(
                        "The attachment {} has no file on disk.",
                        attachment.filename
                    ),
                )
            })?;
        // Only the file name reaches the error: the full path is the user's
        // business, not something to copy into a log or a toast.
        let bytes = fs::read(path).map_err(|_| {
            OneMailError::invalid_input(
                "attachments",
                format!("The attachment {} could not be read.", attachment.filename),
            )
        })?;
        let content_type = ContentType::parse(
            attachment
                .mime_type
                .as_deref()
                .unwrap_or("application/octet-stream"),
        )
        .map_err(|_| {
            OneMailError::invalid_input(
                "attachments",
                format!(
                    "The attachment {} has an unsupported MIME type.",
                    attachment.filename
                ),
            )
        })?;
        mixed = mixed
            .singlepart(Attachment::new(attachment.filename.clone()).body(bytes, content_type));
    }

    builder.multipart(mixed).map_err(|error| {
        OneMailError::invalid_input("message", format!("Could not build the message: {error}"))
    })
}

fn mailbox_of(address: &MailAddress) -> OneMailResult<Mailbox> {
    let name = address
        .name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_string);
    Ok(Mailbox::new(name, parse_address(&address.email)?))
}

fn parse_address(value: &str) -> OneMailResult<lettre::address::Address> {
    value.trim().parse().map_err(|_| {
        OneMailError::invalid_input("address", format!("{value} is not a valid e-mail address."))
    })
}

fn non_empty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

#[cfg(test)]
mod tests {
    use super::{build_message, parse_address};
    use crate::models::{
        AuthKind, ComposeKind, DraftAttachmentInput, MailAddress, Security, SendInput,
    };
    use crate::transport::MailAccount;

    fn account() -> MailAccount {
        MailAccount {
            account_id: 1,
            provider_key: "custom".to_string(),
            email: "owner@example.com".to_string(),
            display_name: Some("Owner".to_string()),
            account_label: "Owner".to_string(),
            auth_type: AuthKind::Password,
            imap_host: "imap.example.com".to_string(),
            imap_port: 993,
            imap_security: Security::SslTls,
            smtp_host: Some("smtp.example.com".to_string()),
            smtp_port: Some(587),
            smtp_security: Some(Security::Starttls),
            smtp_auth_type: Some(AuthKind::Password),
            smtp_enabled: true,
            password: "secret".to_string(),
            sync_enabled: true,
        }
    }

    fn input() -> SendInput {
        SendInput {
            outbox_id: Some(7),
            account_id: 1,
            compose_kind: ComposeKind::Reply,
            related_message_id: Some(3),
            to: vec![MailAddress {
                name: Some("Receiver".to_string()),
                email: "receiver@example.com".to_string(),
            }],
            cc: vec![MailAddress {
                name: None,
                email: "cc@example.com".to_string(),
            }],
            bcc: vec![MailAddress {
                name: None,
                email: "bcc@example.com".to_string(),
            }],
            subject: "Re: Report".to_string(),
            body_text: "Plain body".to_string(),
            body_html: "<p>Plain body</p>".to_string(),
            attachments: Vec::new(),
            in_reply_to: Some("<parent@example.com>".to_string()),
            references_header: Some("<parent@example.com> <other@example.com>".to_string()),
        }
    }

    fn formatted(message: &lettre::Message) -> String {
        String::from_utf8_lossy(&message.formatted()).into_owned()
    }

    #[test]
    fn builds_a_multipart_alternative_message_with_threading_headers() {
        let message =
            build_message(&account(), &input(), "<abc@one-mail.local>").expect("build message");
        let raw = formatted(&message);

        assert!(raw.contains("Message-ID: <abc@one-mail.local>"));
        assert!(raw.contains("In-Reply-To: <parent@example.com>"));
        assert!(raw.contains("References: <parent@example.com> <other@example.com>"));
        assert!(raw.contains("Subject: Re: Report"));
        assert!(raw.contains("multipart/alternative"));
        assert!(raw.contains("receiver@example.com"));
        assert!(raw.contains("cc@example.com"));
        // `lettre` drops the Bcc header on purpose: those recipients travel in
        // the SMTP envelope only, so no delivered copy reveals them.
        assert!(!raw.contains("bcc@example.com"));
        assert_eq!(message.envelope().to().len(), 3);
    }

    #[test]
    fn a_plain_only_body_skips_the_html_part() {
        let mut input = input();
        input.body_html = "  ".to_string();
        let message =
            build_message(&account(), &input, "<abc@one-mail.local>").expect("build message");
        let raw = formatted(&message);

        assert!(!raw.contains("multipart/alternative"));
        assert!(raw.contains("Plain body"));
    }

    #[test]
    fn a_missing_attachment_reports_its_name_only() {
        let mut input = input();
        input.attachments = vec![DraftAttachmentInput {
            file_path: Some("C:/very/private/folder/report.pdf".to_string()),
            filename: "report.pdf".to_string(),
            mime_type: Some("application/pdf".to_string()),
            size_bytes: 10,
        }];
        let error = build_message(&account(), &input, "<abc@one-mail.local>")
            .expect_err("missing file must fail");

        assert!(error.message.contains("report.pdf"));
        assert!(!error.message.contains("very/private"));
    }

    #[test]
    fn an_attachment_without_a_path_is_rejected() {
        let mut input = input();
        input.attachments = vec![DraftAttachmentInput {
            file_path: None,
            filename: "report.pdf".to_string(),
            mime_type: None,
            size_bytes: 0,
        }];
        let error = build_message(&account(), &input, "<abc@one-mail.local>")
            .expect_err("missing path must fail");

        assert!(error.message.contains("report.pdf"));
    }

    #[test]
    fn rejects_an_address_that_is_not_an_address() {
        let error = parse_address("not-an-address").expect_err("must be rejected");
        assert!(error.message.contains("not-an-address"));
        assert!(parse_address(" owner@example.com ").is_ok());
    }
}
