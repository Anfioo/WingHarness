use std::path::PathBuf;

use git_core::test_api as core;
use git_core::types::HistoryQuery;

struct TempRepo {
    dir: PathBuf,
}

impl TempRepo {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!(
            "git-core-paths-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.to_str().unwrap();
        core::init(path).unwrap();
        core::set_config(Some(path), "user.name", "Test User", false).unwrap();
        core::set_config(Some(path), "user.email", "test@example.com", false).unwrap();
        Self { dir }
    }

    fn path(&self) -> &str {
        self.dir.to_str().unwrap()
    }

    fn write(&self, file: &str, content: &str) {
        std::fs::write(self.dir.join(file), content).unwrap();
    }

    fn read(&self, file: &str) -> String {
        std::fs::read_to_string(self.dir.join(file)).unwrap()
    }

    fn exists(&self, file: &str) -> bool {
        self.dir.join(file).exists()
    }

    fn commit(&self, message: &str) -> String {
        core::stage_all(self.path()).unwrap();
        core::commit(self.path(), message).unwrap()
    }

    fn head_oid(&self) -> String {
        core::repo_info(self.path()).unwrap().head_oid.unwrap()
    }

    fn branch(&self) -> String {
        core::repo_info(self.path()).unwrap().head_branch.unwrap()
    }

    fn commits(&self) -> Vec<git_core::types::CommitInfo> {
        core::history(
            self.path(),
            HistoryQuery {
                skip: 0,
                limit: 10,
                search: None,
                author: None,
                branch: None,
            },
        )
        .unwrap()
        .commits
    }
}

impl Drop for TempRepo {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// The named paths come back as they were at the revision — including a path
/// the revision does not have, which is deleted — and the index follows, so the
/// change shows up as staged rather than as a dirty worktree.
#[test]
fn restore_from_rev_writes_the_revision_into_index_and_worktree() {
    let repo = TempRepo::new();
    repo.write("a.txt", "one\n");
    repo.write("b.txt", "b1\n");
    repo.commit("base");
    let base = repo.head_oid();

    repo.write("a.txt", "two\n");
    repo.write("b.txt", "b2\n");
    repo.write("c.txt", "new\n");
    repo.commit("second");
    repo.write("a.txt", "dirty\n");

    core::restore_from_rev(
        repo.path(),
        &base,
        &["a.txt".to_string(), "b.txt".to_string(), "c.txt".to_string()],
    )
    .unwrap();

    assert_eq!(repo.read("a.txt"), "one\n");
    assert_eq!(repo.read("b.txt"), "b1\n");
    assert!(!repo.exists("c.txt"));

    let status = core::status(repo.path()).unwrap();
    assert_eq!(status.files.len(), 3);
    for file in status.files {
        assert_ne!(file.staged.as_deref(), None, "{} is not staged", file.path);
        assert_eq!(file.unstaged, None, "{} still has an unstaged change", file.path);
    }
}

/// Only the named path lands: the other half of the source commit never
/// reaches the index, and the result is committed like a plain cherry-pick.
#[test]
fn cherry_pick_paths_applies_only_the_named_files() {
    let repo = TempRepo::new();
    repo.write("a.txt", "a1\n");
    repo.write("b.txt", "b1\n");
    repo.commit("base");
    let base = repo.head_oid();
    let default_branch = repo.branch();

    core::branch_create(repo.path(), "feature", Some(base.as_str()), true).unwrap();
    repo.write("a.txt", "a2\n");
    repo.write("b.txt", "b2\n");
    let feature = repo.commit("change both");

    core::checkout_branch(repo.path(), &default_branch).unwrap();
    let outcome = core::cherry_pick_paths(repo.path(), &feature, &["a.txt".to_string()], false)
        .unwrap();

    assert_eq!(outcome.status, "ok");
    assert_eq!(repo.read("a.txt"), "a2\n");
    assert_eq!(repo.read("b.txt"), "b1\n");
    assert!(core::status(repo.path()).unwrap().files.is_empty());
    assert_eq!(repo.commits()[0].summary, "change both");

    let files = core::commit_files(repo.path(), &repo.head_oid()).unwrap();
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].path, "a.txt");
    assert_ne!(repo.head_oid(), base);
}

/// Reverting a path stages the inverse of that path's change and stops there —
/// no commit is made and the other path keeps the commit's content.
#[test]
fn revert_paths_undoes_only_the_named_files_without_committing() {
    let repo = TempRepo::new();
    repo.write("a.txt", "a1\n");
    repo.write("b.txt", "b1\n");
    repo.commit("base");

    repo.write("a.txt", "a2\n");
    repo.write("b.txt", "b2\n");
    let target = repo.commit("change both");

    let outcome = core::revert_paths(repo.path(), &target, &["a.txt".to_string()]).unwrap();

    assert_eq!(outcome.status, "ok");
    assert_eq!(repo.read("a.txt"), "a1\n");
    assert_eq!(repo.read("b.txt"), "b2\n");
    assert_eq!(repo.head_oid(), target);

    let status = core::status(repo.path()).unwrap();
    assert_eq!(status.files.len(), 1);
    assert_eq!(status.files[0].path, "a.txt");
    assert_eq!(status.files[0].staged.as_deref(), Some("modified"));
    assert_eq!(status.files[0].unstaged, None);
}

#[test]
fn commit_is_ancestor_follows_parents() {
    let repo = TempRepo::new();
    repo.write("a.txt", "1\n");
    repo.commit("base");
    let base = repo.head_oid();
    repo.write("a.txt", "2\n");
    let head = repo.commit("second");

    assert!(core::commit_is_ancestor(repo.path(), &base, &head).unwrap());
    assert!(!core::commit_is_ancestor(repo.path(), &head, &base).unwrap());
}
