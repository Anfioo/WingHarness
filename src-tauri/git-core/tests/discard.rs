use std::path::PathBuf;

use git_core::test_api as core;

struct TempRepo {
    dir: PathBuf,
}

impl TempRepo {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!(
            "git-core-discard-{}-{}",
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
}

impl Drop for TempRepo {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// A Windows checkout usually runs with `core.autocrlf` on, so the worktree
/// file is CRLF while the index blob is LF. The restored file is then not
/// byte-identical to the blob, and the checkout has to write the refreshed
/// index entry back: without it status keeps reporting the file as modified
/// and its diff comes back empty — a row in the change list that no change
/// stands behind.
#[test]
fn discard_file_refreshes_the_index_under_autocrlf() {
    let repo = TempRepo::new();
    repo.write("a.txt", "one\ntwo\nthree\n");
    core::stage_all(repo.path()).unwrap();
    core::commit(repo.path(), "base").unwrap();
    core::set_config(Some(repo.path()), "core.autocrlf", "true", false).unwrap();

    repo.write("a.txt", "one\r\nCHANGED\r\nthree\r\n");
    let status = core::status(repo.path()).unwrap();
    assert_eq!(status.files.len(), 1);
    assert_eq!(status.files[0].unstaged.as_deref(), Some("modified"));

    assert!(core::discard_file(repo.path(), "a.txt").unwrap());
    assert_eq!(repo.read("a.txt"), "one\r\ntwo\r\nthree\r\n");
    assert!(core::status(repo.path()).unwrap().files.is_empty());
    assert!(core::file_diff(repo.path(), "a.txt", false, 3)
        .unwrap()
        .hunks
        .is_empty());
}
