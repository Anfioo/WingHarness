// Part of the one-mail module, adapted from OneMail
// (https://github.com/zhihui-hu/one-mail), AGPL-3.0-only.
// See `UPSTREAM.md` in this crate for the porting record.

//! MIME parsing with `mailparse`: headers, body parts, attachment metadata and
//! participants.
//!
//! Attachments are described, never stored: the schema keeps the name, the MIME
//! type, the transfer disposition and the decoded size, and nothing else. The
//! HTML body is handed over untouched — sanitizing is the webview's job, where
//! DOMPurify can see the DOM.

use mailparse::{
    addrparse_header, dateparse, parse_headers, parse_mail, DispositionType, MailAddr, MailHeader,
    MailHeaderMap, ParsedMail,
};

use crate::error::{OneMailError, OneMailResult};

/// Everything one raw message yields that the schema needs.
#[derive(Debug, Clone, Default)]
pub struct ParsedMessage {
    pub raw_headers: String,
    pub subject: Option<String>,
    pub message_id: Option<String>,
    pub in_reply_to: Option<String>,
    pub references_header: Option<String>,
    pub from_name: Option<String>,
    pub from_email: Option<String>,
    pub sent_at: Option<String>,
    pub body_text: Option<String>,
    pub body_html: Option<String>,
    pub attachments: Vec<ParsedAttachment>,
    pub addresses: Vec<ParsedAddressGroup>,
    pub snippet: Option<String>,
}

/// Attachment metadata only: the bytes are dropped with the raw message.
#[derive(Debug, Clone, Default)]
pub struct ParsedAttachment {
    pub part_id: Option<String>,
    pub content_id: Option<String>,
    pub filename: String,
    pub mime_type: Option<String>,
    /// `"attachment"` or `"inline"`.
    pub disposition: Option<String>,
    pub size_bytes: i64,
}

/// One address header, unrolled: a group such as `Team: a@x, b@x;` becomes two
/// entries here so the conversation grouping never has to know about groups.
#[derive(Debug, Clone, Default)]
pub struct ParsedAddressGroup {
    pub kind: String,
    pub addresses: Vec<(Option<String>, String)>,
}

/// The header-only view the sync uses: a `BODY.PEEK[HEADER]` fetch is 100×
/// cheaper than the whole message and already carries everything a list row and
/// the conversation grouping need.
#[derive(Debug, Clone, Default)]
pub(crate) struct ParsedHeaders {
    pub raw_headers: String,
    pub subject: Option<String>,
    pub message_id: Option<String>,
    pub in_reply_to: Option<String>,
    pub references_header: Option<String>,
    pub from_name: Option<String>,
    pub from_email: Option<String>,
    pub sent_at: Option<String>,
    pub addresses: Vec<ParsedAddressGroup>,
    pub has_attachments: bool,
}

/// The longest snippet the message list shows.
const SNIPPET_CHARS: usize = 200;

/// Parse one complete message.
pub fn parse(raw: &[u8]) -> OneMailResult<ParsedMessage> {
    let parsed = parse_mail(raw).map_err(|error| {
        OneMailError::protocol(format!("Could not parse the message body: {error}"))
    })?;
    let headers = headers_from(&parsed.headers);

    let mut leaves = Vec::new();
    collect_leaves(&parsed, "", &mut leaves);

    let body_text = leaves
        .iter()
        .find(|(_, part)| is_body_part(part, "text/plain"))
        .and_then(|(_, part)| decode_text_part(part));
    let body_html = leaves
        .iter()
        .find(|(_, part)| is_body_part(part, "text/html"))
        .and_then(|(_, part)| decode_text_part(part));

    let attachments = leaves
        .iter()
        .filter_map(|(part_id, part)| attachment_from(part_id, part))
        .collect::<Vec<_>>();

    let snippet = snippet_of(body_text.as_deref(), body_html.as_deref());

    Ok(ParsedMessage {
        raw_headers: headers.raw_headers,
        subject: headers.subject,
        message_id: headers.message_id,
        in_reply_to: headers.in_reply_to,
        references_header: headers.references_header,
        from_name: headers.from_name,
        from_email: headers.from_email,
        sent_at: headers.sent_at,
        body_text,
        body_html,
        attachments,
        addresses: headers.addresses,
        snippet,
    })
}

/// Parse a bare header block, as returned by `BODY.PEEK[HEADER]`.
pub(crate) fn parse_raw_headers(raw: &[u8]) -> OneMailResult<ParsedHeaders> {
    let (headers, _) = parse_headers(raw).map_err(|error| {
        OneMailError::protocol(format!("Could not parse the message headers: {error}"))
    })?;
    Ok(headers_from(&headers))
}

fn headers_from(headers: &[MailHeader<'_>]) -> ParsedHeaders {
    let (from_name, from_email) = first_address(headers, "From");
    let raw_headers = headers
        .iter()
        .map(|header| format!("{}: {}\r\n", header.get_key(), header.get_value()))
        .collect::<String>();
    ParsedHeaders {
        raw_headers,
        subject: header_value(headers, "Subject"),
        message_id: header_value(headers, "Message-ID"),
        in_reply_to: header_value(headers, "In-Reply-To"),
        references_header: header_value(headers, "References"),
        from_name,
        from_email,
        sent_at: header_value(headers, "Date").and_then(|value| iso8601_utc(&value)),
        addresses: parse_address_groups(headers),
        has_attachments: header_discloses_attachment(headers),
    }
}

fn header_value(headers: &[MailHeader<'_>], name: &str) -> Option<String> {
    headers
        .get_first_value(name)
        .map(|value| value.replace('\0', "").trim().to_string())
        .filter(|value| !value.is_empty())
}

/// `Date` → ISO-8601 UTC. `mailparse` returns epoch seconds; an unparseable
/// date leaves the column null rather than inventing "now".
pub(crate) fn iso8601_utc(value: &str) -> Option<String> {
    let seconds = dateparse(value).ok()?;
    let stamp = chrono::DateTime::from_timestamp(seconds, 0)?;
    Some(
        stamp
            .to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
            .to_string(),
    )
}

// ---------------------------------------------------------------------------
// Participants
// ---------------------------------------------------------------------------

/// From / Sender / To / Cc / Bcc / Reply-To, groups expanded, empty and
/// duplicate addresses dropped within one header.
pub(crate) fn parse_address_groups(headers: &[MailHeader<'_>]) -> Vec<ParsedAddressGroup> {
    [
        ("From", "from"),
        ("Sender", "sender"),
        ("To", "to"),
        ("Cc", "cc"),
        ("Bcc", "bcc"),
        ("Reply-To", "reply_to"),
    ]
    .into_iter()
    .map(|(name, kind)| {
        let mut addresses: Vec<(Option<String>, String)> = Vec::new();
        for header in headers.get_all_headers(name) {
            let Ok(parsed) = addrparse_header(header) else {
                continue;
            };
            for address in parsed.iter() {
                let singles = match address {
                    MailAddr::Single(single) => std::slice::from_ref(single),
                    MailAddr::Group(group) => group.addrs.as_slice(),
                };
                for single in singles {
                    let email = single.addr.trim().replace('\0', "");
                    if email.is_empty() {
                        continue;
                    }
                    if addresses
                        .iter()
                        .any(|(_, seen)| seen.eq_ignore_ascii_case(&email))
                    {
                        continue;
                    }
                    let display_name = single
                        .display_name
                        .as_deref()
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .map(str::to_string);
                    addresses.push((display_name, email));
                }
            }
        }
        ParsedAddressGroup {
            kind: kind.to_string(),
            addresses,
        }
    })
    .collect()
}

/// The first address of one header, plus a forgiving fallback for servers that
/// send a slightly broken `From`.
pub(crate) fn first_address(
    headers: &[MailHeader<'_>],
    header_name: &str,
) -> (Option<String>, Option<String>) {
    let Some(header) = headers.get_first_header(header_name) else {
        return (None, None);
    };
    if let Ok(addresses) = addrparse_header(header) {
        for address in addresses.iter() {
            let single = match address {
                MailAddr::Single(single) => Some(single),
                MailAddr::Group(group) => group.addrs.first(),
            };
            if let Some(single) = single {
                let email = single.addr.trim().replace('\0', "");
                if !email.is_empty() {
                    let name = single
                        .display_name
                        .as_deref()
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .map(str::to_string);
                    return (name, Some(email));
                }
            }
        }
    }
    loose_address(&header.get_value())
}

fn loose_address(value: &str) -> (Option<String>, Option<String>) {
    let value = value.trim();
    let (name, email) = if let Some(start) = value.rfind('<') {
        let Some(end) = value[start + 1..].find('>').map(|end| end + start + 1) else {
            return (None, None);
        };
        (
            value[..start].trim().trim_matches('"').trim().to_string(),
            value[start + 1..end].trim().to_string(),
        )
    } else {
        (String::new(), value.to_string())
    };
    if !email.contains('@') {
        return (None, None);
    }
    ((!name.is_empty()).then_some(name), Some(email))
}

// ---------------------------------------------------------------------------
// Body parts
// ---------------------------------------------------------------------------

fn collect_leaves<'a>(
    part: &'a ParsedMail<'a>,
    prefix: &str,
    leaves: &mut Vec<(String, &'a ParsedMail<'a>)>,
) {
    if part.subparts.is_empty() {
        leaves.push((prefix.to_string(), part));
        return;
    }
    for (index, child) in part.subparts.iter().enumerate() {
        let child_prefix = if prefix.is_empty() {
            format!("{}", index + 1)
        } else {
            format!("{prefix}.{}", index + 1)
        };
        collect_leaves(child, &child_prefix, leaves);
    }
}

/// A part carries the message body when it has the expected type and no file
/// name to hide behind.
fn is_body_part(part: &ParsedMail<'_>, mime_type: &str) -> bool {
    if !part.ctype.mimetype.eq_ignore_ascii_case(mime_type) {
        return false;
    }
    let disposition = part.get_content_disposition();
    if matches!(disposition.disposition, DispositionType::Attachment) {
        return false;
    }
    !disposition.params.contains_key("filename")
        && !part.ctype.params.contains_key("name")
        && part_attachment_name(part).is_none()
}

fn part_attachment_name(part: &ParsedMail<'_>) -> Option<String> {
    let disposition = part.get_content_disposition();
    disposition
        .params
        .get("filename")
        .or_else(|| part.ctype.params.get("name"))
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty())
}

fn attachment_from(part_id: &str, part: &ParsedMail<'_>) -> Option<ParsedAttachment> {
    let disposition = part.get_content_disposition();
    let disposition_name = match disposition.disposition {
        DispositionType::Attachment => "attachment",
        DispositionType::Inline => "inline",
        _ => return None,
    };
    let filename = part_attachment_name(part)?;
    let size_bytes = part.get_body_raw().map(|body| body.len()).unwrap_or(0) as i64;
    Some(ParsedAttachment {
        part_id: (!part_id.is_empty()).then(|| part_id.to_string()),
        content_id: part
            .headers
            .get_first_value("Content-ID")
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
        filename,
        mime_type: Some(part.ctype.mimetype.clone()),
        disposition: Some(disposition_name.to_string()),
        size_bytes,
    })
}

fn decode_text_part(part: &ParsedMail<'_>) -> Option<String> {
    let decoded = part
        .get_body()
        .ok()
        .or_else(|| {
            part.get_body_raw()
                .ok()
                .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
        })
        .map(|value| normalize_text(&value))?;
    (!decoded.trim().is_empty()).then_some(decoded)
}

fn normalize_text(value: &str) -> String {
    value
        .replace('\0', "")
        .lines()
        .map(str::trim_end)
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

fn snippet_of(body_text: Option<&str>, body_html: Option<&str>) -> Option<String> {
    let source = body_text
        .map(str::to_string)
        .or_else(|| body_html.map(html_to_text))?;
    let collapsed = source.split_whitespace().collect::<Vec<_>>().join(" ");
    let snippet = collapsed.chars().take(SNIPPET_CHARS).collect::<String>();
    (!snippet.is_empty()).then_some(snippet)
}

/// First body text, for the `text/plain` fallback and the snippet of an
/// HTML-only message. No `regex` dependency: a tag is everything between `<`
/// and `>`.
pub(crate) fn html_to_text(value: &str) -> String {
    let mut text = String::with_capacity(value.len());
    let mut depth = 0_usize;
    for character in value.chars() {
        match character {
            // A tag becomes one space: dropping it outright would glue
            // neighbouring words together (`</b><p>x` → "x").
            '<' => {
                if depth == 0 {
                    text.push(' ');
                }
                depth += 1;
            }
            '>' => depth = depth.saturating_sub(1),
            other if depth == 0 => text.push(other),
            _ => {}
        }
    }
    let decoded = text
        .replace("&nbsp;", " ")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&amp;", "&");
    decoded.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// A header-only fetch cannot see the part tree, so the top-level
/// `Content-Type` decides. `message::body_load` corrects the flag later.
fn header_discloses_attachment(headers: &[MailHeader<'_>]) -> bool {
    let Some(content_type) = headers.get_first_header("Content-Type") else {
        return false;
    };
    let parsed = mailparse::parse_content_type(&content_type.get_value());
    if parsed.mimetype.eq_ignore_ascii_case("multipart/mixed") {
        return true;
    }
    if parsed
        .mimetype
        .to_ascii_lowercase()
        .starts_with("multipart/")
        && parsed.params.contains_key("name")
    {
        return true;
    }
    headers
        .get_first_value("Content-Disposition")
        .map(|value| value.to_ascii_lowercase().contains("attachment"))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::{html_to_text, parse, parse_raw_headers};

    /// Build a raw message out of `(part headers, part body)` pairs. One pair
    /// becomes a single-part message, more become a `multipart/mixed`.
    fn raw(parts: &[(&str, &str)]) -> Vec<u8> {
        let mut message = String::from(
            "Subject: =?UTF-8?B?5rWL6K+V5Li76aKY?=\r\n\
             Message-ID: <message@example.com>\r\n\
             From: =?UTF-8?B?5rWL6K+V5Y+R5Lu25Lq6?= <sender@example.com>\r\n\
             To: Owner <owner@example.com>, second@example.com\r\n\
             Date: Sat, 9 Aug 2026 12:00:00 +0000\r\n",
        );
        if parts.len() > 1 {
            message.push_str("Content-Type: multipart/mixed; boundary=mail-boundary\r\n\r\n");
            for (headers, body) in parts {
                message.push_str("--mail-boundary\r\n");
                message.push_str(headers);
                message.push_str("\r\n\r\n");
                message.push_str(body);
                message.push_str("\r\n");
            }
            message.push_str("--mail-boundary--\r\n");
        } else {
            let (headers, body) = parts[0];
            message.push_str(headers);
            message.push_str("\r\n\r\n");
            message.push_str(body);
            message.push_str("\r\n");
        }
        message.into_bytes()
    }

    #[test]
    fn parses_multipart_alternative_with_encoded_headers() {
        let message = raw(&[
            (
                "Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64",
                "6L+Z5piv6YKu5Lu25q2j5paH44CC",
            ),
            (
                "Content-Type: text/html; charset=utf-8",
                "<p>这是邮件正文。</p>",
            ),
        ]);
        let parsed = parse(&message).expect("parse message");

        assert_eq!(parsed.subject.as_deref(), Some("测试主题"));
        assert_eq!(parsed.from_name.as_deref(), Some("测试发件人"));
        assert_eq!(parsed.from_email.as_deref(), Some("sender@example.com"));
        assert_eq!(parsed.message_id.as_deref(), Some("<message@example.com>"));
        assert_eq!(parsed.body_text.as_deref(), Some("这是邮件正文。"));
        assert_eq!(parsed.body_html.as_deref(), Some("<p>这是邮件正文。</p>"));
        assert_eq!(parsed.sent_at.as_deref(), Some("2026-08-09T12:00:00Z"));
        assert!(parsed.attachments.is_empty());
        assert!(parsed.raw_headers.contains("Message-ID:"));
    }

    #[test]
    fn keeps_attachment_metadata_and_drops_the_bytes() {
        let message = raw(&[
            ("Content-Type: text/plain; charset=utf-8", "See the report."),
            (
                "Content-Type: application/pdf; name=\"report.pdf\"\r\n\
                 Content-Disposition: attachment; filename=\"report.pdf\"\r\n\
                 Content-Transfer-Encoding: base64",
                "JVBERi0xLjQK",
            ),
        ]);
        let parsed = parse(&message).expect("parse message");

        assert_eq!(parsed.body_text.as_deref(), Some("See the report."));
        assert_eq!(parsed.attachments.len(), 1);
        let attachment = &parsed.attachments[0];
        assert_eq!(attachment.filename, "report.pdf");
        assert_eq!(attachment.mime_type.as_deref(), Some("application/pdf"));
        assert_eq!(attachment.disposition.as_deref(), Some("attachment"));
        assert_eq!(attachment.part_id.as_deref(), Some("2"));
        // `JVBERi0xLjQK` is the 9 decoded bytes of "%PDF-1.4\n".
        assert_eq!(attachment.size_bytes, 9);
    }

    #[test]
    fn walks_a_nested_alternative_inside_mixed_and_numbers_every_leaf() {
        let message = b"Subject: Nested\r\nFrom: a@example.com\r\n\
            Message-ID: <nested@example.com>\r\nDate: Sat, 9 Aug 2026 12:00:00 +0000\r\n\
            Content-Type: multipart/mixed; boundary=outer\r\n\r\n\
            --outer\r\n\
            Content-Type: multipart/alternative; boundary=inner\r\n\r\n\
            --inner\r\n\
            Content-Type: text/plain; charset=utf-8\r\n\r\n\
            plain body\r\n\
            --inner\r\n\
            Content-Type: text/html; charset=utf-8\r\n\r\n\
            <p>html body</p>\r\n\
            --inner--\r\n\
            --outer\r\n\
            Content-Type: application/pdf; name=\"report.pdf\"\r\n\
            Content-Disposition: attachment; filename=\"report.pdf\"\r\n\
            Content-Transfer-Encoding: base64\r\n\r\n\
            JVBERi0xLjQK\r\n\
            --outer--\r\n"
            .to_vec();
        let parsed = parse(&message).expect("parse message");

        assert_eq!(parsed.body_text.as_deref(), Some("plain body"));
        assert_eq!(parsed.body_html.as_deref(), Some("<p>html body</p>"));
        assert_eq!(parsed.attachments.len(), 1);
        assert_eq!(parsed.attachments[0].filename, "report.pdf");
        // The mixed message has two parts; the attachment is the second one.
        assert_eq!(parsed.attachments[0].part_id.as_deref(), Some("2"));
    }

    #[test]
    fn decodes_an_rfc2231_attachment_name() {
        let message = raw(&[
            ("Content-Type: text/plain; charset=utf-8", "Body"),
            (
                "Content-Type: application/pdf\r\n\
                 Content-Disposition: attachment; filename*=UTF-8''%E6%8A%A5%E5%91%8A.pdf",
                "JVBERi0xLjQK",
            ),
        ]);
        let parsed = parse(&message).expect("parse message");

        assert_eq!(parsed.attachments.len(), 1);
        assert_eq!(parsed.attachments[0].filename, "报告.pdf");
    }

    #[test]
    fn decodes_a_gb18030_body() {
        let message = raw(&[(
            "Content-Type: text/plain; charset=\"gb18030\"\r\nContent-Transfer-Encoding: base64",
            "1tDOxA==",
        )]);
        let parsed = parse(&message).expect("parse message");

        assert_eq!(parsed.body_text.as_deref(), Some("中文"));
    }

    #[test]
    fn falls_back_to_html_text_when_only_html_is_present() {
        let message = raw(&[(
            "Content-Type: text/html; charset=utf-8",
            "<html><body><p>Hello&nbsp;<b>there</b></p><script>bad()</script></body></html>",
        )]);
        let parsed = parse(&message).expect("parse message");

        assert_eq!(parsed.body_text, None);
        assert!(parsed
            .body_html
            .as_deref()
            .is_some_and(|html| html.contains("<b>")));
        assert_eq!(parsed.snippet.as_deref(), Some("Hello there bad()"));
    }

    #[test]
    fn tolerates_a_message_without_a_body() {
        let message = raw(&[("Content-Type: text/plain; charset=utf-8", "")]);
        let parsed = parse(&message).expect("parse message");

        assert_eq!(parsed.body_text, None);
        assert_eq!(parsed.body_html, None);
        assert_eq!(parsed.snippet, None);
    }

    #[test]
    fn expands_group_addresses() {
        let message = b"Subject: Group\r\nFrom: a@example.com\r\nTo: Team: b@example.com, Cee <c@example.com>;\r\nDate: Sat, 9 Aug 2026 12:00:00 +0000\r\n\r\nBody\r\n".to_vec();
        let parsed = parse(&message).expect("parse message");
        let to = parsed
            .addresses
            .iter()
            .find(|group| group.kind == "to")
            .expect("to header");

        assert_eq!(to.addresses.len(), 2);
        assert_eq!(to.addresses[0].1, "b@example.com");
        assert_eq!(to.addresses[1].0.as_deref(), Some("Cee"));
        assert_eq!(to.addresses[1].1, "c@example.com");
    }

    #[test]
    fn header_only_parse_flags_a_multipart_mixed_message() {
        let headers = b"Subject: Report\r\nFrom: sender@example.com\r\n\
            Message-ID: <abc@example.com>\r\nIn-Reply-To: <parent@example.com>\r\n\
            References: <parent@example.com>\r\nDate: Sat, 9 Aug 2026 12:00:00 +0000\r\n\
            Content-Type: multipart/mixed; boundary=b\r\n\r\n";
        let parsed = parse_raw_headers(headers).expect("parse headers");

        assert_eq!(parsed.subject.as_deref(), Some("Report"));
        assert_eq!(parsed.from_email.as_deref(), Some("sender@example.com"));
        assert_eq!(parsed.in_reply_to.as_deref(), Some("<parent@example.com>"));
        assert!(parsed.has_attachments);
        assert_eq!(parsed.sent_at.as_deref(), Some("2026-08-09T12:00:00Z"));
    }

    #[test]
    fn html_to_text_strips_tags_and_collapses_whitespace() {
        assert_eq!(
            html_to_text("<p>Hello&nbsp; <b>there</b></p>\n<div>again</div>"),
            "Hello there again"
        );
        assert_eq!(html_to_text("plain text"), "plain text");
    }
}
