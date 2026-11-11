// Adapted from moin (MIT), https://github.com/exxvius/moin at 79e7587.
// See `UPSTREAM.md` for the porting record.

//! Category rules: matching, validation and the `categories.json` document.
//!
//! The BitTorrent-only automation (exclude/layout/rename/watch folders) is not
//! ported, but unknown keys on a category are kept in `Category::legacy` and
//! written back untouched so a later port needs no data migration.

use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::{MoinError, MoinResult};
use crate::models::{AddMethodKind, Category, Trigger};
use crate::paths;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CategoryDocument {
    version: u32,
    categories: Vec<Category>,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct CategoryStore {
    categories: Vec<Category>,
}

impl CategoryStore {
    pub fn load(path: &Path) -> Self {
        let Ok(bytes) = fs::read(path) else {
            return Self { categories: defaults() };
        };
        match serde_json::from_slice::<CategoryDocument>(&bytes) {
            Ok(mut document) => {
                document.categories.sort_by_key(|category| category.order);
                Self { categories: document.categories }
            }
            Err(error) => {
                paths::backup_corrupt(path);
                log::warn!("Invalid moin categories were replaced with defaults: {error}");
                Self { categories: defaults() }
            }
        }
    }

    pub fn list(&self) -> Vec<Category> {
        let mut categories = self.categories.clone();
        categories.sort_by_key(|category| category.order);
        categories
    }

    /// The first category (by `order`) whose triggers match wins. A category
    /// without `sources` accepts every add method.
    pub fn suggest(
        &self,
        url: &str,
        filename: Option<&str>,
        source: AddMethodKind,
        size: Option<u64>,
    ) -> Option<String> {
        self.categories
            .iter()
            .filter(|category| category.sources.is_empty() || category.sources.contains(&source))
            .filter(|category| {
                category
                    .triggers
                    .iter()
                    .any(|trigger| matches_trigger(trigger, url, filename, size))
            })
            .min_by_key(|category| category.order)
            .map(|category| category.id.clone())
    }

    pub fn get(&self, id: &str) -> Option<Category> {
        self.categories.iter().find(|category| category.id == id).cloned()
    }

    pub fn upsert(&mut self, path: &Path, mut category: Category) -> MoinResult<Vec<Category>> {
        let previous = self.categories.clone();
        category.name = category.name.trim().to_string();
        if category.name.is_empty() || category.name.len() > 128 {
            return Err(MoinError::invalid_input("category.name", "Names must contain 1 to 128 characters."));
        }
        if category.save_dir.as_deref().is_some_and(|value| !value.trim().is_empty() && !Path::new(value).is_absolute())
            || category.incomplete_dir.as_deref().is_some_and(|value| !value.trim().is_empty() && !Path::new(value).is_absolute())
        {
            return Err(MoinError::invalid_input("category.directory", "Category directories must be absolute paths."));
        }
        for trigger in &category.triggers {
            if let Trigger::Size { min: Some(min), max: Some(max) } = trigger {
                if min > max {
                    return Err(MoinError::invalid_input("category.trigger", "The minimum size cannot exceed the maximum."));
                }
            }
        }
        if self
            .categories
            .iter()
            .any(|existing| existing.id != category.id && existing.name.eq_ignore_ascii_case(&category.name))
        {
            return Err(MoinError::conflict("A category with that name already exists."));
        }
        if let Some(current) = self.categories.iter_mut().find(|existing| existing.id == category.id) {
            category.legacy = current.legacy.clone();
            *current = category;
        } else {
            if category.id.trim().is_empty() {
                return Err(MoinError::invalid_input("category.id", "A category id is required."));
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
            return Err(MoinError::invalid_input("category.order", "The order must include every category exactly once."));
        }
        let mut seen = HashSet::new();
        if ids
            .iter()
            .any(|id| !seen.insert(id.as_str()) || !self.categories.iter().any(|category| &category.id == id))
        {
            return Err(MoinError::invalid_input("category.order", "The order contains an unknown or duplicate category."));
        }
        for (order, id) in ids.iter().enumerate() {
            if let Some(category) = self.categories.iter_mut().find(|category| &category.id == id) {
                category.order = order as i32;
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
        for (index, category) in self.categories.iter_mut().enumerate() {
            category.order = index as i32;
        }
    }

    fn save(&self, path: &Path) -> MoinResult<()> {
        let document = CategoryDocument { version: 1, categories: self.list() };
        let bytes = serde_json::to_vec_pretty(&document)
            .map_err(|error| MoinError::internal(error.to_string()))?;
        paths::write_atomic(path, &bytes)
    }
}

pub fn defaults() -> Vec<Category> {
    [
        ("documents", "Documents", "#378ADD", vec!["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "md"]),
        ("videos", "Videos", "#D4537E", vec!["mp4", "mkv", "mov", "avi", "webm"]),
        ("archives", "Archives", "#BA7517", vec!["zip", "7z", "rar", "tar", "gz"]),
    ]
    .into_iter()
    .enumerate()
    .map(|(order, (id, name, color, exts))| Category {
        id: id.to_string(),
        name: name.to_string(),
        color: color.to_string(),
        icon: None,
        hidden_from_all: false,
        save_dir: None,
        incomplete_dir: None,
        sources: Vec::new(),
        triggers: vec![Trigger::Extension { exts: exts.into_iter().map(str::to_string).collect() }],
        order: order as i32,
        legacy: BTreeMap::new(),
    })
    .collect()
}

fn matches_trigger(trigger: &Trigger, url: &str, filename: Option<&str>, size: Option<u64>) -> bool {
    match trigger {
        Trigger::Extension { exts } => filename
            .or_else(|| url.rsplit('/').next())
            .and_then(|name| name.split('?').next())
            .and_then(|name| name.rsplit('.').next())
            .is_some_and(|extension| {
                exts.iter()
                    .any(|candidate| candidate.trim_start_matches('.').eq_ignore_ascii_case(extension))
            }),
        Trigger::Size { min, max } => size.is_some_and(|value| {
            min.is_none_or(|min| value >= min) && max.is_none_or(|max| value <= max)
        }),
        Trigger::UrlPattern { patterns } => patterns.iter().any(|pattern| glob_match(pattern, url)),
        Trigger::NamePattern { patterns } => {
            filename.is_some_and(|name| patterns.iter().any(|pattern| glob_match(pattern, name)))
        }
    }
}

/// Hand-written glob with `*` and `?`. A pattern without wildcards degrades to a
/// case-insensitive substring test, which is what a user typing `report` means.
fn glob_match(pattern: &str, value: &str) -> bool {
    let pattern = pattern.to_lowercase();
    let value = value.to_lowercase();
    if !pattern.contains(['*', '?']) {
        return value.contains(&pattern);
    }
    let (mut p, mut v, mut star, mut retry) = (0usize, 0usize, None, 0usize);
    let pattern = pattern.as_bytes();
    let value = value.as_bytes();
    while v < value.len() {
        if p < pattern.len() && (pattern[p] == b'?' || pattern[p] == value[v]) {
            p += 1;
            v += 1;
        } else if p < pattern.len() && pattern[p] == b'*' {
            star = Some(p);
            p += 1;
            retry = v;
        } else if let Some(star_position) = star {
            p = star_position + 1;
            retry += 1;
            v = retry;
        } else {
            return false;
        }
    }
    while p < pattern.len() && pattern[p] == b'*' {
        p += 1;
    }
    p == pattern.len()
}

#[cfg(test)]
mod tests {
    use super::{glob_match, CategoryStore};
    use crate::models::AddMethodKind;

    #[test]
    fn glob_matches_question_and_star() {
        assert!(glob_match("*.zip", "backup.ZIP"));
        assert!(glob_match("file?.bin", "file1.bin"));
        assert!(!glob_match("file?.bin", "file12.bin"));
        assert!(glob_match("example.com", "https://example.com/a.bin"));
    }

    #[test]
    fn category_store_roundtrips_unknown_fields_and_matches_rules() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("categories.json");
        let mut store = CategoryStore::default();
        let mut category = super::defaults().remove(0);
        category.legacy.insert("automation".into(), serde_json::json!({"future": true}));
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
        let path = dir.path().join("categories.json");
        let mut store = CategoryStore::default();
        let mut first = super::defaults().remove(0);
        first.id = "one".into();
        first.name = "One".into();
        store.upsert(&path, first).unwrap();

        let mut duplicate = super::defaults().remove(0);
        duplicate.id = "two".into();
        duplicate.name = "one".into();
        assert_eq!(store.upsert(&path, duplicate).unwrap_err().code, crate::MoinErrorCode::Conflict);

        let mut relative = super::defaults().remove(0);
        relative.id = "three".into();
        relative.name = "Three".into();
        relative.save_dir = Some("relative/path".into());
        assert_eq!(store.upsert(&path, relative).unwrap_err().code, crate::MoinErrorCode::InvalidInput);
    }
}
