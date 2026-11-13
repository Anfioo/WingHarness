// Adapted from moin (MIT), https://github.com/exxvius/moin at 79e7587.
// See `UPSTREAM.md` for the porting record.

//! Multi-connection transfer over HTTP byte ranges.
//!
//! The split and how far each segment got live in `<dest>.part.meta` as a
//! [`ResumePlan`]. [`plan_matches`] is what makes resuming safe: the plan, the
//! server's total and the on-disk `.part` length must agree, otherwise the
//! transfer starts over instead of stitching mismatched bytes together.

use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::StreamExt;
use reqwest::header::{HeaderMap, CONTENT_RANGE, RANGE};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncSeekExt, AsyncWriteExt};

use crate::backend::{Control, Outcome, ProgressFn, Signal};
use crate::fsattr;
use crate::http::{probe_total, stall_limit, POLL};
use crate::models::SegmentProgress;

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Segment {
    start: u64,
    position: u64,
    end: u64,
}

impl Segment {
    fn complete(&self) -> bool {
        self.position > self.end
    }
}

#[derive(Serialize, Deserialize)]
struct ResumePlan {
    total: u64,
    segments: Vec<Segment>,
}

/// Whether the plan on disk still describes `part` for a file of `total` bytes.
///
/// A missing plan, a plan for a different size, or a `.part` whose length no
/// longer matches all mean "do not resume": the bytes on disk cannot be trusted
/// to line up with the segments.
pub async fn plan_matches(meta_path: &str, part: &str, total: u64) -> bool {
    let Ok(bytes) = tokio::fs::read(meta_path).await else {
        return false;
    };
    let Ok(plan) = serde_json::from_slice::<ResumePlan>(&bytes) else {
        return false;
    };
    if plan.total != total || !valid_plan(&plan) {
        return false;
    }
    tokio::fs::metadata(part)
        .await
        .map(|metadata| metadata.len() == total)
        .unwrap_or(false)
}

fn valid_plan(plan: &ResumePlan) -> bool {
    if plan.total == 0 || plan.segments.is_empty() {
        return false;
    }
    let mut expected_start = 0u64;
    for segment in &plan.segments {
        if segment.start != expected_start
            || segment.end < segment.start
            || segment.end >= plan.total
            || segment.position < segment.start
            || segment.position > segment.end.saturating_add(1)
        {
            return false;
        }
        expected_start = segment.end.saturating_add(1);
    }
    expected_start == plan.total
}

/// Transfer `url` into `part` over several connections, then move it to `dest`.
///
/// The total comes from the server rather than from the caller: the signature
/// mirrors [`crate::http::download`], so the probe happens here. It costs one
/// extra one-byte request on a path that was already probed once.
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
    let Some(total) = probe_total(client, url, headers).await else {
        return Outcome::Failed(
            "The server does not report a total size for byte ranges, so the download cannot be split."
                .to_string(),
        );
    };
    if hide_part {
        fsattr::set_hidden(part, true);
    }

    let mut plan = if plan_matches(meta_path, part, total).await {
        load_plan(meta_path).await.filter(valid_plan)
    } else {
        None
    };
    if plan.is_none() {
        let segments = split(total, connections.max(1), min_split.max(1));
        let file = match tokio::fs::OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(part)
            .await
        {
            Ok(file) => file,
            Err(error) => {
                return Outcome::Failed(format!("Could not create the partial file: {error}"));
            }
        };
        if let Err(error) = file.set_len(total).await {
            return Outcome::Failed(format!("Could not size the partial file: {error}"));
        }
        drop(file);
        plan = Some(ResumePlan { total, segments });
        if let Err(error) = save_plan(meta_path, plan.as_ref().expect("the plan was just built")).await
        {
            return Outcome::Failed(format!("Could not save the resume plan: {error}"));
        }
    }
    let plan = plan.expect("a resume plan exists");
    let initial_received = plan
        .segments
        .iter()
        .map(|segment| segment.position - segment.start)
        .sum::<u64>();
    let received = Arc::new(AtomicU64::new(initial_received));
    let shared = Arc::new(Mutex::new(plan.segments));
    let aborted = Arc::new(AtomicBool::new(false));
    let mut workers = Vec::new();

    for index in 0..shared.lock().map(|segments| segments.len()).unwrap_or(0) {
        let segment = match shared.lock().ok().and_then(|segments| segments.get(index).cloned()) {
            Some(segment) if !segment.complete() => segment,
            _ => continue,
        };
        let client = client.clone();
        let headers = headers.clone();
        let url = url.to_string();
        let path = part.to_string();
        let shared = shared.clone();
        let received = received.clone();
        let aborted = aborted.clone();
        let control = control.clone();
        let progress = progress.clone();
        workers.push(tokio::spawn(async move {
            run_segment(
                client, headers, url, path, index, segment, total, stall_timeout, shared, received,
                aborted, control, progress,
            )
            .await
        }));
    }

    let mut hard_failure = None;
    let mut stalled = false;
    for worker in workers {
        match worker.await {
            Ok(SegmentResult::Done | SegmentResult::Stopped) => {}
            Ok(SegmentResult::Stalled) => stalled = true,
            Ok(SegmentResult::Failed(error)) => {
                hard_failure.get_or_insert(error);
            }
            Err(error) => {
                hard_failure.get_or_insert(format!("A download segment stopped unexpectedly: {error}"));
            }
        }
    }
    let snapshot = || shared.lock().map(|segments| segments.clone()).unwrap_or_default();

    match control.signal() {
        Signal::Pause => {
            if let Err(error) = save_plan(
                meta_path,
                &ResumePlan { total, segments: snapshot() },
            )
            .await
            {
                return Outcome::Failed(format!("Could not save the resume plan: {error}"));
            }
            return Outcome::Paused;
        }
        Signal::Cancel => {
            let _ = save_plan(meta_path, &ResumePlan { total, segments: snapshot() }).await;
            return Outcome::Canceled;
        }
        Signal::Run => {}
    }
    if let Some(error) = hard_failure {
        let _ = save_plan(meta_path, &ResumePlan { total, segments: snapshot() }).await;
        return Outcome::Failed(error);
    }
    if stalled {
        // The plan survives so a retry can resume from where the data stopped.
        let _ = save_plan(meta_path, &ResumePlan { total, segments: snapshot() }).await;
        return Outcome::Stalled;
    }
    let _ = tokio::fs::remove_file(meta_path).await;
    crate::http::finalize(part, destination, hide_part).await
}

#[derive(Debug)]
enum SegmentResult {
    Done,
    Stopped,
    Stalled,
    Failed(String),
}

#[allow(clippy::too_many_arguments)]
async fn run_segment(
    client: Client,
    headers: HeaderMap,
    url: String,
    path: String,
    index: usize,
    mut segment: Segment,
    total: u64,
    stall_timeout: Duration,
    shared: Arc<Mutex<Vec<Segment>>>,
    received: Arc<AtomicU64>,
    aborted: Arc<AtomicBool>,
    control: Control,
    progress: ProgressFn,
) -> SegmentResult {
    let mut file = match tokio::fs::OpenOptions::new().write(true).open(&path).await {
        Ok(file) => file,
        Err(error) => return fail(&aborted, format!("Could not open the partial file: {error}")),
    };
    if let Err(error) = file.seek(std::io::SeekFrom::Start(segment.position)).await {
        return fail(&aborted, format!("Could not seek in the partial file: {error}"));
    }
    let response = match client
        .get(&url)
        .headers(headers)
        .header(RANGE, format!("bytes={}-{}", segment.position, segment.end))
        .send()
        .await
    {
        Ok(response) => response,
        Err(error) => return fail(&aborted, format!("Could not fetch a download segment: {error}")),
    };
    if response.status().as_u16() != 206 {
        return fail(
            &aborted,
            format!("The server did not honour a byte-range request ({}).", response.status()),
        );
    }
    let Some((range_start, range_end, range_total)) = response
        .headers()
        .get(CONTENT_RANGE)
        .and_then(|header| header.to_str().ok())
        .and_then(parse_content_range)
    else {
        return fail(&aborted, "The server returned an invalid Content-Range header.".to_string());
    };
    if range_start != segment.position || range_end != segment.end || range_total != Some(total) {
        return fail(
            &aborted,
            "The server returned a different byte range than requested.".to_string(),
        );
    }

    let mut stream = response.bytes_stream();
    let limit = stall_limit(stall_timeout, POLL);
    let mut idle_polls = 0u32;
    loop {
        if aborted.load(Ordering::Acquire) {
            let _ = file.flush().await;
            return SegmentResult::Stopped;
        }
        match control.signal() {
            Signal::Pause | Signal::Cancel => {
                let _ = file.flush().await;
                return SegmentResult::Stopped;
            }
            Signal::Run => {}
        }
        match tokio::time::timeout(POLL, stream.next()).await {
            Ok(Some(Ok(bytes))) => {
                let remaining = segment.end.saturating_add(1).saturating_sub(segment.position) as usize;
                let count = bytes.len().min(remaining);
                if let Err(error) = file.write_all(&bytes[..count]).await {
                    return fail(&aborted, format!("Could not write a download segment: {error}"));
                }
                segment.position = segment.position.saturating_add(count as u64);
                idle_polls = 0;
                let current = received
                    .fetch_add(count as u64, Ordering::AcqRel)
                    .saturating_add(count as u64);
                let snapshot = match shared.lock() {
                    Ok(mut segments) => {
                        if let Some(saved) = segments.get_mut(index) {
                            saved.position = segment.position;
                        }
                        segments
                            .iter()
                            .map(|saved| SegmentProgress {
                                start: saved.start,
                                end: saved.end,
                                position: saved.position,
                            })
                            .collect::<Vec<_>>()
                    }
                    Err(_) => Vec::new(),
                };
                progress(current, Some(total), &snapshot);
                if segment.complete() {
                    let _ = file.flush().await;
                    return SegmentResult::Done;
                }
            }
            Ok(Some(Err(error))) => {
                return fail(&aborted, format!("A download segment failed: {error}"));
            }
            Ok(None) => {
                return fail(
                    &aborted,
                    "A download segment ended before all requested bytes arrived.".to_string(),
                );
            }
            Err(_) => {
                idle_polls = idle_polls.saturating_add(1);
                if idle_polls >= limit {
                    aborted.store(true, Ordering::Release);
                    let _ = file.flush().await;
                    return SegmentResult::Stalled;
                }
            }
        }
    }
}

fn fail(aborted: &AtomicBool, error: String) -> SegmentResult {
    aborted.store(true, Ordering::Release);
    SegmentResult::Failed(error)
}

async fn load_plan(meta_path: &str) -> Option<ResumePlan> {
    let bytes = tokio::fs::read(meta_path).await.ok()?;
    serde_json::from_slice(&bytes).ok()
}

async fn save_plan(path: &str, plan: &ResumePlan) -> Result<(), String> {
    let bytes = serde_json::to_vec(plan).map_err(|error| error.to_string())?;
    let target = Path::new(path);
    let temporary = target.with_extension("part.meta.tmp");
    tokio::fs::write(&temporary, bytes)
        .await
        .map_err(|error| error.to_string())?;
    tokio::fs::rename(&temporary, target)
        .await
        .map_err(|error| error.to_string())
}

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

fn split(total: u64, connections: usize, minimum: u64) -> Vec<Segment> {
    if total == 0 {
        return Vec::new();
    }
    let count_by_minimum = (total / minimum).max(1);
    let count = (connections as u64).clamp(1, count_by_minimum) as usize;
    let base = total / count as u64;
    let mut start = 0u64;
    (0..count)
        .map(|index| {
            let end = if index + 1 == count {
                total - 1
            } else {
                start + base - 1
            };
            let segment = Segment {
                start,
                position: start,
                end,
            };
            start = end + 1;
            segment
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{download, plan_matches, save_plan, split, valid_plan, ResumePlan, Segment};
    use crate::backend::{Control, ProgressFn};
    use crate::models::SegmentProgress;
    use reqwest::header::HeaderMap;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    #[tokio::test]
    async fn plan_matches_requires_a_plan_a_total_and_a_sized_partial() {
        let dir = tempfile::tempdir().unwrap();
        let part = dir.path().join("file.bin.part");
        let meta = dir.path().join("file.bin.part.meta");
        let part_path = part.to_str().unwrap();
        let meta_path = meta.to_str().unwrap();
        let plan = ResumePlan {
            total: 8,
            segments: vec![
                Segment { start: 0, position: 0, end: 3 },
                Segment { start: 4, position: 4, end: 7 },
            ],
        };

        assert!(!plan_matches(meta_path, part_path, 8).await, "no plan on disk yet");

        save_plan(meta_path, &plan).await.unwrap();
        assert!(!plan_matches(meta_path, part_path, 8).await, "the .part is missing");

        tokio::fs::write(&part, vec![0u8; 5]).await.unwrap();
        assert!(!plan_matches(meta_path, part_path, 8).await, "the .part is the wrong length");

        tokio::fs::write(&part, vec![0u8; 8]).await.unwrap();
        assert!(!plan_matches(meta_path, part_path, 9).await, "the server reports another total");
        assert!(plan_matches(meta_path, part_path, 8).await);
    }

    #[test]
    fn split_covers_full_file_without_gaps() {
        let segments = split(101, 4, 1);
        assert_eq!(segments.first().unwrap().start, 0);
        assert_eq!(segments.last().unwrap().end, 100);
        for pair in segments.windows(2) {
            assert_eq!(pair[0].end + 1, pair[1].start);
        }
    }

    #[test]
    fn split_never_exceeds_the_minimum_segment_size() {
        assert_eq!(split(4096, 8, 1024).len(), 4);
        assert_eq!(split(1024, 8, 4096).len(), 1);
    }

    #[test]
    fn rejects_invalid_resume_plans() {
        let plan = ResumePlan {
            total: 10,
            segments: vec![
                Segment { start: 0, position: 0, end: 4 },
                Segment { start: 5, position: 5, end: 9 },
            ],
        };
        assert!(valid_plan(&plan));
        let invalid = ResumePlan {
            total: 10,
            segments: vec![
                Segment { start: 0, position: 0, end: 4 },
                Segment { start: 6, position: 6, end: 9 },
            ],
        };
        assert!(!valid_plan(&invalid));
    }

    #[tokio::test]
    async fn downloads_and_finalizes_range_segments() {
        let body: Vec<u8> = (0..4096).map(|value| (value % 251) as u8).collect();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let source = Arc::new(body.clone());
        let server = tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    return;
                };
                let source = source.clone();
                tokio::spawn(async move {
                    let mut request = Vec::new();
                    let mut chunk = [0u8; 1024];
                    loop {
                        let count =
                            tokio::io::AsyncReadExt::read(&mut socket, &mut chunk).await.unwrap();
                        if count == 0 {
                            return;
                        }
                        request.extend_from_slice(&chunk[..count]);
                        if request.windows(4).any(|window| window == b"\r\n\r\n") {
                            break;
                        }
                    }
                    let text = String::from_utf8_lossy(&request);
                    let Some((start, end)) = text
                        .lines()
                        .find_map(|line| {
                            let (name, value) = line.split_once(':')?;
                            name.eq_ignore_ascii_case("range").then_some(value.trim())
                        })
                        .and_then(|value| value.strip_prefix("bytes="))
                        .and_then(|value| value.split_once('-'))
                    else {
                        return;
                    };
                    let start: usize = start.parse().unwrap();
                    let end: usize = match end {
                        "" => source.len() - 1,
                        value => value.parse().unwrap(),
                    };
                    let payload = &source[start..=end];
                    let header = format!(
                        "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes {start}-{end}/{}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        source.len(),
                        payload.len()
                    );
                    tokio::io::AsyncWriteExt::write_all(&mut socket, header.as_bytes())
                        .await
                        .unwrap();
                    tokio::io::AsyncWriteExt::write_all(&mut socket, payload).await.unwrap();
                });
            }
        });

        let dir = tempfile::tempdir().unwrap();
        let part = dir.path().join("file.bin.part");
        let dest = dir.path().join("file.bin");
        let meta = dir.path().join("file.bin.part.meta");
        let reports: Arc<Mutex<Vec<Vec<SegmentProgress>>>> = Arc::new(Mutex::new(Vec::new()));
        let recorder = Arc::clone(&reports);
        let progress: ProgressFn = Arc::new(move |_, _, segments| {
            recorder
                .lock()
                .expect("the segment log")
                .push(segments.to_vec());
        });
        let outcome = download(
            &reqwest::Client::new(),
            &format!("http://{address}/file.bin"),
            &HeaderMap::new(),
            part.to_str().unwrap(),
            dest.to_str().unwrap(),
            meta.to_str().unwrap(),
            4,
            1024,
            false,
            Duration::from_secs(5),
            &Control::default(),
            &progress,
        )
        .await;
        server.abort();
        assert!(matches!(outcome, crate::backend::Outcome::Completed));
        assert_eq!(tokio::fs::read(dest).await.unwrap(), body);

        let reports = reports.lock().expect("the segment log");
        let widest = reports
            .iter()
            .max_by_key(|segments| segments.len())
            .expect("at least one progress report");
        assert_eq!(widest.len(), 4);
        assert_eq!(widest.first().map(|segment| segment.start), Some(0));
        assert_eq!(
            widest.last().map(|segment| segment.end),
            Some(body.len() as u64 - 1)
        );
    }
}
