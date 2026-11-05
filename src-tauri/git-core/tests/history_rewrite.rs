use std::path::PathBuf;

use git_core::error::AppError;
use git_core::test_api as core;
use git_core::types::HistoryQuery;

struct TempRepo {
    dir: PathBuf,
}

impl TempRepo {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!(
            "git-core-rewrite-{}-{}",
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

    fn commit(&self, message: &str) -> String {
        core::stage_all(self.path()).unwrap();
        core::commit(self.path(), message).unwrap()
    }

    fn head_oid(&self) -> String {
        core::repo_info(self.path()).unwrap().head_oid.unwrap()
    }

    fn summaries(&self) -> Vec<String> {
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
        .into_iter()
        .map(|commit| commit.summary)
        .collect()
    }

    fn assert_clean(&self) {
        assert!(core::status(self.path()).unwrap().files.is_empty());
    }
}

impl Drop for TempRepo {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn paths(items: &[&str]) -> Vec<String> {
    items.iter().map(|item| item.to_string()).collect()
}

/// The dropped path goes back to the parent's content, the rest of the commit
/// stays, and the commits above it are replayed onto the rewritten one.
#[test]
fn drop_paths_rewrites_the_commit_and_replays_its_descendants() {
    let repo = TempRepo::new();
    repo.write("a.txt", "a1\n");
    repo.write("b.txt", "b1\n");
    repo.commit("base");
    repo.write("a.txt", "a2\n");
    repo.write("b.txt", "b2\n");
    let target = repo.commit("both");
    repo.write("c.txt", "c1\n");
    repo.commit("add c");

    let outcome = core::drop_paths(repo.path(), &target, &paths(&["a.txt"])).unwrap();

    assert_eq!(outcome.status, "ok");
    assert_eq!(repo.read("a.txt"), "a1\n");
    assert_eq!(repo.read("b.txt"), "b2\n");
    assert_eq!(repo.read("c.txt"), "c1\n");
    assert_eq!(repo.summaries(), vec!["add c", "both", "base"]);
    assert_ne!(repo.head_oid(), target);
    repo.assert_clean();
}

/// When the selected paths are all a commit changed, the commit itself goes
/// away rather than becoming an empty one.
#[test]
fn drop_paths_deletes_a_commit_that_would_become_empty() {
    let repo = TempRepo::new();
    repo.write("a.txt", "a1\n");
    repo.commit("base");
    let base = repo.head_oid();
    repo.write("a.txt", "a2\n");
    let target = repo.commit("change a");

    core::drop_paths(repo.path(), &target, &paths(&["a.txt"])).unwrap();

    assert_eq!(repo.read("a.txt"), "a1\n");
    assert_eq!(repo.head_oid(), base);
    assert_eq!(repo.summaries(), vec!["base"]);
    repo.assert_clean();
}

/// The extracted paths move into a new commit directly above the rewritten
/// one, so the branch ends with both commits and the same files as before.
#[test]
fn extract_paths_splits_the_commit_in_two() {
    let repo = TempRepo::new();
    repo.write("a.txt", "a1\n");
    repo.write("b.txt", "b1\n");
    repo.commit("base");
    repo.write("a.txt", "a2\n");
    repo.write("b.txt", "b2\n");
    let target = repo.commit("both");

    core::extract_paths(repo.path(), &target, &paths(&["a.txt"]), "extract a").unwrap();

    assert_eq!(repo.summaries(), vec!["extract a", "both", "base"]);
    assert_eq!(repo.read("a.txt"), "a2\n");
    assert_eq!(repo.read("b.txt"), "b2\n");
    repo.assert_clean();

    let head_oid = repo.head_oid();
    let files = core::commit_files(repo.path(), &head_oid).unwrap();
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].path, "a.txt");
}

/// A replayed descendant that cannot apply cleanly aborts the rewrite: HEAD,
/// the worktree and the index all stay where they were.
#[test]
fn a_conflict_in_a_descendant_leaves_everything_untouched() {
    let repo = TempRepo::new();
    repo.write("a.txt", "base\n");
    repo.commit("base");
    repo.write("a.txt", "target\n");
    let target = repo.commit("target");
    repo.write("a.txt", "later\n");
    let before = repo.commit("later");

    let error = core::drop_paths(repo.path(), &target, &paths(&["a.txt"]))
        .err()
        .expect("expected a conflict");

    match error {
        AppError::Conflict(message) => assert!(message.contains("nothing was changed")),
        other => panic!("expected a conflict, got {other}"),
    }
    assert_eq!(repo.head_oid(), before);
    assert_eq!(repo.read("a.txt"), "later\n");
    repo.assert_clean();
}

#[test]
fn a_dirty_worktree_blocks_the_rewrite() {
    let repo = TempRepo::new();
    repo.write("a.txt", "a1\n");
    repo.commit("base");
    repo.write("a.txt", "a2\n");
    let target = repo.commit("change a");
    let before = repo.head_oid();
    repo.write("a.txt", "dirty\n");

    let error = core::drop_paths(repo.path(), &target, &paths(&["a.txt"]))
        .err()
        .expect("expected a dirty worktree to be refused");

    assert!(error.to_string().contains("uncommitted changes"));
    assert_eq!(repo.head_oid(), before);
    assert_eq!(repo.read("a.txt"), "dirty\n");
}

#[test]
fn selecting_paths_the_commit_did_not_touch_is_refused() {
    let repo = TempRepo::new();
    repo.write("a.txt", "a1\n");
    repo.commit("base");
    repo.write("a.txt", "a2\n");
    let target = repo.commit("change a");
    let before = repo.head_oid();

    let error = core::drop_paths(repo.path(), &target, &paths(&["b.txt"]))
        .err()
        .expect("expected unchanged paths to be refused");

    assert!(error.to_string().contains("no changes"));
    assert_eq!(repo.head_oid(), before);
}
