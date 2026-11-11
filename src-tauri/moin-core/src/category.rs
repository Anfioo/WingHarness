// Adapted from moin (MIT), https://github.com/exxvius/moin at 79e7587.
// See `UPSTREAM.md` for the porting record.

//! Category rules and the `categories.json` document.
//!
//! A category matches when it accepts the add method and every one of its
//! triggers passes; the lowest `order` wins. Triggers cover the extension, the
//! total size, a URL glob and a file-name glob.
//!
//! The BitTorrent-era keys (`automation`, `watch_folders`, ...) are not
//! interpreted, but `Category::legacy` keeps them, so the document round-trips
//! and a later port needs no migration.

use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{MoinError, MoinResult};
use crate::models::{filename_from_url, sanitize_filename, AddMethodKind, Category, Trigger};
use crate::paths;

const FILE_NAME: &str = "categories.json";
const DOCUMENT_VERSION: u32 = 1;
/// Default categories are numbered 10/20/30 so a rule can be slipped between
/// two of them without renumbering the file.
const ORDER_STEP: i32 = 10;

/// What the caller knows about a download before it starts: enough to run every
/// trigger without touching the network.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Candidate {
    pub url: String,
    pub add_method: AddMethodKind,
    pub filename: String,
    pub extension: Option<String>,
    pub size: Option<u64>,
}

impl Candidate {
    pub fn from_url(url: &str, add_method: AddMethodKind) -> Self {
        Self::from_url_named(url, add_method, None)
    }

    /// A supplied name wins over the one in the URL; a name that sanitises to
    /// nothing (empty, only dots) falls back to the URL.
    pub fn from_url_named(url: &str, add_method: AddMethodKind, filename: Option<&str>) -> Self {
        let filename = filename
            .and_then(sanitize_filename)
            .unwrap_or_else(|| filename_from_url(url));
        Self {
            extension: extension_of(&filename),
            url: url.to_string(),
            add_method,
            filename,
            size: None,
        }
    }
}

/// Lowercase extension without the dot. Query strings and fragments are
/// stripped, a leading dot (`.bashrc`) is not an extension, and `archive.tar.gz`
/// yields `gz`.
pub fn extension_of(path: &str) -> Option<String> {
    let name = path.rsplit(['/', '\\']).next().unwrap_or(path);
    let name = name.split(['?', '#']).next().unwrap_or(name);
    let (stem, extension) = name.rsplit_once('.')?;
    if stem.is_empty() || extension.is_empty() {
        return None;
    }
    Some(extension.to_ascii_lowercase())
}

/// Hand-written glob with `*` and `?`, case-insensitive. A pattern without a
/// wildcard degrades to a substring test, which is what a user typing `report`
/// means.
pub fn glob_match(pattern: &str, text: &str) -> bool {
    let pattern = pattern.to_lowercase();
    let text = text.to_lowercase();
    if !pattern.contains(['*', '?']) {
        return text.contains(&pattern);
    }
    let (mut p, mut t, mut star, mut retry) = (0usize, 0usize, None, 0usize);
    let pattern = pattern.as_bytes();
    let text = text.as_bytes();
    while t < text.len() {
        if p < pattern.len() && (pattern[p] == b'?' || pattern[p] == text[t]) {
            p += 1;
            t += 1;
        } else if p < pattern.len() && pattern[p] == b'*' {
            star = Some(p);
            p += 1;
            retry = t;
        } else if let Some(star_position) = star {
            p = star_position + 1;
            retry += 1;
            t = retry;
        } else {
            return false;
        }
    }
    while p < pattern.len() && pattern[p] == b'*' {
        p += 1;
    }
    p == pattern.len()
}

impl Trigger {
    pub fn matches(&self, candidate: &Candidate) -> bool {
        match self {
            Trigger::Extension { exts } => candidate.extension.as_ref().is_some_and(|extension| {
                exts.iter().any(|expected| {
                    expected
                        .trim_start_matches('.')
                        .eq_ignore_ascii_case(extension)
                })
            }),
            // A size rule cannot be decided before the server reports the
            // length, so an unknown size never matches (source behaviour).
            Trigger::Size { min, max } => candidate.size.is_some_and(|size| {
                min.is_none_or(|min| size >= min) && max.is_none_or(|max| size <= max)
            }),
            Trigger::UrlPattern { patterns } => patterns
                .iter()
                .any(|pattern| glob_match(pattern, &candidate.url)),
            Trigger::NamePattern { patterns } => patterns
                .iter()
                .any(|pattern| glob_match(pattern, &candidate.filename)),
        }
    }
}

/// The first category by `order` whose source and triggers all accept the
/// candidate. An empty `sources` accepts every add method; an empty `triggers`
/// list therefore makes a category a catch-all.
pub fn categorize(candidate: &Candidate, categories: &[Category]) -> Option<String> {
    categories
        .iter()
        .filter(|category| {
            category.sources.is_empty() || category.sources.contains(&candidate.add_method)
        })
        .filter(|category| {
            category
                .triggers
                .iter()
                .all(|trigger| trigger.matches(candidate))
        })
        .min_by_key(|category| category.order)
        .map(|category| category.id.clone())
}

/// The three categories a fresh install starts with. Rules are extension-only,
/// so nothing is guessed before the download begins.
pub fn defaults() -> Vec<Category> {
    [
        ("documents", "Documents", "#378ADD", 10, ["doc", "pdf", "epub", "txt", "md"]),
        ("videos", "Videos", "#D4537E", 20, ["mp4", "mkv", "avi", "mov", "webm"]),
        ("archives", "Archives", "#BA7517", 30, ["zip", "7z", "rar", "tar", "gz"]),
    ]
    .into_iter()
    .map(|(id, name, color, order, exts)| Category {
        id: id.to_string(),
        name: name.to_string(),
        color: color.to_string(),
        icon: None,
        hidden_from_all: false,
        save_dir: None,
        incomplete_dir: None,
        sources: Vec::new(),
        triggers: vec![Trigger::Extension {
            exts: exts.iter().map(|ext| (*ext).to_string()).collect(),
        }],
        order,
        legacy: BTreeMap::new(),
    })
    .collect()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CategoryDocument {
    #[serde(default = "document_version")]
    version: u32,
    #[serde(default)]
    categories: Vec<Category>,
}

fn document_version() -> u32 {
    DOCUMENT_VERSION
}

fn path(dir: &Path) -> PathBuf {
    dir.join(FILE_NAME)
}

fn directory_of(path: &Path) -> &Path {
    path.parent().unwrap_or_else(|| Path::new("."))
}

fn sorted(mut categories: Vec<Category>) -> Vec<Category> {
    categories.sort_by_key(|category| category.order);
    categories
}

/// `None` means "there is no usable document": missing, unreadable or corrupt.
/// A corrupt file is moved aside first, so the caller can seed a new one
/// without losing what the user had.
fn read_document(path: &Path) -> Option<Vec<Category>> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) => {
            if error.kind() != std::io::ErrorKind::NotFound {
                log::warn!("Could not read the moin categories at {}: {error}", path.display());
            }
            return None;
        }
    };
    let mut value: serde_json::Value = match serde_json::from_slice(&bytes) {
        Ok(value) => value,
        Err(error) => {
            paths::backup_corrupt(path);
            log::warn!(
                "Replaced unreadable moin categories at {} with the defaults (line {}, column {}).",
                path.display(),
                error.line(),
                error.column()
            );
            return None;
        }
    };
    normalize_legacy_sources(&mut value);
    match serde_json::from_value::<CategoryDocument>(value) {
        Ok(document) => Some(sorted(document.categories)),
        Err(error) => {
            paths::backup_corrupt(path);
            log::warn!(
                "Replaced unreadable moin categories at {} with the defaults ({error}).",
                path.display()
            );
            None
        }
    }
}

/// The BitTorrent build wrote `manual-torrent`, `watch-folder` and
/// `watch-url-file` into `sources`. They must not make the whole document
/// unreadable, so they are mapped onto the closest surviving add method and
/// anything else is dropped.
fn normalize_legacy_sources(document: &mut serde_json::Value) {
    let Some(categories) = document
        .get_mut("categories")
        .and_then(|value| value.as_array_mut())
    else {
        return;
    };
    for category in categories {
        let Some(sources) = category
            .get_mut("sources")
            .and_then(|value| value.as_array_mut())
        else {
            continue;
        };
        sources.retain_mut(|source| {
            let Some(name) = source.as_str() else {
                return false;
            };
            let mapped = match name {
                "manual-link" => "manual-link",
                "browser-capture" => "browser-capture",
                // A torrent added by hand is still a manual add.
                "manual-torrent" => "manual-link",
                // A watched folder or URL list is an automatic capture.
                "watch-folder" | "watch-url-file" => "browser-capture",
                _ => return false,
            };
            *source = serde_json::Value::String(mapped.to_string());
            true
        });
    }
}

/// Read-only view: a missing or corrupt document yields the defaults but leaves
/// the file alone. Use [`load_or_seed`] when the caller wants a file on disk.
#[allow(dead_code)] // Frozen API: the engine only takes the seeding path.
pub fn load(dir: &Path) -> Vec<Category> {
    read_document(&path(dir)).unwrap_or_else(defaults)
}

/// The startup path: seed the defaults when there is no usable document, so the
/// user always has something to edit.
pub fn load_or_seed(dir: &Path) -> Vec<Category> {
    if let Some(categories) = read_document(&path(dir)) {
        return categories;
    }
    let seeded = defaults();
    if let Err(error) = save(&seeded, dir) {
        log::warn!(
            "Could not write the default moin categories to {}: {error}",
            path(dir).display()
        );
    }
    seeded
}

pub fn save(categories: &[Category], dir: &Path) -> MoinResult<()> {
    let document = CategoryDocument {
        version: DOCUMENT_VERSION,
        categories: sorted(categories.to_vec()),
    };
    let bytes = serde_json::to_vec_pretty(&document).map_err(|error| {
        MoinError::internal(format!("Could not encode the moin categories: {error}"))
    })?;
    paths::write_atomic(&path(dir), &bytes)
}

/// The engine keeps one list in memory behind a `std::sync::Mutex` and edits it
/// through these methods; the free functions above are the stateless view of the
/// same document. The lock is never held across an `.await`.
#[derive(Debug, Clone, Default)]
pub(crate) struct CategoryStore {
    categories: Vec<Category>,
}

impl CategoryStore {
    pub fn load(path: &Path) -> Self {
        Self {
            categories: load_or_seed(directory_of(path)),
        }
    }

    pub fn list(&self) -> Vec<Category> {
        sorted(self.categories.clone())
    }

    pub fn suggest(
        &self,
        url: &str,
        filename: Option<&str>,
        source: AddMethodKind,
        size: Option<u64>,
    ) -> Option<String> {
        let mut candidate = Candidate::from_url_named(url, source, filename);
        candidate.size = size;
        categorize(&candidate, &self.categories)
    }

    pub fn get(&self, id: &str) -> Option<Category> {
        self.categories
            .iter()
            .find(|category| category.id == id)
            .cloned()
    }

    pub fn upsert(&mut self, path: &Path, mut category: Category) -> MoinResult<Vec<Category>> {
        let previous = self.categories.clone();
        category.name = category.name.trim().to_string();
        if category.name.is_empty() || category.name.len() > 128 {
            return Err(MoinError::invalid_input(
                "category.name",
                "Names must contain 1 to 128 characters.",
            ));
        }
        if category
            .save_dir
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty() && !Path::new(value).is_absolute())
            || category
                .incomplete_dir
                .as_deref()
                .is_some_and(|value| !value.trim().is_empty() && !Path::new(value).is_absolute())
        {
            return Err(MoinError::invalid_input(
                "category.directory",
                "Category directories must be absolute paths.",
            ));
        }
        for trigger in &category.triggers {
            if let Trigger::Size {
                min: Some(min),
                max: Some(max),
            } = trigger
            {
                if min > max {
                    return Err(MoinError::invalid_input(
                        "category.trigger",
                        "The minimum size cannot exceed the maximum.",
                    ));
                }
            }
        }
        if self.categories.iter().any(|existing| {
            existing.id != category.id && existing.name.eq_ignore_ascii_case(&category.name)
        }) {
            return Err(MoinError::conflict("A category with that name already exists."));
        }
        if let Some(current) = self
            .categories
            .iter_mut()
            .find(|existing| existing.id == category.id)
        {
            // The editor sends the fields it knows about; the opaque BitTorrent
            // keys stay with the stored record.
            category.legacy = current.legacy.clone();
            *current = category;
        } else {
            if category.id.trim().is_empty() {
                return Err(MoinError::invalid_input(
                    "category.id",
                    "A category id is required.",
                ));
            }
            self.categories.push(category);
        }
        self.normalize_order();
        if let Err(error) = self.save(path) {
            self.categories = previous;
            return Err(error);
        }
        Ok(self.list())
    }

    pub fn delete(&mut self, path: &Path, id: &str) -> MoinResult<Vec<Category>> {
        let previous = self.categories.clone();
        let before = self.categories.len();
        self.categories.retain(|category| category.id != id);
        if self.categories.len() == before {
            return Err(MoinError::not_found("category", id));
        }
        self.normalize_order();
        if let Err(error) = self.save(path) {
            self.categories = previous;
            return Err(error);
        }
        Ok(self.list())
    }

    pub fn reorder(&mut self, path: &Path, ids: &[String]) -> MoinResult<Vec<Category>> {
        let previous = self.categories.clone();
        if ids.len() != self.categories.len() {
            return Err(MoinError::invalid_input(
                "category.order",
                "The order must include every category exactly once.",
            ));
        }
        let mut seen = HashSet::new();
        if ids.iter().any(|id| {
            !seen.insert(id.as_str())
                || !self.categories.iter().any(|category| &category.id == id)
        }) {
            return Err(MoinError::invalid_input(
                "category.order",
                "The order contains an unknown or duplicate category.",
            ));
        }
        for (position, id) in ids.iter().enumerate() {
            if let Some(category) = self
                .categories
                .iter_mut()
                .find(|category| &category.id == id)
            {
                category.order = (position as i32 + 1) * ORDER_STEP;
            }
        }
        if let Err(error) = self.save(path) {
            self.categories = previous;
            return Err(error);
        }
        Ok(self.list())
    }

    fn normalize_order(&mut self) {
        self.categories.sort_by_key(|category| category.order);
        for (position, category) in self.categories.iter_mut().enumerate() {
            category.order = (position as i32 + 1) * ORDER_STEP;
        }
    }

    fn save(&self, path: &Path) -> MoinResult<()> {
        save(&self.list(), directory_of(path))
    }
}

#[cfg(test)]
mod tests {
    use super::{
        categorize, defaults, extension_of, glob_match, load, load_or_seed, save, Candidate,
        CategoryStore,
    };
    use crate::models::{AddMethodKind, Category, Trigger};

    fn file(dir: &std::path::Path) -> std::path::PathBuf {
        dir.join("categories.json")
    }

    fn backed_up(dir: &std::path::Path) -> bool {
        std::fs::read_dir(dir).unwrap().flatten().any(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .starts_with("categories.json.bak-")
        })
    }

    #[test]
    fn extracts_lowercase_extensions() {
        assert_eq!(extension_of("a/B.ZIP").as_deref(), Some("zip"));
        assert_eq!(extension_of("https://example.test/a.tar.gz?x=1").as_deref(), Some("gz"));
        assert_eq!(extension_of("https://example.test/folder"), None);
        assert_eq!(extension_of("archive."), None);
        assert_eq!(extension_of(".bashrc"), None);
    }

    #[test]
    fn glob_matches_star_question_and_plain_substrings() {
        assert!(glob_match("*", "anything"));
        assert!(glob_match("*.zip", "backup.ZIP"));
        assert!(!glob_match("*.zip", "backup.7z"));
        assert!(glob_match("file?.bin", "file1.bin"));
        assert!(!glob_match("file?.bin", "file12.bin"));
        assert!(glob_match("example.com", "https://example.com/a.bin"));
        assert!(!glob_match("example.org", "https://example.com/a.bin"));
    }

    #[test]
    fn extension_triggers_hit_and_miss() {
        let categories = defaults();
        let hit = Candidate::from_url("https://example.test/movie.MKV", AddMethodKind::ManualLink);
        assert_eq!(hit.extension.as_deref(), Some("mkv"));
        assert_eq!(categorize(&hit, &categories).as_deref(), Some("videos"));

        let miss = Candidate::from_url("https://example.test/page.html", AddMethodKind::ManualLink);
        assert_eq!(categorize(&miss, &categories), None);
    }

    #[test]
    fn the_lowest_order_wins() {
        let mut categories = defaults();
        let mut early = categories[2].clone();
        early.id = "early".to_string();
        early.name = "Early".to_string();
        early.order = 5;
        categories.push(early);

        let candidate =
            Candidate::from_url("https://example.test/data.zip", AddMethodKind::ManualLink);
        assert_eq!(categorize(&candidate, &categories).as_deref(), Some("early"));
    }

    #[test]
    fn empty_sources_accept_every_add_method() {
        let categories = defaults();
        for method in [AddMethodKind::ManualLink, AddMethodKind::BrowserCapture] {
            let candidate = Candidate::from_url("https://example.test/guide.pdf", method);
            assert_eq!(
                categorize(&candidate, &categories).as_deref(),
                Some("documents")
            );
        }
    }

    #[test]
    fn sources_that_exclude_the_add_method_do_not_match() {
        let mut categories = defaults();
        categories[0].sources = vec![AddMethodKind::BrowserCapture];

        let manual = Candidate::from_url("https://example.test/guide.pdf", AddMethodKind::ManualLink);
        assert_eq!(categorize(&manual, &categories), None);
        let capture =
            Candidate::from_url("https://example.test/guide.pdf", AddMethodKind::BrowserCapture);
        assert_eq!(
            categorize(&capture, &categories).as_deref(),
            Some("documents")
        );
    }

    #[test]
    fn size_triggers_need_a_known_size() {
        let mut category = defaults().remove(0);
        category.triggers = vec![Trigger::Size {
            min: Some(1),
            max: None,
        }];
        let categories = vec![category];
        let mut candidate =
            Candidate::from_url("https://example.test/guide.pdf", AddMethodKind::ManualLink);
        assert_eq!(categorize(&candidate, &categories), None);
        candidate.size = Some(10);
        assert_eq!(
            categorize(&candidate, &categories).as_deref(),
            Some("documents")
        );
    }

    #[test]
    fn every_trigger_has_to_pass() {
        let mut category = defaults().remove(0);
        category.triggers.push(Trigger::UrlPattern {
            patterns: vec!["example.org".to_string()],
        });
        let categories = vec![category];
        let candidate = Candidate::from_url("https://example.test/guide.pdf", AddMethodKind::ManualLink);
        assert_eq!(categorize(&candidate, &categories), None);
    }

    #[test]
    fn seeds_the_three_defaults_when_the_document_is_missing() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(load(dir.path()).len(), 3);
        assert!(!file(dir.path()).exists(), "load must not write");

        let seeded = load_or_seed(dir.path());
        assert_eq!(
            seeded.iter().map(|category| category.id.as_str()).collect::<Vec<_>>(),
            ["documents", "videos", "archives"]
        );
        assert_eq!(
            seeded.iter().map(|category| category.order).collect::<Vec<_>>(),
            [10, 20, 30]
        );
        assert!(file(dir.path()).exists());
    }

    #[test]
    fn corrupt_document_is_backed_up_and_reseeded() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(file(dir.path()), "{ \"categories\": [").unwrap();
        let categories = load_or_seed(dir.path());
        assert_eq!(categories.len(), 3);
        assert!(backed_up(dir.path()));
        let written: serde_json::Value =
            serde_json::from_slice(&std::fs::read(file(dir.path())).unwrap()).unwrap();
        assert_eq!(written["version"], serde_json::json!(1));
        assert_eq!(written["categories"].as_array().unwrap().len(), 3);
    }

    #[test]
    fn bit_torrent_era_fields_round_trip_verbatim() {
        let dir = tempfile::tempdir().unwrap();
        let raw = r##"{
          "version": 1,
          "categories": [{
            "id": "movies",
            "name": "Movies",
            "color": "#123456",
            "order": 10,
            "sources": ["manual-torrent", "browser-capture"],
            "triggers": [{ "type": "extension", "exts": ["mkv"] }],
            "automation": { "rename": true },
            "watch_folders": ["D:/watch"],
            "capture_torrent_downloads": true,
            "icon_color": "#abcdef",
            "effects_color": null,
            "seed_ratio_limit": 2.0,
            "seed_time_limit_mins": 120,
            "torrent_file_dir": "D:/torrents",
            "torrent_file_done_dir": "D:/torrents/done",
            "fallback_download": false
          }]
        }"##;
        std::fs::write(file(dir.path()), raw).unwrap();

        let categories = load(dir.path());
        assert_eq!(categories.len(), 1);
        // Legacy add-method values map onto the surviving variants instead of
        // failing the whole document.
        assert_eq!(
            categories[0].sources,
            vec![AddMethodKind::ManualLink, AddMethodKind::BrowserCapture]
        );

        save(&categories, dir.path()).unwrap();
        let written: serde_json::Value =
            serde_json::from_slice(&std::fs::read(file(dir.path())).unwrap()).unwrap();
        let category = &written["categories"][0];
        for key in [
            "automation",
            "watch_folders",
            "capture_torrent_downloads",
            "icon_color",
            "effects_color",
            "seed_ratio_limit",
            "seed_time_limit_mins",
            "torrent_file_dir",
            "torrent_file_done_dir",
            "fallback_download",
        ] {
            assert!(category.get(key).is_some(), "{key} must survive a round trip");
        }
        assert_eq!(category["automation"], serde_json::json!({ "rename": true }));
        assert_eq!(category["seed_ratio_limit"], serde_json::json!(2.0));
        assert_eq!(category["effects_color"], serde_json::Value::Null);
    }

    #[test]
    fn legacy_add_methods_do_not_break_the_document() {
        let dir = tempfile::tempdir().unwrap();
        let raw = r##"{
          "version": 1,
          "categories": [{
            "id": "watched",
            "name": "Watched",
            "sources": ["watch-folder", "watch-url-file", "manual-torrent", "something-new"],
            "triggers": []
          }]
        }"##;
        std::fs::write(file(dir.path()), raw).unwrap();
        let categories = load(dir.path());
        assert_eq!(categories.len(), 1);
        assert_eq!(
            categories[0].sources,
            vec![
                AddMethodKind::BrowserCapture,
                AddMethodKind::BrowserCapture,
                AddMethodKind::ManualLink,
            ]
        );
        assert!(!backed_up(dir.path()), "a legacy value is not a corrupt file");
    }

    #[test]
    fn category_store_roundtrips_unknown_fields_and_matches_rules() {
        let dir = tempfile::tempdir().unwrap();
        let path = file(dir.path());
        let mut store = CategoryStore::default();
        let mut category = defaults().remove(0);
        category
            .legacy
            .insert("automation".to_string(), serde_json::json!({ "future": true }));
        store.upsert(&path, category).unwrap();
        assert_eq!(
            store
                .suggest("https://example.test/guide.pdf", None, AddMethodKind::ManualLink, None)
                .as_deref(),
            Some("documents")
        );
        let reloaded = CategoryStore::load(&path);
        assert!(reloaded.list()[0].legacy.contains_key("automation"));
    }

    #[test]
    fn duplicate_names_and_relative_directories_are_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let path = file(dir.path());
        let mut store = CategoryStore::default();
        let mut first = defaults().remove(0);
        first.id = "one".to_string();
        first.name = "One".to_string();
        store.upsert(&path, first).unwrap();

        let mut duplicate: Category = defaults().remove(0);
        duplicate.id = "two".to_string();
        duplicate.name = "one".to_string();
        assert_eq!(
            store.upsert(&path, duplicate).unwrap_err().code,
            crate::MoinErrorCode::Conflict
        );

        let mut relative = defaults().remove(0);
        relative.id = "three".to_string();
        relative.name = "Three".to_string();
        relative.save_dir = Some("relative/path".to_string());
        assert_eq!(
            store.upsert(&path, relative).unwrap_err().code,
            crate::MoinErrorCode::InvalidInput
        );
    }
}
