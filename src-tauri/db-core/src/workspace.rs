//! The files a data source window works on: the `.sql` files of the query
//! directory, the tab set of every window, and the row limits.
//!
//! Every file lives below the same `db` directory [`crate::manager::DbManager`]
//! is given, so a workspace and a connection never disagree about where the
//! data is. Queries are plain UTF-8 text; the two JSON files carry a version,
//! so a layout this build does not know is backed up and reset rather than
//! guessed at.

use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::error::{DbError, DbResult};
use crate::models::{DbSettings, QueryFile, TabRecord, WindowTabs};
use crate::paths;

/// Version of `windows.json` and `settings.json`.
const VERSION: u32 = 1;

/// Serialises the read-modify-write of `windows.json`: two windows saving at
/// once must not lose each other's entry.
static LOCK: Mutex<()> = Mutex::new(());

/// The query directory, the window tab records and the settings of one data
/// directory.
#[derive(Clone)]
pub struct Workspace {
    data_dir: PathBuf,
}

/// `windows.json` as a whole: one entry per data source window.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WindowsFile {
    version: u32,
    windows: Vec<WindowTabs>,
}

impl WindowsFile {
    fn empty() -> Self {
        Self { version: VERSION, windows: Vec::new() }
    }
}

impl Workspace {
    pub fn new(data_dir: PathBuf) -> Self {
        Self { data_dir }
    }

    fn query_dir(&self) -> PathBuf {
        paths::query_dir(&self.data_dir)
    }

    fn windows_path(&self) -> PathBuf {
        paths::windows(&self.data_dir)
    }

    fn settings_path(&self) -> PathBuf {
        paths::settings(&self.data_dir)
    }

    /// The `.sql` files of the query directory, by name.
    pub fn queries(&self) -> DbResult<Vec<QueryFile>> {
        let directory = self.query_dir();
        std::fs::create_dir_all(&directory)?;
        let entries = std::fs::read_dir(&directory)
            .map_err(|error| DbError::internal(format!("cannot read the query directory: {error}")))?;
        let mut files = Vec::new();
        for entry in entries {
            let entry = entry
                .map_err(|error| DbError::internal(format!("cannot read the query directory: {error}")))?;
            let path = entry.path();
            if path.extension().and_then(|extension| extension.to_str()) != Some("sql") {
                continue;
            }
            let is_file = entry
                .file_type()
                .map_err(|error| DbError::internal(format!("cannot read the query directory: {error}")))?
                .is_file();
            if !is_file {
                continue;
            }
            // A name the frontend cannot represent is not a file it can ask for.
            let Ok(name) = entry.file_name().into_string() else { continue };
            let metadata = entry
                .metadata()
                .map_err(|error| DbError::internal(format!("cannot read query file {name}: {error}")))?;
            files.push(QueryFile {
                name,
                size: metadata.len(),
                modified_ms: modified_ms(metadata.modified().ok()),
            });
        }
        files.sort_by(|left, right| left.name.cmp(&right.name));
        Ok(files)
    }

    pub fn read_query(&self, name: &str) -> DbResult<String> {
        let path = self.query_path(name)?;
        match std::fs::read_to_string(&path) {
            Ok(text) => Ok(text),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                Err(DbError::not_found(format!("query file not found: {name}")))
            }
            Err(error) if error.kind() == std::io::ErrorKind::InvalidData => {
                Err(DbError::not_found(format!("query file is not UTF-8 text: {name}")))
            }
            Err(error) => Err(DbError::internal(format!("cannot read query file {name}: {error}"))),
        }
    }

    pub fn write_query(&self, name: &str, text: &str) -> DbResult<()> {
        let path = self.query_path(name)?;
        if let Some(directory) = path.parent() {
            std::fs::create_dir_all(directory)?;
        }
        write_atomic(&path, text.as_bytes())
    }

    pub fn delete_query(&self, name: &str) -> DbResult<()> {
        let path = self.query_path(name)?;
        match std::fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                Err(DbError::not_found(format!("query file not found: {name}")))
            }
            Err(error) => Err(DbError::internal(format!("cannot delete query file {name}: {error}"))),
        }
    }

    /// The stored tabs of `source`, or `None` when the window never saved any.
    pub fn window_tabs(&self, source: &str) -> DbResult<Option<WindowTabs>> {
        let file = self.read_windows()?;
        Ok(file.windows.into_iter().find(|window| window.source == source).map(sanitize_active))
    }

    /// Replaces this source's entry and leaves every other source's entry as it
    /// was, so two open windows never overwrite each other's tabs.
    pub fn save_window_tabs(&self, state: WindowTabs) -> DbResult<()> {
        if state.source.is_empty() {
            return Err(DbError::invalid("a window needs a data source"));
        }
        let source = state.source.clone();
        let state = sanitize_active(state);
        let _guard = lock();
        let mut file = self.read_windows()?;
        match file.windows.iter_mut().find(|window| window.source == source) {
            Some(window) => *window = state,
            None => file.windows.push(state),
        }
        file.version = VERSION;
        let bytes = serde_json::to_vec(&file).map_err(|error| DbError::internal(error.to_string()))?;
        write_atomic(&self.windows_path(), &bytes)
    }

    pub fn settings(&self) -> DbResult<DbSettings> {
        let path = self.settings_path();
        let settings = match std::fs::read(&path) {
            Ok(bytes) => match serde_json::from_slice::<DbSettings>(&bytes) {
                Ok(settings) if settings.version == VERSION => settings,
                Ok(settings) => {
                    log::warn!(
                        "db workspace: {} has unsupported version {}; resetting",
                        label(&path),
                        settings.version
                    );
                    backup(&path);
                    DbSettings::default()
                }
                Err(_) => {
                    log::warn!("db workspace: {} is not valid JSON; resetting", label(&path));
                    backup(&path);
                    DbSettings::default()
                }
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => DbSettings::default(),
            Err(error) => return Err(DbError::internal(format!("cannot read {}: {error}", label(&path)))),
        };
        Ok(clamp(settings))
    }

    pub fn save_settings(&self, settings: DbSettings) -> DbResult<()> {
        if !console_rows_ok(settings.console_rows) {
            return Err(DbError::invalid(format!(
                "console rows must be between 100 and 50000, not {}",
                settings.console_rows
            )));
        }
        if !table_page_size_ok(settings.table_page_size) {
            return Err(DbError::invalid(format!(
                "table page size must be between 100 and 5000, not {}",
                settings.table_page_size
            )));
        }
        let stored = DbSettings { version: VERSION, ..settings };
        let bytes = serde_json::to_vec(&stored).map_err(|error| DbError::internal(error.to_string()))?;
        write_atomic(&self.settings_path(), &bytes)
    }

    /// Validates the file name and returns its path below the query directory.
    fn query_path(&self, name: &str) -> DbResult<PathBuf> {
        validate_name(name)?;
        let directory = self.query_dir();
        let path = directory.join(name);
        if !normalize(&path).starts_with(normalize(&directory)) {
            return Err(DbError::invalid("invalid query file name"));
        }
        Ok(path)
    }

    /// Reads `windows.json`; a missing, damaged or future file reads as empty
    /// so the window opens with no tabs instead of failing to open.
    fn read_windows(&self) -> DbResult<WindowsFile> {
        let path = self.windows_path();
        let bytes = match std::fs::read(&path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(WindowsFile::empty()),
            Err(error) => return Err(DbError::internal(format!("cannot read {}: {error}", label(&path)))),
        };
        match serde_json::from_slice::<WindowsFile>(&bytes) {
            Ok(file) if file.version == VERSION => Ok(file),
            Ok(file) => {
                log::warn!(
                    "db workspace: {} has unsupported version {}; resetting",
                    label(&path),
                    file.version
                );
                backup(&path);
                Ok(WindowsFile::empty())
            }
            Err(_) => {
                log::warn!("db workspace: {} is not valid JSON; resetting", label(&path));
                backup(&path);
                Ok(WindowsFile::empty())
            }
        }
    }
}

/// A query name must name exactly one `.sql` file below the query directory.
fn validate_name(name: &str) -> DbResult<()> {
    let bad = || DbError::invalid("invalid query file name");
    if name.is_empty() || name.chars().count() > 120 {
        return Err(bad());
    }
    if !name.ends_with(".sql") || name == "." || name == ".." {
        return Err(bad());
    }
    if name.chars().any(|c| c == '/' || c == '\\' || c.is_control()) {
        return Err(bad());
    }
    Ok(())
}

/// Resolves `.` and `..` without touching the filesystem, so a file that does
/// not exist yet can still be checked.
fn normalize(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            other => normalized.push(other.as_os_str()),
        }
    }
    normalized
}

/// The key the frontend uses for a tab; `active` must be one of these.
fn tab_key(tab: &TabRecord) -> String {
    match tab {
        TabRecord::Query { file } => format!("query:{file}"),
        TabRecord::Table { target, schema, table } => format!("table:{target}\u{0}{schema}\u{0}{table}"),
    }
}

/// Drops an `active` key that no longer names a tab of the same window.
fn sanitize_active(mut state: WindowTabs) -> WindowTabs {
    if let Some(active) = state.active.as_deref() {
        if !state.tabs.iter().any(|tab| tab_key(tab) == active) {
            state.active = None;
        }
    }
    state
}

fn console_rows_ok(rows: u32) -> bool {
    (100..=50_000).contains(&rows)
}

fn table_page_size_ok(size: u32) -> bool {
    (100..=5_000).contains(&size)
}

/// The read path is lenient: an out-of-range limit falls back to its default
/// instead of making the whole settings read fail.
fn clamp(settings: DbSettings) -> DbSettings {
    let default = DbSettings::default();
    DbSettings {
        version: VERSION,
        console_rows: if console_rows_ok(settings.console_rows) {
            settings.console_rows
        } else {
            default.console_rows
        },
        table_page_size: if table_page_size_ok(settings.table_page_size) {
            settings.table_page_size
        } else {
            default.table_page_size
        },
    }
}

fn modified_ms(modified: Option<std::time::SystemTime>) -> u64 {
    modified
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

/// Writes through `<file>.tmp`, flushes it to disk and only then renames it, so
/// a crash leaves either the old file or the new one, never half of each.
fn write_atomic(path: &Path, bytes: &[u8]) -> DbResult<()> {
    if let Some(directory) = path.parent() {
        std::fs::create_dir_all(directory)?;
    }
    let temporary = temporary_path(path);
    {
        let mut file = std::fs::File::create(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
    }
    std::fs::rename(&temporary, path)?;
    Ok(())
}

fn temporary_path(path: &Path) -> PathBuf {
    let mut name = path.file_name().map(|name| name.to_os_string()).unwrap_or_default();
    name.push(".tmp");
    path.with_file_name(name)
}

/// Moves a file the reader could not understand aside, so the next write starts
/// clean while the old bytes stay inspectable.
fn backup(path: &Path) {
    let seconds = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0);
    let mut name = path.file_name().map(|name| name.to_os_string()).unwrap_or_default();
    name.push(format!(".bak-{seconds}"));
    if let Err(error) = std::fs::rename(path, path.with_file_name(name)) {
        log::warn!("db workspace: cannot back up {}: {error}", label(path));
    }
}

/// Errors carry the file name only, never file contents.
fn label(path: &Path) -> String {
    path.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default()
}

fn lock() -> std::sync::MutexGuard<'static, ()> {
    LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::DbErrorCode;

    /// A workspace below a temporary directory that is removed on drop, so a
    /// failing assertion cannot leave files behind for the next run.
    struct Sandbox {
        root: PathBuf,
    }

    impl Sandbox {
        fn new(test: &str) -> Self {
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|elapsed| elapsed.as_nanos())
                .unwrap_or(0);
            let root = std::env::temp_dir().join(format!("wingharness-workspace-{test}-{}-{nanos}", std::process::id()));
            std::fs::create_dir_all(&root).unwrap();
            Self { root }
        }

        fn workspace(&self) -> Workspace {
            Workspace::new(self.root.join("db"))
        }

        fn write_windows(&self, text: &str) {
            let workspace = self.workspace();
            std::fs::create_dir_all(&workspace.data_dir).unwrap();
            std::fs::write(workspace.windows_path(), text).unwrap();
        }

        fn backups(&self) -> Vec<String> {
            let directory = self.workspace().windows_path();
            let parent = directory.parent().unwrap();
            let mut names = Vec::new();
            for entry in std::fs::read_dir(parent).unwrap().flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if name.contains(".bak-") {
                    names.push(name);
                }
            }
            names
        }
    }

    impl Drop for Sandbox {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    fn query(name: &str) -> TabRecord {
        TabRecord::Query { file: name.to_owned() }
    }

    fn table(target: &str, schema: &str, table: &str) -> TabRecord {
        TabRecord::Table { target: target.into(), schema: schema.into(), table: table.into() }
    }

    #[test]
    fn a_first_launch_starts_empty() {
        let sandbox = Sandbox::new("first");
        let workspace = sandbox.workspace();
        assert!(workspace.queries().unwrap().is_empty());
        assert_eq!(workspace.window_tabs("s").unwrap(), None);
        assert_eq!(workspace.settings().unwrap(), DbSettings::default());
    }

    #[test]
    fn a_query_file_round_trips_through_the_directory() {
        let sandbox = Sandbox::new("roundtrip");
        let workspace = sandbox.workspace();
        workspace.write_query("local 1.sql", "SELECT 1").unwrap();
        workspace.write_query("local 2.sql", "SELECT 2").unwrap();

        let files = workspace.queries().unwrap();
        assert_eq!(files.iter().map(|file| file.name.as_str()).collect::<Vec<_>>(), ["local 1.sql", "local 2.sql"]);
        assert_eq!(files[0].size, "SELECT 1".len() as u64);
        assert_eq!(workspace.read_query("local 1.sql").unwrap(), "SELECT 1");

        workspace.delete_query("local 1.sql").unwrap();
        assert_eq!(workspace.queries().unwrap().len(), 1);
        assert_eq!(workspace.read_query("local 1.sql").unwrap_err().code, crate::error::DbErrorCode::NotFound);
        assert_eq!(workspace.delete_query("local 1.sql").unwrap_err().code, crate::error::DbErrorCode::NotFound);
    }

    #[test]
    fn only_sql_files_are_listed_and_no_temporary_file_is_left() {
        let sandbox = Sandbox::new("atomic");
        let workspace = sandbox.workspace();
        workspace.write_query("keep.sql", "SELECT 1").unwrap();
        let directory = workspace.query_dir();
        std::fs::write(directory.join("notes.txt"), "ignored").unwrap();
        std::fs::create_dir(directory.join("nested.sql")).unwrap();

        let files = workspace.queries().unwrap();
        assert_eq!(files.iter().map(|file| file.name.as_str()).collect::<Vec<_>>(), ["keep.sql"]);
        let leftovers: Vec<_> = std::fs::read_dir(&directory)
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "{leftovers:?}");
    }

    #[test]
    fn a_damaged_windows_file_is_backed_up_and_reads_as_empty() {
        let sandbox = Sandbox::new("damaged");
        sandbox.write_windows("{not json");
        let workspace = sandbox.workspace();
        assert_eq!(workspace.window_tabs("s").unwrap(), None);
        assert_eq!(sandbox.backups().len(), 1);
        // The next save replaces the damaged content instead of appending to it.
        workspace.save_window_tabs(WindowTabs { source: "s".into(), tabs: vec![query("a.sql")], active: None }).unwrap();
        assert_eq!(workspace.window_tabs("s").unwrap().unwrap().tabs.len(), 1);
    }

    #[test]
    fn an_unknown_version_is_backed_up_and_reset() {
        let sandbox = Sandbox::new("version");
        sandbox.write_windows(r#"{"version":99,"windows":[{"source":"s","tabs":[{"kind":"query","file":"a.sql"}]}]}"#);
        let workspace = sandbox.workspace();
        assert_eq!(workspace.window_tabs("s").unwrap(), None);
        assert_eq!(sandbox.backups().len(), 1);

        let path = workspace.settings_path();
        std::fs::create_dir_all(&workspace.data_dir).unwrap();
        std::fs::write(&path, r#"{"version":99,"consoleRows":200,"tablePageSize":200}"#).unwrap();
        assert_eq!(workspace.settings().unwrap(), DbSettings::default());
        let mut names: Vec<_> = std::fs::read_dir(&workspace.data_dir)
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.starts_with("settings.json.bak-"))
            .collect();
        assert_eq!(names.len(), 1, "{names:?}");
        names.sort();
    }

    #[test]
    fn names_that_are_not_one_sql_file_are_rejected() {
        let sandbox = Sandbox::new("names");
        let workspace = sandbox.workspace();
        let longest = "a".repeat(116) + ".sql";
        assert_eq!(longest.chars().count(), 120);
        let rejected = [
            "",
            ".",
            "..",
            "sql",
            "a/b.sql",
            "a\\b.sql",
            "a.txt",
            "..\\..\\escape.sql",
            "a\u{1}.sql",
            "a\n.sql",
        ];
        for name in rejected {
            let error = workspace.write_query(name, "SELECT 1").unwrap_err();
            assert_eq!(error.code, crate::error::DbErrorCode::Invalid, "{name:?}");
            assert_eq!(workspace.read_query(name).unwrap_err().code, crate::error::DbErrorCode::Invalid, "{name:?}");
            assert_eq!(workspace.delete_query(name).unwrap_err().code, crate::error::DbErrorCode::Invalid, "{name:?}");
        }
        let too_long = "a".repeat(117) + ".sql";
        assert_eq!(too_long.chars().count(), 121);
        assert_eq!(workspace.write_query(&too_long, "SELECT 1").unwrap_err().code, crate::error::DbErrorCode::Invalid);
        // Exactly 120 characters still names a file.
        workspace.write_query(&longest, "SELECT 1").unwrap();
        assert_eq!(workspace.queries().unwrap().len(), 1);
    }

    #[test]
    fn saving_one_window_keeps_the_others() {
        let sandbox = Sandbox::new("merge");
        let workspace = sandbox.workspace();
        workspace
            .save_window_tabs(WindowTabs { source: "a".into(), tabs: vec![query("a.sql")], active: Some("query:a.sql".into()) })
            .unwrap();
        workspace
            .save_window_tabs(WindowTabs {
                source: "b".into(),
                tabs: vec![table("b", "main", "t")],
                active: Some(format!("table:b\u{0}main\u{0}t")),
            })
            .unwrap();

        let first = workspace.window_tabs("a").unwrap().unwrap();
        assert_eq!(first.tabs, vec![query("a.sql")]);
        assert_eq!(first.active.as_deref(), Some("query:a.sql"));
        let second = workspace.window_tabs("b").unwrap().unwrap();
        assert_eq!(second.active.as_deref(), Some(format!("table:b\u{0}main\u{0}t")).as_deref());

        // Saving again replaces the same entry rather than adding a second one.
        workspace
            .save_window_tabs(WindowTabs { source: "a".into(), tabs: vec![query("new.sql")], active: None })
            .unwrap();
        assert_eq!(workspace.window_tabs("a").unwrap().unwrap().tabs, vec![query("new.sql")]);
        assert_eq!(workspace.window_tabs("b").unwrap().unwrap().tabs, vec![table("b", "main", "t")]);
        assert_eq!(workspace.window_tabs("c").unwrap(), None);
    }

    #[test]
    fn an_active_key_that_names_no_tab_is_dropped() {
        let sandbox = Sandbox::new("active");
        let workspace = sandbox.workspace();
        let state = WindowTabs {
            source: "a".into(),
            tabs: vec![query("a.sql")],
            active: Some("query:gone.sql".into()),
        };
        workspace.save_window_tabs(state.clone()).unwrap();
        assert_eq!(workspace.window_tabs("a").unwrap().unwrap().active, None);

        // A key of the wrong shape is dropped as well, on read and on write.
        workspace
            .save_window_tabs(WindowTabs { source: "b".into(), tabs: vec![query("b.sql")], active: Some("b.sql".into()) })
            .unwrap();
        assert_eq!(workspace.window_tabs("b").unwrap().unwrap().active, None);
        assert!(state.active.is_some(), "the caller's value is not mutated");
        let sourceless = WindowTabs { source: String::new(), tabs: Vec::new(), active: None };
        assert_eq!(workspace.save_window_tabs(sourceless).unwrap_err().code, crate::error::DbErrorCode::Invalid);
    }

    #[test]
    fn settings_are_strict_on_write_and_lenient_on_read() {
        let sandbox = Sandbox::new("settings");
        let workspace = sandbox.workspace();
        let out_of_range = [
            DbSettings { console_rows: 99, ..Default::default() },
            DbSettings { console_rows: 50_001, ..Default::default() },
            DbSettings { table_page_size: 5001, ..Default::default() },
            DbSettings { table_page_size: 99, ..Default::default() },
        ];
        for settings in out_of_range {
            assert_eq!(workspace.save_settings(settings).unwrap_err().code, crate::error::DbErrorCode::Invalid);
        }
        // The failing writes left nothing behind.
        assert_eq!(workspace.settings().unwrap(), DbSettings::default());

        let versionless = DbSettings { version: 7, console_rows: 100, table_page_size: 100 };
        workspace.save_settings(versionless).unwrap();
        let text = std::fs::read_to_string(workspace.settings_path()).unwrap();
        assert!(text.contains("\"version\":1"), "{text}");
        assert_eq!(workspace.settings().unwrap(), DbSettings { version: 1, console_rows: 100, table_page_size: 100 });

        // A hand-edited file out of range falls back rather than failing.
        std::fs::write(workspace.settings_path(), r#"{"version":1,"consoleRows":999999,"tablePageSize":100}"#).unwrap();
        assert_eq!(workspace.settings().unwrap(), DbSettings { version: 1, console_rows: 500, table_page_size: 100 });

        // The upper bounds are accepted and read back unchanged.
        workspace.save_settings(DbSettings { version: 1, console_rows: 50_000, table_page_size: 5_000 }).unwrap();
        let stored = workspace.settings().unwrap();
        assert_eq!((stored.console_rows, stored.table_page_size), (50_000, 5_000));
    }

    #[test]
    fn a_query_directory_occupied_by_a_file_reports_an_internal_error() {
        let sandbox = Sandbox::new("not-a-directory");
        let workspace = sandbox.workspace();
        std::fs::create_dir_all(&workspace.data_dir).unwrap();
        // A regular file where the query directory belongs, so neither listing
        // nor writing can create the directory underneath it.
        std::fs::write(workspace.query_dir(), "occupied").unwrap();

        assert_eq!(workspace.queries().unwrap_err().code, DbErrorCode::Internal);
        assert_eq!(workspace.write_query("a.sql", "SELECT 1").unwrap_err().code, DbErrorCode::Internal);
    }

    /// Windows cannot make a directory read-only in the POSIX sense (the
    /// attribute does not stop `CreateFile`), so the failure path is only
    /// exercised where the platform can express it.
    #[cfg(unix)]
    #[test]
    fn a_read_only_query_directory_reports_an_internal_error() {
        use std::os::unix::fs::PermissionsExt;

        let sandbox = Sandbox::new("read-only");
        let workspace = sandbox.workspace();
        std::fs::create_dir_all(workspace.query_dir()).unwrap();
        let mut permissions = std::fs::metadata(workspace.query_dir()).unwrap().permissions();
        permissions.set_mode(0o555);
        std::fs::set_permissions(workspace.query_dir(), permissions).unwrap();

        let error = workspace.write_query("a.sql", "SELECT 1").unwrap_err();
        assert_eq!(error.code, DbErrorCode::Internal);

        // Restore the write bit so the sandbox can remove its tree on drop.
        let mut permissions = std::fs::metadata(workspace.query_dir()).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(workspace.query_dir(), permissions).unwrap();
    }
}
