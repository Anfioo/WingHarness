use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::types::RecentRepository;
use crate::error::{AppError, AppResult};

fn store_path() -> AppResult<PathBuf> {
    let dir = crate::accounts::CONFIG_DIR
        .get()
        .ok_or_else(|| AppError::other("the git data directory has not been initialized"))?;
    std::fs::create_dir_all(dir)?;
    Ok(dir.join("recent-repositories.json"))
}

pub fn recent_list() -> AppResult<Vec<RecentRepository>> {
    let path = store_path()?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let raw = std::fs::read_to_string(path)?;
    Ok(serde_json::from_str(&raw).unwrap_or_default())
}

pub const RECENT_LIMIT: usize = 1000;

fn save(list: &[RecentRepository]) -> AppResult<()> {
    let path = store_path()?;
    std::fs::write(path, serde_json::to_string_pretty(list).unwrap_or_default())?;
    Ok(())
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

pub fn prepend_recents(
    mut list: Vec<RecentRepository>,
    paths: &[String],
    at: u64,
) -> Vec<RecentRepository> {
    // Re-opening a repository rebuilds its entry, so carry the per-repo AI
    // instructions over instead of dropping them.
    let carried: std::collections::HashMap<String, String> = list
        .iter()
        .map(|r| (r.path.clone(), r.ai_instructions.clone()))
        .collect();
    list.retain(|r| !paths.contains(&r.path));
    let added = paths.iter().map(|p| RecentRepository {
        path: p.clone(),
        name: crate::repo::repo_name(p),
        last_opened_at: at,
        ai_instructions: carried.get(p).cloned().unwrap_or_default(),
    });
    let mut merged: Vec<RecentRepository> = added.chain(list).collect();
    merged.truncate(RECENT_LIMIT);
    merged
}

pub fn recent_add(repo_path: &str) -> AppResult<Vec<RecentRepository>> {
    let list = prepend_recents(recent_list()?, &[repo_path.to_string()], now());
    save(&list)?;
    Ok(list)
}

pub fn recent_add_many(paths: &[String]) -> AppResult<Vec<RecentRepository>> {
    let mut unique: Vec<String> = Vec::new();
    for p in paths {
        if std::path::Path::new(p).is_dir() && !unique.contains(p) {
            unique.push(p.clone());
        }
    }
    let list = prepend_recents(recent_list()?, &unique, now());
    save(&list)?;
    Ok(list)
}

pub fn recent_remove(repo_path: &str) -> AppResult<Vec<RecentRepository>> {
    let mut list = recent_list()?;
    list.retain(|r| r.path != repo_path);
    save(&list)?;
    Ok(list)
}

pub fn recent_set_ai_instructions(
    repo_path: &str,
    instructions: &str,
) -> AppResult<Vec<RecentRepository>> {
    let mut list = recent_list()?;
    match list.iter_mut().find(|r| r.path == repo_path) {
        Some(entry) => entry.ai_instructions = instructions.to_string(),
        None => list.push(RecentRepository {
            path: repo_path.to_string(),
            name: crate::repo::repo_name(repo_path),
            last_opened_at: now(),
            ai_instructions: instructions.to_string(),
        }),
    }
    save(&list)?;
    Ok(list)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn recent(path: &str, at: u64) -> RecentRepository {
        RecentRepository {
            path: path.to_string(),
            name: crate::repo::repo_name(path),
            last_opened_at: at,
            ai_instructions: String::new(),
        }
    }

    #[test]
    fn prepend_keeps_order_moves_duplicates_and_caps() {
        let existing = vec![recent("/a", 1), recent("/b", 2)];
        let list = prepend_recents(existing, &["/c".into(), "/b".into()], 9);
        let paths: Vec<&str> = list.iter().map(|r| r.path.as_str()).collect();
        assert_eq!(paths, ["/c", "/b", "/a"]);
        assert_eq!(list[1].last_opened_at, 9);
        assert_eq!(list[0].name, "c");

        let many: Vec<String> = (0..RECENT_LIMIT + 10).map(|i| format!("/r{i}")).collect();
        assert_eq!(prepend_recents(Vec::new(), &many, 0).len(), RECENT_LIMIT);
    }
}
