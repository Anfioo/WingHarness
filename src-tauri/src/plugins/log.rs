//! Durable log of what the app ran for a plugin.
//!
//! The output panel is transient: it lives in a window and goes away with the
//! app. A plugin that serves a page keeps printing long after the user stops
//! watching, and a failure is usually investigated later — so everything the
//! runner sees while the app drives `cmd` also goes to a file,
//! `logs/plugins/<id>.log`, size-rotated.
//!
//! Plain text on purpose. The point of a log that outlives the app is that it
//! can be read with any editor, or `type`d from a terminal, with the app
//! neither running nor installed. It therefore carries no app-specific format
//! and no state beyond the file itself.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use chrono::Local;

/// Rotate once a file passes this, keeping [`MAX_FILES`] files per plugin.
const MAX_BYTES: u64 = 4 * 1024 * 1024;
const MAX_FILES: usize = 5;

/// Folder under the app's log directory: one file per plugin.
const DIR: &str = "plugins";

/// The folder every plugin log lives in.
pub fn dir() -> PathBuf {
    crate::logging::dir().join(DIR)
}

/// One plugin's log file, in a given log folder.
///
/// The writers below all take the folder this way so a test can point them at a
/// temporary directory. Nothing here may reach the real app-data folder during a
/// test run — that is the user's data, not a scratch space.
fn path_in(base: &Path, id: &str) -> PathBuf {
    base.join(format!("{id}.log"))
}

/// A marker written before the script produces anything.
pub fn begin(id: &str, entry: &str) {
    write(id, &format!("=== start {entry} ==="));
}

/// One line of the script's output, tagged with the stream it came from.
pub fn line(id: &str, stream: &str, text: &str) {
    write(id, &format!("[{stream}] {text}"));
}

/// The script exited with `code`.
pub fn finish(id: &str, code: i32) {
    write(id, &format!("=== exit {code} ==="));
}

/// The run could not be set up at all.
pub fn failed(id: &str, message: &str) {
    write(id, &format!("=== failed: {message} ==="));
}

/// Something the app did around the run, such as stopping the plugin.
pub fn note(id: &str, text: &str) {
    write(id, &format!("=== {text} ==="));
}

/// Creates the log file if it is not there yet, so "open log" always has
/// something to open.
pub fn touch(id: &str) -> Result<PathBuf, String> {
    touch_in(&dir(), id)
}

fn touch_in(base: &Path, id: &str) -> Result<PathBuf, String> {
    let path = path_in(base, id);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create {}: {error}", parent.display()))?;
    }
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|error| format!("Failed to open {}: {error}", path.display()))?;
    Ok(path)
}

/// Appends one timestamped line.
///
/// Best-effort by design: a log that cannot be written must never turn a
/// working plugin run into a failure, so every error here is dropped. The
/// caller that needs to know is [`touch`].
fn write(id: &str, line: &str) {
    write_in(&dir(), id, line);
}

fn write_in(base: &Path, id: &str, line: &str) {
    if fs::create_dir_all(base).is_err() {
        return;
    }

    let path = path_in(base, id);
    rotate_if_full(&path);

    let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&path) else {
        return;
    };
    let _ = writeln!(
        file,
        "{} {}",
        Local::now().format("%Y-%m-%d %H:%M:%S"),
        line
    );
}

/// Shifts the archives down when the live file has grown past [`MAX_BYTES`].
fn rotate_if_full(path: &Path) {
    let size = fs::metadata(path).map(|meta| meta.len()).unwrap_or(0);
    if size <= MAX_BYTES {
        return;
    }

    let _ = fs::remove_file(archive(path, MAX_FILES - 1));
    for index in (1..MAX_FILES - 1).rev() {
        let from = archive(path, index);
        if from.exists() {
            let _ = fs::rename(&from, archive(path, index + 1));
        }
    }
    // Windows cannot rename the file the caller still has open, which is why the
    // write path rotates *before* it opens the handle.
    let _ = fs::rename(path, archive(path, 1));
}

/// `x.log` → `x.2.log`, matching the fetch log's numbering.
fn archive(path: &Path, index: usize) -> PathBuf {
    path.with_extension(format!("{index}.log"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_log_lives_under_the_app_log_folder() {
        let path = path_in(&dir(), "demo");
        assert!(path.ends_with(Path::new("logs").join("plugins").join("demo.log")));
    }

    #[test]
    fn archives_are_numbered_beside_the_live_file() {
        let path = PathBuf::from("/tmp/demo.log");
        assert!(archive(&path, 1).ends_with("demo.1.log"));
        assert!(archive(&path, 4).ends_with("demo.4.log"));
    }

    /// A scratch log folder, so nothing here touches the real app data.
    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("plugin-log-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    /// The file is the deliverable, so its shape is pinned here: a timestamped
    /// line per event, a stream tag on the script's own output, and clear
    /// markers around the run. A reader with no knowledge of the app must be
    /// able to follow it.
    #[test]
    fn entries_land_in_the_log_with_a_timestamp_and_a_stream_tag() {
        let base = temp_dir("entries");

        write_in(&base, "demo", "=== start run.cmd ===");
        write_in(&base, "demo", "[stdout] serving on 127.0.0.1:11212");
        write_in(&base, "demo", "[stderr] a warning");
        write_in(&base, "demo", "=== running stop script stop.cmd ===");
        write_in(&base, "demo", "=== exit 0 ===");

        let text = fs::read_to_string(path_in(&base, "demo")).unwrap();
        assert!(text.contains("=== start run.cmd ==="), "{text}");
        assert!(
            text.contains("[stdout] serving on 127.0.0.1:11212"),
            "{text}"
        );
        assert!(text.contains("[stderr] a warning"), "{text}");
        assert!(
            text.contains("=== running stop script stop.cmd ==="),
            "{text}"
        );
        assert!(text.contains("=== exit 0 ==="), "{text}");

        // Every line starts with `YYYY-MM-DD HH:MM:SS `.
        for entry in text.lines() {
            assert_eq!(&entry[4..5], "-", "no date: {entry}");
            assert_eq!(&entry[13..14], ":", "no time: {entry}");
            assert_eq!(&entry[19..20], " ", "no separator: {entry}");
        }
    }

    /// `touch` is what `plugins_open_log` relies on: the button must always have
    /// a file to point at, even before the plugin has ever run.
    #[test]
    fn touch_creates_the_file_so_there_is_always_something_to_open() {
        let base = temp_dir("touch");

        // Twice, because a second press must not fail on an existing file.
        touch_in(&base, "demo").unwrap();
        touch_in(&base, "demo").unwrap();

        assert!(path_in(&base, "demo").is_file());
    }

    #[test]
    fn a_small_file_is_left_alone() {
        let dir = std::env::temp_dir().join(format!("plugin-log-small-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("a.log");
        fs::write(&path, "short\n").unwrap();

        rotate_if_full(&path);

        assert!(path.exists());
        assert!(!archive(&path, 1).exists());
    }

    #[test]
    fn a_full_file_becomes_the_first_archive() {
        let dir = std::env::temp_dir().join(format!("plugin-log-full-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("a.log");
        fs::write(&path, vec![b'x'; (MAX_BYTES + 1) as usize]).unwrap();

        rotate_if_full(&path);

        // The live file is gone, its contents now sit in archive 1, and the next
        // write recreates a fresh live file.
        assert!(!path.exists());
        assert_eq!(
            fs::metadata(archive(&path, 1)).unwrap().len(),
            MAX_BYTES + 1
        );
    }

    #[test]
    fn rotating_shifts_older_archives_along() {
        let dir = std::env::temp_dir().join(format!("plugin-log-shift-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("a.log");
        fs::write(&path, "oldest\n").unwrap();
        fs::write(archive(&path, 1), "newer\n").unwrap();
        fs::write(&path, vec![b'x'; (MAX_BYTES + 1) as usize]).unwrap();

        rotate_if_full(&path);

        // What was archive 1 moved to 2 rather than being overwritten.
        assert_eq!(fs::read_to_string(archive(&path, 2)).unwrap(), "newer\n");
        assert_eq!(
            fs::metadata(archive(&path, 1)).unwrap().len(),
            MAX_BYTES + 1
        );
    }
}
