use std::path::Path;

use git2::Repository;

use crate::error::{AppError, AppResult};

use super::types::{OpOutcome, RebaseTodoEntry};

pub(crate) fn default_signature(repo: &Repository) -> AppResult<git2::Signature<'static>> {
    repo.signature().map_err(|_| {
        AppError::other("Git identity is not configured. Set user.name and user.email in Settings.")
    })
}

pub fn commit(path: &str, message: &str) -> AppResult<String> {
    let mut repo = super::repo::open(path)?;
    let sig = default_signature(&repo)?;

    let is_merge = repo.state() == git2::RepositoryState::Merge;
    let mut merge_oids: Vec<git2::Oid> = Vec::new();
    if is_merge {
        repo.mergehead_foreach(|oid| {
            merge_oids.push(*oid);
            true
        })?;
    }

    let mut index = repo.index()?;
    let tree_oid = index.write_tree()?;
    drop(index);

    let oid = {
        let tree = repo.find_tree(tree_oid)?;
        let mut parents: Vec<git2::Commit> = repo
            .head()
            .ok()
            .and_then(|h| h.peel_to_commit().ok())
            .into_iter()
            .collect();
        for merge_oid in merge_oids {
            if let Ok(commit) = repo.find_commit(merge_oid) {
                parents.push(commit);
            }
        }
        let parent_refs: Vec<&git2::Commit> = parents.iter().collect();
        super::sign::create_commit(
            &repo,
            Some("HEAD"),
            &sig,
            &sig,
            message,
            &tree,
            &parent_refs,
        )?
    };

    if is_merge {
        repo.cleanup_state()?;
    }
    Ok(oid.to_string())
}

pub fn merge_message(path: &str) -> AppResult<Option<String>> {
    let repo = super::repo::open(path)?;
    if repo.state() != git2::RepositoryState::Merge {
        return Ok(None);
    }
    let Ok(raw) = std::fs::read_to_string(repo.path().join("MERGE_MSG")) else {
        return Ok(None);
    };
    let message = raw
        .lines()
        .filter(|line| !line.starts_with('#'))
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string();
    Ok((!message.is_empty()).then_some(message))
}

pub fn revert(path: &str, oid: &str) -> AppResult<OpOutcome> {
    let repo = super::repo::open(path)?;
    let sig = default_signature(&repo)?;
    let commit = repo.find_commit(git2::Oid::from_str(oid)?)?;

    let mut opts = git2::RevertOptions::new();
    if commit.parent_count() > 1 {
        opts.mainline(1);
    }
    repo.revert(&commit, Some(&mut opts))?;

    if repo.index()?.has_conflicts() {
        return Ok(OpOutcome {
            status: "conflicts".into(),
            message: "Revert has conflicts to resolve".into(),
        });
    }

    let mut index = repo.index()?;
    let tree = repo.find_tree(index.write_tree()?)?;
    let head = repo.head()?.peel_to_commit()?;
    let summary = commit.summary().unwrap_or("").to_string();
    let full_oid = commit.id().to_string();
    repo.commit(
        Some("HEAD"),
        &sig,
        &sig,
        &format!("Revert \"{summary}\"\n\nThis reverts commit {full_oid}."),
        &tree,
        &[&head],
    )?;
    repo.cleanup_state()?;
    Ok(OpOutcome {
        status: "ok".into(),
        message: format!("Reverted {}", &oid[..8.min(oid.len())]),
    })
}

/// Whether `ancestor` is reachable from `descendant` by following parents.
pub fn is_ancestor(path: &str, ancestor: &str, descendant: &str) -> AppResult<bool> {
    let repo = super::repo::open(path)?;
    let ancestor = repo.revparse_single(ancestor)?.peel_to_commit()?;
    let descendant = repo.revparse_single(descendant)?.peel_to_commit()?;
    Ok(repo.graph_descendant_of(descendant.id(), ancestor.id())?)
}

/// `base` with each of `paths` replaced by what `source` holds. A path the
/// source does not have — or a missing source — is removed.
fn tree_with_paths(
    repo: &Repository,
    base: Option<&git2::Tree>,
    source: Option<&git2::Tree>,
    paths: &[String],
) -> AppResult<git2::Oid> {
    let scratch = git2::Repository::open(repo.path())?;
    let mut index = scratch.index()?;
    match base {
        Some(tree) => index.read_tree(tree)?,
        None => index.clear()?,
    }
    for file in paths {
        let entry = source.and_then(|tree| tree.get_path(Path::new(file)).ok());
        let entry = match entry {
            Some(entry) => entry,
            None => {
                if index.get_path(Path::new(file), 0).is_some() {
                    index.remove_path(Path::new(file))?;
                }
                continue;
            }
        };
        if entry.kind() != Some(git2::ObjectType::Blob) {
            return Err(AppError::other(format!(
                "{file} is not a file in that revision"
            )));
        }
        let blob = repo.find_blob(entry.id())?;
        index.add_frombuffer(
            &super::branch::blob_index_entry(file, &entry, &blob),
            blob.content(),
        )?;
    }
    Ok(index.write_tree_to(repo)?)
}

/// Rebuilds the history from `oid` to HEAD with `paths` taken out of that one
/// commit, optionally splitting them into a second commit of their own.
///
/// The whole new chain is built as loose objects and only the last step moves
/// HEAD, so a conflict or a failed validation leaves the repository untouched.
fn rewrite_history(
    path: &str,
    oid: &str,
    paths: &[String],
    message: Option<&str>,
) -> AppResult<git2::Oid> {
    if paths.is_empty() {
        return Err(AppError::other("no paths were selected"));
    }
    if matches!(message, Some(text) if text.trim().is_empty()) {
        return Err(AppError::other("the new commit message cannot be empty"));
    }
    let repo = super::repo::open(path)?;
    let sig = default_signature(&repo)?;
    let target = repo
        .find_commit(git2::Oid::from_str(oid)?)
        .map_err(|_| AppError::other("that revision is not in the repository"))?;
    let head = repo
        .head()
        .map_err(|_| AppError::other("nothing to rewrite: repository has no commits"))?
        .peel_to_commit()?;
    if target.id() != head.id() && !repo.graph_descendant_of(head.id(), target.id())? {
        return Err(AppError::other(
            "only commits on the current branch can be rewritten",
        ));
    }
    super::branch::ensure_tracked_clean(&repo)?;
    if target.parent_count() > 1 {
        return Err(AppError::other(
            "a merge commit cannot be rewritten this way",
        ));
    }
    // Newest first; the replay below walks it backwards.
    let descendants = super::branch::rebase_commits(path, oid)?;

    let target_tree = target.tree()?;
    let parent = (target.parent_count() > 0)
        .then(|| target.parent(0))
        .transpose()?;
    let parent_tree = match &parent {
        Some(parent) => Some(parent.tree()?),
        None => None,
    };
    let parent_tree_id = match &parent_tree {
        Some(tree) => tree.id(),
        None => repo.treebuilder(None)?.write()?,
    };

    let remaining = tree_with_paths(&repo, Some(&target_tree), parent_tree.as_ref(), paths)?;
    if remaining == target_tree.id() {
        return Err(AppError::other(
            "the selected paths have no changes in that revision",
        ));
    }

    let new_target = if remaining == parent_tree_id {
        if message.is_some() {
            return Err(AppError::other(
                "those paths are the whole commit — extracting them would leave nothing behind",
            ));
        }
        match &parent {
            Some(parent) => parent.clone(),
            None => return Err(AppError::other("the root commit cannot be emptied")),
        }
    } else {
        let tree = repo.find_tree(remaining)?;
        let parents: Vec<git2::Commit> = parent.iter().cloned().collect();
        let parent_refs: Vec<&git2::Commit> = parents.iter().collect();
        let built = repo.commit(
            None,
            &target.author(),
            &sig,
            target.message().unwrap_or(""),
            &tree,
            &parent_refs,
        )?;
        repo.find_commit(built)?
    };

    let new_head = match message {
        Some(message) => {
            let built = repo.commit(
                None,
                &target.author(),
                &sig,
                message,
                &target_tree,
                &[&new_target],
            )?;
            repo.find_commit(built)?
        }
        None => new_target,
    };

    let mut tip = new_head;
    for descendant in descendants.iter().rev() {
        let old = repo.find_commit(git2::Oid::from_str(&descendant.oid)?)?;
        let mut index = repo.cherrypick_commit(&old, &tip, 0, None)?;
        if index.has_conflicts() {
            return Err(AppError::Conflict(format!(
                "'{}' would conflict — nothing was changed",
                old.summary().unwrap_or("")
            )));
        }
        let tree = repo.find_tree(index.write_tree_to(&repo)?)?;
        let built = repo.commit(
            None,
            &old.author(),
            &sig,
            old.message().unwrap_or(""),
            &tree,
            &[&tip],
        )?;
        tip = repo.find_commit(built)?;
    }

    repo.reset(tip.as_object(), git2::ResetType::Hard, None)?;
    Ok(tip.id())
}

pub fn drop_paths(path: &str, oid: &str, paths: &[String]) -> AppResult<OpOutcome> {
    let new_head = rewrite_history(path, oid, paths, None)?;
    Ok(OpOutcome {
        status: "ok".into(),
        message: format!(
            "Removed {} path(s) from {} — the branch now ends at {}",
            paths.len(),
            &oid[..8.min(oid.len())],
            &new_head.to_string()[..8]
        ),
    })
}

pub fn extract_paths(
    path: &str,
    oid: &str,
    paths: &[String],
    message: &str,
) -> AppResult<OpOutcome> {
    rewrite_history(path, oid, paths, Some(message))?;
    Ok(OpOutcome {
        status: "ok".into(),
        message: format!(
            "Moved {} path(s) from {} into a commit of their own",
            paths.len(),
            &oid[..8.min(oid.len())]
        ),
    })
}

pub fn amend(path: &str, message: Option<&str>) -> AppResult<String> {
    let repo = super::repo::open(path)?;
    let head = repo
        .head()
        .map_err(|_| AppError::other("nothing to amend: repository has no commits"))?;
    let commit = head.peel_to_commit()?;
    let mut index = repo.index()?;
    let tree_oid = index.write_tree()?;
    let tree = repo.find_tree(tree_oid)?;
    if super::sign::signing_config(&repo)?.is_none() {
        let oid = commit.amend(Some("HEAD"), None, None, None, message, Some(&tree))?;
        return Ok(oid.to_string());
    }
    let message = message
        .map(str::to_string)
        .unwrap_or_else(|| String::from_utf8_lossy(commit.message_bytes()).into_owned());
    let author = commit.author();
    let committer = commit.committer();
    let parents: Vec<git2::Commit> = commit.parents().collect();
    let parent_refs: Vec<&git2::Commit> = parents.iter().collect();
    let oid = super::sign::create_commit(
        &repo,
        Some("HEAD"),
        &author,
        &committer,
        &message,
        &tree,
        &parent_refs,
    )?;
    Ok(oid.to_string())
}

pub fn reword(path: &str, oid: &str, message: &str) -> AppResult<String> {
    let message = message.trim_end();
    if message.trim().is_empty() {
        return Err(AppError::other("the commit message cannot be empty"));
    }
    let repo = super::repo::open(path)?;
    let target = repo.find_commit(git2::Oid::from_str(oid)?)?;
    let head = repo
        .head()
        .map_err(|_| AppError::other("nothing to reword: repository has no commits"))?
        .peel_to_commit()?;
    if target.id() == head.id() {
        return reword_head(&repo, &head, message);
    }
    let parent = target.parent(0).map_err(|_| {
        AppError::other("the root commit can only be reworded while it is the latest commit")
    })?;
    let parent_oid = parent.id().to_string();
    let target_oid = target.id().to_string();
    let range = super::branch::rebase_commits(path, &parent_oid)?;
    let Some(index) = range.iter().position(|c| c.oid == target_oid) else {
        return Err(AppError::other(
            "only commits on the current branch can be reworded",
        ));
    };
    let todo: Vec<RebaseTodoEntry> = range
        .iter()
        .rev()
        .map(|c| {
            let is_target = c.oid == target_oid;
            RebaseTodoEntry {
                oid: c.oid.clone(),
                action: if is_target { "reword" } else { "pick" }.to_string(),
                message: is_target.then(|| message.to_string()),
            }
        })
        .collect();
    let new_head = super::branch::rebase_interactive(path, &parent_oid, &todo)?;
    let mut commit = repo.find_commit(git2::Oid::from_str(&new_head)?)?;
    for _ in 0..index {
        commit = commit.parent(0)?;
    }
    Ok(commit.id().to_string())
}

fn reword_head(repo: &Repository, head: &git2::Commit, message: &str) -> AppResult<String> {
    if super::sign::signing_config(repo)?.is_none() {
        let oid = head.amend(Some("HEAD"), None, None, None, Some(message), None)?;
        return Ok(oid.to_string());
    }
    let tree = head.tree()?;
    let parents: Vec<git2::Commit> = head.parents().collect();
    let parent_refs: Vec<&git2::Commit> = parents.iter().collect();
    let oid = super::sign::create_commit(
        repo,
        Some("HEAD"),
        &head.author(),
        &head.committer(),
        message,
        &tree,
        &parent_refs,
    )?;
    Ok(oid.to_string())
}
