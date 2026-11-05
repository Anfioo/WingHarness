use base64::Engine;
use git2::{ObjectType, Repository, TreeWalkMode, TreeWalkResult};

use crate::error::{AppError, AppResult};

use super::diff::is_image_path;
use super::types::{DiffHunk, DiffLine, FileDiff};

const MAX_CONTENT_BYTES: usize = 10 * 1024 * 1024;
const BINARY_PROBE_BYTES: usize = 8000;

pub fn tree_files(path: &str, oid: &str) -> AppResult<Vec<String>> {
    let repo = super::repo::open(path)?;
    let commit = repo.find_commit(git2::Oid::from_str(oid)?)?;
    let tree = commit.tree()?;
    let mut files = Vec::new();
    tree.walk(TreeWalkMode::PreOrder, |root, entry| {
        if matches!(
            entry.kind(),
            Some(ObjectType::Blob) | Some(ObjectType::Commit)
        ) {
            if let Some(name) = entry.name() {
                files.push(format!("{root}{name}"));
            }
        }
        TreeWalkResult::Ok
    })?;
    Ok(files)
}

pub fn index_files(path: &str) -> AppResult<Vec<String>> {
    let repo = super::repo::open(path)?;
    let index = repo.index()?;
    let mut files: Vec<String> = Vec::with_capacity(index.len());
    for entry in index.iter() {
        if (entry.flags & 0x3000) >> 12 != 0 {
            continue;
        }
        files.push(String::from_utf8_lossy(&entry.path).to_string());
    }
    files.dedup();
    Ok(files)
}

pub fn file_contents(path: &str, file: &str, oid: Option<&str>) -> AppResult<FileDiff> {
    let repo = super::repo::open(path)?;
    let bytes = match oid {
        Some(oid) => blob_bytes(&repo, file, oid)?,
        None => workdir_bytes(&repo, file)?,
    };
    Ok(contents_diff(file, &bytes))
}

fn blob_bytes(repo: &Repository, file: &str, oid: &str) -> AppResult<Vec<u8>> {
    let commit = repo.find_commit(git2::Oid::from_str(oid)?)?;
    let entry = commit
        .tree()?
        .get_path(std::path::Path::new(file))
        .map_err(|_| {
            AppError::other(format!(
                "{file} is not part of commit {}",
                &oid[..oid.len().min(7)]
            ))
        })?;
    let object = entry.to_object(repo)?;
    let blob = object
        .as_blob()
        .ok_or_else(|| AppError::other(format!("{file} is not a file in this commit")))?;
    if blob.content().len() > MAX_CONTENT_BYTES {
        return Err(AppError::other(format!("{file} is larger than 10 MB")));
    }
    Ok(blob.content().to_vec())
}

fn workdir_bytes(repo: &Repository, file: &str) -> AppResult<Vec<u8>> {
    let workdir = repo
        .workdir()
        .ok_or_else(|| AppError::other("bare repositories have no working copy"))?;
    let full = workdir.join(file);
    let meta = std::fs::metadata(&full)?;
    if meta.len() > MAX_CONTENT_BYTES as u64 {
        return Err(AppError::other(format!("{file} is larger than 10 MB")));
    }
    Ok(std::fs::read(full)?)
}

fn contents_diff(file: &str, bytes: &[u8]) -> FileDiff {
    let is_image = is_image_path(file);
    let is_binary = !is_image && bytes[..bytes.len().min(BINARY_PROBE_BYTES)].contains(&0);
    let mut hunks = Vec::new();
    if !is_binary && !is_image {
        let text = String::from_utf8_lossy(bytes);
        let body = text.strip_suffix('\n').unwrap_or(&text);
        let lines: Vec<DiffLine> = if bytes.is_empty() {
            Vec::new()
        } else {
            body.split('\n')
                .enumerate()
                .map(|(i, content)| DiffLine {
                    kind: "context".into(),
                    old_line_no: Some(i as u32 + 1),
                    new_line_no: Some(i as u32 + 1),
                    content: content.trim_end_matches('\r').to_string(),
                })
                .collect()
        };
        let count = lines.len() as u32;
        hunks.push(DiffHunk {
            header: String::new(),
            old_start: 1,
            old_lines: count,
            new_start: 1,
            new_lines: count,
            lines,
        });
    }
    let new_image = if is_image {
        Some(base64::engine::general_purpose::STANDARD.encode(bytes))
    } else {
        None
    };
    FileDiff {
        path: file.to_string(),
        old_path: None,
        status: "unchanged".into(),
        hunks,
        is_binary,
        is_image,
        old_image: None,
        new_image,
        additions: 0,
        deletions: 0,
    }
}
