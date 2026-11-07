//! Session summary and in-process cache.
//!
//! Adapted from desktop-cc-gui (MIT), https://github.com/zhukunpenglinyutong/ccgui-next.
//! Copyright (c) 2026 zhukunpenglinyutong
//! Licensed under the MIT License. See licenses/desktop-cc-gui-LICENSE.txt.
//!
//! There is no index database (decision D4): every scan enumerates candidates
//! and reuses the summary keyed by `(path, size, mtime)`. The cache is cleared
//! wholesale when it fills, which is cheaper than an LRU and good enough for a
//! file count in the low thousands.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock};

use crate::error::AgentChatError;
use crate::models::AgentSessionMeta;

use super::discovery::{self, Candidate};
use super::extract;

const CACHE_CAPACITY: usize = 2_048;
const DEFAULT_LIST_LIMIT: usize = 200;
const MAX_LIST_LIMIT: usize = 1_000;

/// What the sidebar needs from one transcript.
#[derive(Clone, Debug, Default)]
pub(crate) struct Summary {
    pub title: String,
    pub preview: String,
    pub created_at: Option<i64>,
    pub updated_at: Option<i64>,
    pub message_count: i64,
}

/// `(path, size, mtime_ms)` -> summary. Owned by the scanner; `extract` only
/// asks for entries and stores its result.
pub(crate) struct SummaryCache {
    entries: Mutex<HashMap<(PathBuf, i64, i64), Summary>>,
    capacity: usize,
}

impl SummaryCache {
    pub(crate) fn new(capacity: usize) -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
            capacity,
        }
    }

    pub(crate) fn get(&self, key: &(PathBuf, i64, i64)) -> Option<Summary> {
        self.entries
            .lock()
            .ok()
            .and_then(|entries| entries.get(key).cloned())
    }

    pub(crate) fn insert(&self, key: (PathBuf, i64, i64), summary: Summary) {
        let Ok(mut entries) = self.entries.lock() else {
            return;
        };
        if entries.len() >= self.capacity {
            entries.clear();
        }
        entries.insert(key, summary);
    }
}

pub(crate) fn cache() -> &'static SummaryCache {
    static CACHE: OnceLock<SummaryCache> = OnceLock::new();
    CACHE.get_or_init(|| SummaryCache::new(CACHE_CAPACITY))
}

pub(crate) fn list_sessions(
    engine: Option<&str>,
    workspace: Option<&Path>,
    limit: usize,
) -> Result<Vec<AgentSessionMeta>, AgentChatError> {
    let mut candidates = discovery::candidates(engine, workspace);
    dedupe(&mut candidates);
    Ok(collect(
        candidates,
        workspace,
        clamp_list_limit(limit),
        cache(),
    ))
}

/// Summarizes the candidates, drops unreadable files one at a time, filters by
/// workspace and returns the newest `limit` sessions.
///
/// Summaries are CPU-bound (one JSON parse per line) and a real history can be
/// several gigabytes, so a handful of files are parsed concurrently. Ordering
/// is restored by the sort below, and the shared cache is mutex-guarded.
pub(crate) fn collect(
    candidates: Vec<Candidate>,
    workspace: Option<&Path>,
    limit: usize,
    cache: &SummaryCache,
) -> Vec<AgentSessionMeta> {
    let candidates: Vec<Candidate> = candidates
        .into_iter()
        .filter(|candidate| match workspace {
            Some(workspace) => paths_equal(&candidate.workspace_path, workspace),
            None => true,
        })
        .collect();

    let sessions = Mutex::new(Vec::with_capacity(candidates.len()));
    let next = AtomicUsize::new(0);
    let workers = worker_count().min(candidates.len()).max(1);
    std::thread::scope(|scope| {
        for _ in 0..workers {
            scope.spawn(|| loop {
                let index = next.fetch_add(1, Ordering::Relaxed);
                let Some(candidate) = candidates.get(index) else {
                    break;
                };
                let summary =
                    match extract::summarize(&candidate.file_path, candidate.engine, cache) {
                        Ok(summary) => summary,
                        Err(error) => {
                            eprintln!(
                                "agent-chat: skipping unreadable session {}: {}",
                                candidate.file_path.display(),
                                error
                            );
                            continue;
                        }
                    };
                if let Ok(mut sessions) = sessions.lock() {
                    sessions.push(AgentSessionMeta {
                        engine: candidate.engine.to_string(),
                        session_id: candidate.session_id.clone(),
                        workspace_path: candidate.workspace_path.clone(),
                        file_path: candidate.file_path.to_string_lossy().to_string(),
                        file_size: candidate.size,
                        file_mtime_ms: candidate.mtime_ms,
                        title: summary.title,
                        preview: summary.preview,
                        created_at: summary.created_at,
                        updated_at: summary.updated_at,
                        message_count: summary.message_count,
                    });
                }
            });
        }
    });
    let mut sessions = sessions.into_inner().unwrap_or_default();

    sessions.sort_by(|left, right| {
        let left_time = left.updated_at.unwrap_or(left.file_mtime_ms);
        let right_time = right.updated_at.unwrap_or(right.file_mtime_ms);
        right_time
            .cmp(&left_time)
            .then_with(|| left.session_id.cmp(&right.session_id))
    });
    sessions.truncate(limit);
    sessions
}

fn worker_count() -> usize {
    std::thread::available_parallelism()
        .map(|count| count.get())
        .unwrap_or(4)
        .clamp(1, 8)
}

/// Claude keeps one file per session id; Codex can repeat an id between
/// `sessions` and `archived_sessions`. Keep the freshest copy of each.
fn dedupe(candidates: &mut Vec<Candidate>) {
    let mut newest: HashMap<(&'static str, String), usize> = HashMap::new();
    for (index, candidate) in candidates.iter().enumerate() {
        let key = (candidate.engine, candidate.session_id.clone());
        match newest.get(&key).copied() {
            Some(previous) if candidates[previous].mtime_ms >= candidate.mtime_ms => {}
            _ => {
                newest.insert(key, index);
            }
        }
    }
    let keep: std::collections::HashSet<usize> = newest.into_values().collect();
    let mut index = 0;
    candidates.retain(|_| {
        let keep_this = keep.contains(&index);
        index += 1;
        keep_this
    });
}

fn clamp_list_limit(limit: usize) -> usize {
    if limit == 0 {
        return DEFAULT_LIST_LIMIT;
    }
    limit.min(MAX_LIST_LIMIT)
}

/// Windows paths differ in separator and drive-letter case between the file's
/// recorded cwd and what the UI passes back.
pub(crate) fn paths_equal(left: &str, right: &Path) -> bool {
    normalize_path(left) == normalize_path(&right.to_string_lossy())
}

fn normalize_path(path: &str) -> String {
    path.trim_end_matches(['/', '\\'])
        .replace('/', "\\")
        .to_ascii_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(tag: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or(0);
        let path = std::env::temp_dir().join(format!(
            "agent-chat-scanner-{tag}-{}-{nanos}",
            std::process::id()
        ));
        fs::create_dir_all(&path).expect("create temp dir");
        path
    }

    fn candidate(path: PathBuf, session_id: &str, workspace: &str, mtime_ms: i64) -> Candidate {
        let metadata = fs::metadata(&path).expect("fixture exists");
        Candidate {
            engine: "claude",
            session_id: session_id.to_string(),
            file_path: path,
            workspace_path: workspace.to_string(),
            size: metadata.len() as i64,
            mtime_ms,
        }
    }

    #[test]
    fn summary_counts_visible_rows_and_keeps_title_and_preview() {
        let root = temp_dir("summary");
        let file = root.join("s1.jsonl");
        fs::write(
            &file,
            concat!(
                "{\"type\":\"user\",\"timestamp\":\"2026-01-01T00:00:00Z\",\"message\":{\"role\":\"user\",\"content\":\"<system-reminder>x</system-reminder>\\n<user_query>first question</user_query>\"}}\n",
                "{\"type\":\"assistant\",\"timestamp\":\"2026-01-01T00:00:01Z\",\"message\":{\"role\":\"assistant\",\"content\":\"first answer\"}}\n",
                "{\"type\":\"user\",\"timestamp\":\"2026-01-01T00:00:02Z\",\"isMeta\":true,\"message\":{\"role\":\"user\",\"content\":\"hidden\"}}\n",
                "{broken\n",
                "{\"type\":\"assistant\",\"timestamp\":\"2026-01-01T00:00:03Z\",\"message\":{\"role\":\"assistant\",\"content\":\"last answer\"}}\n",
            ),
        )
        .expect("write fixture");

        let cache = SummaryCache::new(8);
        let summary = extract::summarize(&file, "claude", &cache).expect("summarize");
        assert_eq!(summary.title, "first question");
        assert_eq!(summary.preview, "last answer");
        assert_eq!(summary.message_count, 3);
        assert_eq!(summary.created_at, Some(1_767_225_600_000));
        assert_eq!(summary.updated_at, Some(1_767_225_603_000));

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn cache_hit_avoids_reparsing_the_file() {
        let root = temp_dir("cache");
        let file = root.join("s1.jsonl");
        fs::write(
            &file,
            "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"real\"}}\n",
        )
        .expect("write fixture");

        let metadata = fs::metadata(&file).expect("stat");
        let key = (
            file.clone(),
            metadata.len() as i64,
            metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map(|duration| duration.as_millis() as i64)
                .unwrap_or(0),
        );
        let cache = SummaryCache::new(8);
        cache.insert(
            key,
            Summary {
                title: "cached".to_string(),
                ..Summary::default()
            },
        );
        let summary = extract::summarize(&file, "claude", &cache).expect("summarize");
        assert_eq!(summary.title, "cached");

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn collect_filters_workspace_sorts_and_applies_limit() {
        let root = temp_dir("collect");
        let older = root.join("a.jsonl");
        let newer = root.join("b.jsonl");
        fs::write(
            &older,
            "{\"type\":\"user\",\"timestamp\":\"2026-01-01T00:00:00Z\",\"message\":{\"role\":\"user\",\"content\":\"a\"}}\n",
        )
        .expect("write older");
        fs::write(
            &newer,
            "{\"type\":\"user\",\"timestamp\":\"2026-02-01T00:00:00Z\",\"message\":{\"role\":\"user\",\"content\":\"b\"}}\n",
        )
        .expect("write newer");

        let cache = SummaryCache::new(8);
        let candidates = vec![
            candidate(older, "a", "E:\\ws", 1),
            candidate(newer, "b", "e:\\ws\\", 2),
            // The file vanished between discovery and summarization: the scan
            // skips it instead of failing the whole list.
            Candidate {
                engine: "claude",
                session_id: "c".to_string(),
                file_path: root.join("missing.jsonl"),
                workspace_path: "E:\\ws".to_string(),
                size: 0,
                mtime_ms: 3,
            },
        ];
        let sessions = collect(candidates, Some(Path::new("E:\\ws")), 1, &cache);
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].session_id, "b");
        assert_eq!(sessions[0].title, "b");

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn dedupe_keeps_the_newest_copy_of_a_session() {
        let mut candidates = vec![
            Candidate {
                engine: "codex",
                session_id: "s".to_string(),
                file_path: PathBuf::from("old.jsonl"),
                workspace_path: "C:\\ws".to_string(),
                size: 1,
                mtime_ms: 1,
            },
            Candidate {
                engine: "codex",
                session_id: "s".to_string(),
                file_path: PathBuf::from("new.jsonl"),
                workspace_path: "C:\\ws".to_string(),
                size: 1,
                mtime_ms: 2,
            },
        ];
        dedupe(&mut candidates);
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].file_path, PathBuf::from("new.jsonl"));
    }

    #[test]
    fn paths_equal_ignores_separator_and_case() {
        assert!(paths_equal("E:\\ws\\", Path::new("e:/ws")));
        assert!(!paths_equal("E:\\ws", Path::new("E:\\ws2")));
    }

    #[test]
    #[ignore = "reads the real ~/.claude and ~/.codex histories"]
    fn lists_real_sessions_for_manual_sampling() {
        let sessions = list_sessions(None, None, MAX_LIST_LIMIT).expect("scan");
        let claude = sessions
            .iter()
            .filter(|session| session.engine == "claude")
            .count();
        let codex = sessions
            .iter()
            .filter(|session| session.engine == "codex")
            .count();
        eprintln!(
            "agent-chat manual scan: {} sessions (claude={}, codex={})",
            sessions.len(),
            claude,
            codex
        );
        for session in sessions.iter().take(5) {
            eprintln!(
                "  {} {} | {} | {} | {} msgs | cwd={}",
                session.engine,
                session.session_id,
                session.title,
                session.updated_at.unwrap_or_default(),
                session.message_count,
                session.workspace_path
            );
        }
        assert!(!sessions.is_empty());
    }
}
