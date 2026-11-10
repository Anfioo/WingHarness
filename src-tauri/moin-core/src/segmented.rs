// Adapted from moin (MIT), https://github.com/exxvius/moin at 79e7587.
// See UPSTREAM.md for the porting record.

use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::StreamExt;
use reqwest::header::{HeaderMap, CONTENT_RANGE, RANGE};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncSeekExt, AsyncWriteExt};

use crate::engine::{Control, ControlSignal, Outcome};

const POLL_INTERVAL: Duration = Duration::from_secs(1);

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

pub(crate) struct TransferResult {
    pub outcome: Outcome,
    pub received: u64,
}

pub(crate) async fn plan_matches(meta_path: &str, part_path: &str, total: u64) -> bool {
    let Ok(bytes) = tokio::fs::read(meta_path).await else {
        return false;
    };
    let Ok(plan) = serde_json::from_slice::<ResumePlan>(&bytes) else {
        return false;
    };
    if plan.total != total || !valid_plan(&plan) {
        return false;
    }
    tokio::fs::metadata(part_path)
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

pub(crate) async fn download(
    client: &Client,
    url: &str,
    headers: &HeaderMap,
    part_path: &str,
    destination: &Path,
    meta_path: &str,
    total: u64,
    connections: usize,
    min_split_size: u64,
    stall_timeout: Duration,
    control: &Control,
    progress: Arc<dyn Fn(u64, Option<u64>) + Send + Sync>,
) -> TransferResult {
    let mut plan = if plan_matches(meta_path, part_path, total).await {
        tokio::fs::read(meta_path)
            .await
            .ok()
            .and_then(|bytes| serde_json::from_slice::<ResumePlan>(&bytes).ok())
            .filter(valid_plan)
    } else {
        None
    };
    if plan.is_none() {
        let segments = split(total, connections.max(1), min_split_size.max(1));
        let file = match tokio::fs::OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(part_path)
            .await
        {
            Ok(file) => file,
            Err(error) => return failed(error.to_string(), 0),
        };
        if let Err(error) = file.set_len(total).await {
            return failed(error.to_string(), 0);
        }
        plan = Some(ResumePlan { total, segments });
        if let Err(error) = save_plan(meta_path, plan.as_ref().expect("plan was just created")).await {
            return failed(error, 0);
        }
    }
    let plan = plan.expect("a valid resume plan exists");
    let initial_received = plan.segments.iter().map(|segment| segment.position - segment.start).sum::<u64>();
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
        let path = part_path.to_string();
        let shared = shared.clone();
        let received = received.clone();
        let aborted = aborted.clone();
        let control = control.clone();
        let progress = progress.clone();
        workers.push(tokio::spawn(async move {
            run_segment(
                client, headers, url, path, index, segment, total, stall_timeout,
                shared, received, aborted, control, progress,
            ).await
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
        };
    }
    let received = received.load(Ordering::Acquire);
    match control.signal() {
        ControlSignal::Pause => {
            let snapshot = shared.lock().map(|segments| segments.clone()).unwrap_or_default();
            if let Err(error) = save_plan(meta_path, &ResumePlan { total, segments: snapshot }).await {
                return failed(format!("Could not save the resume plan: {error}"), received);
            }
            return TransferResult { outcome: Outcome::Paused, received };
        }
        ControlSignal::Cancel => {
            let snapshot = shared.lock().map(|segments| segments.clone()).unwrap_or_default();
            let _ = save_plan(meta_path, &ResumePlan { total, segments: snapshot }).await;
            return TransferResult { outcome: Outcome::Canceled, received };
        }
        ControlSignal::Run => {}
    }
    if let Some(error) = hard_failure {
        let snapshot = shared.lock().map(|segments| segments.clone()).unwrap_or_default();
        let _ = save_plan(meta_path, &ResumePlan { total, segments: snapshot }).await;
        return failed(error, received);
    }
    if stalled {
        let snapshot = shared.lock().map(|segments| segments.clone()).unwrap_or_default();
        let _ = save_plan(meta_path, &ResumePlan { total, segments: snapshot }).await;
        return TransferResult { outcome: Outcome::Stalled, received };
    }
    let _ = tokio::fs::remove_file(meta_path).await;
    let outcome = finalize(part_path, destination).await;
    TransferResult { outcome, received }
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
    progress: Arc<dyn Fn(u64, Option<u64>) + Send + Sync>,
) -> SegmentResult {
    let mut file = match tokio::fs::OpenOptions::new().write(true).open(&path).await {
        Ok(file) => file,
        Err(error) => return fail(&aborted, error.to_string()),
    };
    if let Err(error) = file.seek(std::io::SeekFrom::Start(segment.position)).await {
        return fail(&aborted, error.to_string());
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
        return fail(&aborted, format!("The server did not honor a byte-range request ({}).", response.status()));
    }
    let Some((range_start, range_end, range_total)) = response.headers().get(CONTENT_RANGE)
        .and_then(|header| header.to_str().ok())
        .and_then(parse_content_range)
    else {
        return fail(&aborted, "The server returned an invalid Content-Range header.".to_string());
    };
    if range_start != segment.position || range_end != segment.end || range_total != Some(total) {
        return fail(&aborted, "The server returned a different byte range than requested.".to_string());
    }

    let mut stream = response.bytes_stream();
    let mut last_data = tokio::time::Instant::now();
    loop {
        if aborted.load(Ordering::Acquire) {
            let _ = file.flush().await;
            return SegmentResult::Stopped;
        }
        match control.signal() {
            ControlSignal::Pause | ControlSignal::Cancel => {
                let _ = file.flush().await;
                return SegmentResult::Stopped;
            }
            ControlSignal::Run => {}
        }
        match tokio::time::timeout(POLL_INTERVAL, stream.next()).await {
            Ok(Some(Ok(bytes))) => {
                last_data = tokio::time::Instant::now();
                let remaining = segment.end.saturating_add(1).saturating_sub(segment.position) as usize;
                let count = bytes.len().min(remaining);
                if let Err(error) = file.write_all(&bytes[..count]).await {
                    return fail(&aborted, format!("Could not write a download segment: {error}"));
                }
                segment.position = segment.position.saturating_add(count as u64);
                let current = received.fetch_add(count as u64, Ordering::AcqRel).saturating_add(count as u64);
                if let Ok(mut segments) = shared.lock() {
                    if let Some(saved) = segments.get_mut(index) {
                        saved.position = segment.position;
                    }
                }
                progress(current, Some(total));
                if segment.complete() {
                    let _ = file.flush().await;
                    return SegmentResult::Done;
                }
            }
            Ok(Some(Err(error))) => {
                return fail(&aborted, format!("A download segment failed: {error}"));
            }
            Ok(None) => {
                return fail(&aborted, "A download segment ended before all requested bytes arrived.".to_string());
            }
            Err(_) => {
                if stall_timeout.is_zero() {
                    continue;
                }
                if last_data.elapsed() >= stall_timeout {
                    aborted.store(true, Ordering::Release);
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

async fn save_plan(path: &str, plan: &ResumePlan) -> Result<(), String> {
    let bytes = serde_json::to_vec(plan).map_err(|error| error.to_string())?;
    let target = Path::new(path);
    let temporary = target.with_extension("part.meta.tmp");
    tokio::fs::write(&temporary, bytes).await.map_err(|error| error.to_string())?;
    tokio::fs::rename(&temporary, target).await.map_err(|error| error.to_string())
}

fn parse_content_range(value: &str) -> Option<(u64, u64, Option<u64>)> {
    let value = value.strip_prefix("bytes ")?;
    let (range, total) = value.split_once('/')?;
    let (start, end) = range.split_once('-')?;
    Some((start.parse().ok()?, end.parse().ok()?, if total == "*" { None } else { total.parse().ok() }))
}

fn split(total: u64, connections: usize, minimum: u64) -> Vec<Segment> {
    if total == 0 {
        return Vec::new();
    }
    let count_by_minimum = (total / minimum).max(1);
    let count = (connections as u64).clamp(1, count_by_minimum) as usize;
    let base = total / count as u64;
    let mut start = 0u64;
    (0..count).map(|index| {
        let end = if index + 1 == count { total - 1 } else { start + base - 1 };
        let segment = Segment { start, position: start, end };
        start = end + 1;
        segment
    }).collect()
}

async fn finalize(part: &str, destination: &Path) -> Outcome {
    if tokio::fs::try_exists(destination).await.unwrap_or(true) {
        return Outcome::Failed("The destination file already exists; it was not overwritten.".to_string());
    }
    match tokio::fs::rename(part, destination).await {
        Ok(()) => Outcome::Completed,
        Err(error) => Outcome::Failed(format!("Could not finalize the segmented download: {error}")),
    }
}

fn failed(message: String, received: u64) -> TransferResult {
    TransferResult { outcome: Outcome::Failed(message), received }
}

#[cfg(test)]
mod tests {
    use super::{download, split, valid_plan, ResumePlan, Segment};
    use crate::engine::{Control, Outcome};
    use reqwest::header::HeaderMap;
    use std::sync::Arc;
    use std::time::Duration;

    #[tokio::test]
    async fn downloads_and_finalizes_range_segments() {
        let body: Vec<u8> = (0..4096).map(|value| (value % 251) as u8).collect();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let source = Arc::new(body.clone());
        let server = tokio::spawn(async move {
            for _ in 0..4 {
                let (mut socket, _) = listener.accept().await.unwrap();
                let source = source.clone();
                tokio::spawn(async move {
                    let mut request = Vec::new();
                    let mut chunk = [0u8; 1024];
                    loop {
                        let count = tokio::io::AsyncReadExt::read(&mut socket, &mut chunk).await.unwrap();
                        if count == 0 { return; }
                        request.extend_from_slice(&chunk[..count]);
                        if request.windows(4).any(|window| window == b"\r\n\r\n") { break; }
                    }
                    let text = String::from_utf8_lossy(&request);
                    let range = text.lines()
                        .find_map(|line| {
                            let (name, value) = line.split_once(':')?;
                            name.eq_ignore_ascii_case("range").then_some(value.trim())
                        })
                        .unwrap()
                        .strip_prefix("bytes=")
                        .unwrap();
                    let (start, end) = range.split_once('-').unwrap();
                    let start: usize = start.parse().unwrap();
                    let end: usize = end.parse().unwrap();
                    let payload = &source[start..=end];
                    let header = format!(
                        "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes {start}-{end}/{}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        source.len(), payload.len()
                    );
                    tokio::io::AsyncWriteExt::write_all(&mut socket, header.as_bytes()).await.unwrap();
                    tokio::io::AsyncWriteExt::write_all(&mut socket, payload).await.unwrap();
                });
            }
        });

        let dir = tempfile::tempdir().unwrap();
        let part = dir.path().join("file.bin.part");
        let dest = dir.path().join("file.bin");
        let meta = dir.path().join("file.bin.part.meta");
        let result = download(
            &reqwest::Client::new(),
            &format!("http://{address}/file.bin"),
            &HeaderMap::new(),
            part.to_str().unwrap(),
            &dest,
            meta.to_str().unwrap(),
            body.len() as u64,
            4,
            1024,
            Duration::from_secs(5),
            &Control::default(),
            Arc::new(|_, _| {}),
        ).await;
        server.await.unwrap();
        assert!(matches!(result.outcome, Outcome::Completed));
        assert_eq!(tokio::fs::read(dest).await.unwrap(), body);
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
    fn rejects_invalid_resume_plans() {
        let plan = ResumePlan {
            total: 10,
            segments: vec![Segment { start: 0, position: 0, end: 4 }, Segment { start: 5, position: 5, end: 9 }],
        };
        assert!(valid_plan(&plan));
        let invalid = ResumePlan {
            total: 10,
            segments: vec![Segment { start: 0, position: 0, end: 4 }, Segment { start: 6, position: 6, end: 9 }],
        };
        assert!(!valid_plan(&invalid));
    }
}
