// Adapted from moin (MIT), https://github.com/exxvius/moin at 79e7587.
// See `UPSTREAM.md` for the porting record.

//! Single-connection HTTP transfer, plus the choice between one stream and
//! several.
//!
//! [`download`] is the only entry point the built-in backend needs. It probes
//! the server once, then picks a path in this order:
//!
//! 1. a `.part.meta` that still matches the server's total → segmented resume;
//! 2. a `.part.meta` that no longer matches → drop it and the `.part`, start over;
//! 3. more than one connection, byte ranges supported, the file big enough and
//!    no bytes on disk yet → segmented transfer;
//! 4. anything else → one stream, resumed from the `.part` length.
//!
//! Every wait in this module is bounded by [`POLL`], which is also how often the
//! control handle and the stall counter are looked at.

use std::collections::BTreeMap;
use std::path::Path;
use std::time::Duration;

use futures_util::StreamExt;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, CONTENT_RANGE, RANGE};
use reqwest::Client;
use tokio::io::AsyncWriteExt;

use crate::backend::{Control, Outcome, ProgressFn, Signal};
use crate::fsattr;
use crate::segmented;

/// How often the transfer loop looks at the control handle and at the stall
/// counter. Two seconds keeps pause responsive without a wake-up per chunk.
pub(crate) const POLL: Duration = Duration::from_secs(2);

/// Request headers a task carries, dropping the pairs `reqwest` rejects so one
/// bad header cannot fail the whole download.
pub(super) fn build_headers(map: &BTreeMap<String, String>) -> HeaderMap {
    let mut headers = HeaderMap::new();
    for (name, value) in map {
        let (Ok(name), Ok(value)) = (
            HeaderName::from_bytes(name.as_bytes()),
            HeaderValue::from_str(value),
        ) else {
            continue;
        };
        headers.insert(name, value);
    }
    headers
}

/// Total size out of a `Content-Range` header, when the server states one.
pub(crate) fn parse_content_range_total(value: &str) -> Option<u64> {
    let (_, _, total) = parse_content_range(value)?;
    total
}

/// `(start, end, total)` out of `bytes <start>-<end>/<total|*>`.
fn parse_content_range(value: &str) -> Option<(u64, u64, Option<u64>)> {
    let value = value.strip_prefix("bytes ")?;
    let (range, total) = value.split_once('/')?;
    let (start, end) = range.split_once('-')?;
    Some((
        start.parse().ok()?,
        end.parse().ok()?,
        if total == "*" { None } else { total.parse().ok() },
    ))
}

/// `bytes */<total>`, which is what a `416` answer carries.
fn parse_unsatisfied_total(value: &str) -> Option<u64> {
    value.strip_prefix("bytes */")?.parse().ok()
}

/// How many consecutive [`POLL`] windows may pass without a byte before the
/// transfer counts as stalled. A zero timeout means "never", which is why the
/// count saturates at `u32::MAX` instead of wrapping.
pub(crate) fn stall_limit(stall_timeout: Duration, poll: Duration) -> u32 {
    if stall_timeout.is_zero() {
        return u32::MAX;
    }
    let poll = poll.max(Duration::from_millis(1));
    let polls = stall_timeout.as_nanos().div_ceil(poll.as_nanos());
    u32::try_from(polls).unwrap_or(u32::MAX).max(1)
}

/// Total size the server reports for `url`, or `None` when it does not honour
/// byte ranges. A one-byte ranged request is the cheapest probe there is: it
/// answers both questions at once.
pub(super) async fn probe_total(client: &Client, url: &str, headers: &HeaderMap) -> Option<u64> {
    let response = client
        .get(url)
        .headers(headers.clone())
        .header(RANGE, "bytes=0-0")
        .send()
        .await
        .ok()?;
    if response.status().as_u16() != 206 {
        return None;
    }
    let total = response
        .headers()
        .get(CONTENT_RANGE)
        .and_then(|value| value.to_str().ok())
        .and_then(parse_content_range_total)?;
    (total > 0).then_some(total)
}

/// Transfer `url` into `part`, then move it to `dest`.
#[allow(clippy::too_many_arguments)]
pub async fn download(
    client: &Client,
    url: &str,
    headers: &HeaderMap,
    part: &str,
    dest: &str,
    meta_path: &str,
    connections: usize,
    min_split: u64,
    hide_part: bool,
    stall_timeout: Duration,
    control: &Control,
    progress: &ProgressFn,
) -> Outcome {
    let destination = Path::new(dest);
    let mut offset = tokio::fs::metadata(part)
        .await
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    let plan_exists = tokio::fs::try_exists(meta_path).await.unwrap_or(false);
    if hide_part {
        fsattr::set_hidden(part, true);
    }
    // A probe only pays for itself when the answer can change the path: a
    // single connection with no plan never needs the total up front.
    let total = if connections > 1 || plan_exists {
        probe_total(client, url, headers).await
    } else {
        None
    };

    if plan_exists {
        let resumable = match total {
            Some(total) => segmented::plan_matches(meta_path, part, total).await,
            None => false,
        };
        if resumable {
            return segmented::download(
                client, url, headers, part, dest, meta_path, connections, min_split, hide_part,
                stall_timeout, control, progress,
            )
            .await;
        }
        // The plan describes a file that is no longer there, or one the server
        // has replaced since. Both artefacts go, or the next run resumes into
        // garbage.
        if let Err(error) = discard(part, meta_path).await {
            return Outcome::Failed(error);
        }
        offset = 0;
    }

    if connections > 1 && offset == 0 && total.is_some_and(|total| total >= min_split) {
        return segmented::download(
            client, url, headers, part, dest, meta_path, connections, min_split, hide_part,
            stall_timeout, control, progress,
        )
        .await;
    }

    single_stream(
        client,
        url,
        headers,
        part,
        destination,
        offset,
        hide_part,
        stall_timeout,
        control,
        progress,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn single_stream(
    client: &Client,
    url: &str,
    headers: &HeaderMap,
    part: &str,
    destination: &Path,
    offset: u64,
    hide_part: bool,
    stall_timeout: Duration,
    control: &Control,
    progress: &ProgressFn,
) -> Outcome {
    let mut request = client.get(url).headers(headers.clone());
    if offset > 0 {
        request = request.header(RANGE, format!("bytes={offset}-"));
    }
    let response = match request.send().await {
        Ok(response) => response,
        Err(error) => return Outcome::Failed(describe(&error)),
    };
    let status = response.status();
    if status.as_u16() == 416 && offset > 0 {
        // The `.part` already holds every byte the server has. Nothing to
        // download, so the file is only waiting to be renamed.
        let total = response
            .headers()
            .get(CONTENT_RANGE)
            .and_then(|value| value.to_str().ok())
            .and_then(parse_unsatisfied_total);
        if total == Some(offset) {
            return finalize(part, destination, hide_part).await;
        }
        return Outcome::Failed(
            "The server rejected the resume offset; retry the download to start over.".to_string(),
        );
    }
    if !status.is_success() {
        return Outcome::Failed(format!("The server returned HTTP {status}."));
    }
    let resuming = status.as_u16() == 206 && offset > 0;
    let total = if resuming {
        let Some((range_start, _, total)) = response
            .headers()
            .get(CONTENT_RANGE)
            .and_then(|value| value.to_str().ok())
            .and_then(parse_content_range)
        else {
            return Outcome::Failed("The server returned an invalid Content-Range header.".to_string());
        };
        if range_start != offset {
            return Outcome::Failed("The server resumed from an unexpected byte offset.".to_string());
        }
        total
    } else {
        response.content_length()
    };

    let mut options = tokio::fs::OpenOptions::new();
    options.create(true).write(true);
    if resuming {
        options.append(true);
    } else {
        options.truncate(true);
    }
    let mut file = match options.open(part).await {
        Ok(file) => file,
        Err(error) => return Outcome::Failed(format!("Could not open the partial file: {error}")),
    };
    let mut received = if resuming { offset } else { 0 };
    let mut stream = response.bytes_stream();
    let limit = stall_limit(stall_timeout, POLL);
    let mut idle_polls = 0u32;
    progress(received, total, &[]);

    let mut interrupted = None;
    loop {
        if let Some(outcome) = stop_requested(control) {
            interrupted = Some(outcome);
            break;
        }
        match tokio::time::timeout(POLL, stream.next()).await {
            Ok(Some(Ok(bytes))) => {
                if let Err(error) = file.write_all(&bytes).await {
                    interrupted = Some(Outcome::Failed(format!(
                        "Could not write the partial file: {error}"
                    )));
                    break;
                }
                received = received.saturating_add(bytes.len() as u64);
                idle_polls = 0;
                progress(received, total, &[]);
            }
            Ok(Some(Err(error))) => {
                interrupted = Some(Outcome::Failed(describe(&error)));
                break;
            }
            Ok(None) => break,
            Err(_) => {
                idle_polls = idle_polls.saturating_add(1);
                if idle_polls >= limit {
                    interrupted = Some(Outcome::Stalled);
                    break;
                }
            }
        }
    }
    let flushed = file.flush().await;
    drop(file);
    if let Err(error) = flushed {
        return Outcome::Failed(format!("Could not flush the partial file: {error}"));
    }
    if let Some(outcome) = interrupted {
        return outcome;
    }
    if let Some(expected) = total {
        if expected != received {
            return Outcome::Failed(format!(
                "The connection ended after {received} of {expected} bytes."
            ));
        }
    }
    if let Some(outcome) = stop_requested(control) {
        return outcome;
    }
    finalize(part, destination, hide_part).await
}

/// Pause and cancel are the same decision here: both stop writing and keep the
/// `.part` so the transfer can pick up where it left off.
fn stop_requested(control: &Control) -> Option<Outcome> {
    match control.signal() {
        Signal::Run => None,
        Signal::Pause => Some(Outcome::Paused),
        Signal::Cancel => Some(Outcome::Canceled),
    }
}

async fn discard(part: &str, meta_path: &str) -> Result<(), String> {
    for path in [meta_path, part] {
        match tokio::fs::remove_file(path).await {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!("Could not discard a stale partial file: {error}"));
            }
        }
    }
    Ok(())
}

/// Move a finished `.part` into place. Shared with the segmented path so both
/// entry points agree on overwrite behaviour and on clearing the hidden flag.
pub(super) async fn finalize(part: &str, destination: &Path, hide_part: bool) -> Outcome {
    if tokio::fs::try_exists(destination).await.unwrap_or(true) {
        return Outcome::Failed("The destination file already exists; it was not overwritten.".to_string());
    }
    if let Some(parent) = destination.parent() {
        if !parent.as_os_str().is_empty() {
            if let Err(error) = tokio::fs::create_dir_all(parent).await {
                return Outcome::Failed(format!("Could not create the destination directory: {error}"));
            }
        }
    }
    if hide_part {
        // A rename keeps the attribute, so it has to come off before the file
        // becomes the finished download.
        fsattr::set_hidden(part, false);
    }
    match tokio::fs::rename(part, destination).await {
        Ok(()) => Outcome::Completed,
        Err(error) => Outcome::Failed(format!("Could not finalize the download: {error}")),
    }
}

fn describe(error: &reqwest::Error) -> String {
    if error.is_timeout() {
        "The connection timed out.".to_string()
    } else if error.is_connect() {
        "Could not reach the server.".to_string()
    } else {
        format!("The HTTP request failed: {error}")
    }
}

#[cfg(test)]
mod tests {
    use super::{parse_content_range_total, stall_limit};
    use std::time::Duration;

    #[test]
    fn reads_the_total_out_of_a_content_range_header() {
        assert_eq!(parse_content_range_total("bytes 200-1000/1001"), Some(1001));
        assert_eq!(parse_content_range_total("bytes 0-0/*"), None);
        assert_eq!(parse_content_range_total("garbage"), None);
        assert_eq!(parse_content_range_total("bytes 0-0/notanumber"), None);
    }

    #[test]
    fn stall_limit_counts_poll_windows() {
        let poll = Duration::from_secs(2);
        assert_eq!(stall_limit(Duration::ZERO, poll), u32::MAX);
        assert_eq!(stall_limit(Duration::from_secs(60), poll), 30);
        assert_eq!(stall_limit(Duration::from_secs(1), poll), 1);
        assert_eq!(stall_limit(Duration::from_millis(1), poll), 1);
    }
}
