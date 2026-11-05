//! Prism rule files: the `.prism.yaml` patches the engine scans.
//!
//! A file is either active (`foo.prism.yaml`) or parked
//! (`foo.prism.yaml.disabled`); toggling is a rename, which is exactly what the
//! engine's `skip_disabled_patches` already understands.

use serde::{Deserialize, Serialize};

use crate::store;

const EXT: &str = ".prism.yaml";
const DISABLED: &str = ".disabled";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleFileInfo {
    /// Base name, without the `.disabled` suffix: `ad-filter.prism.yaml`.
    pub filename: String,
    pub rule_count: usize,
    /// Detected dialect of the rules in the file: clash / surge / unknown / empty.
    pub source: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuleGroupEntry {
    pub name: String,
    pub files: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct RuleGroups {
    pub groups: Vec<RuleGroupEntry>,
}

const NEW_RULE_FILE: &str = r#"# Prism patch file.
# Operations: $override / $prepend / $append / $filter / $transform / $remove / $default.
# Condition metadata: __when__ / __after__ / __vars__.
rules:
  $append:
    - DOMAIN-SUFFIX,example.com,{{proxy}}
"#;

pub fn list() -> Result<Vec<RuleFileInfo>, String> {
    let dir = store::prism_dir()?;
    let mut files = Vec::new();
    let entries = std::fs::read_dir(&dir).map_err(|e| format!("Failed to read Prism directory: {e}"))?;

    for entry in entries.flatten() {
        if !entry.path().is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        let (filename, enabled) = match name.strip_suffix(DISABLED) {
            Some(base) if base.ends_with(EXT) => (base.to_string(), false),
            _ if name.ends_with(EXT) => (name.clone(), true),
            _ => continue,
        };
        let content = std::fs::read_to_string(entry.path()).unwrap_or_default();
        files.push(RuleFileInfo {
            rule_count: count_rules(&content),
            source: detect_source(&content).to_string(),
            enabled,
            filename,
        });
    }

    files.sort_by(|a, b| a.filename.to_lowercase().cmp(&b.filename.to_lowercase()));
    Ok(files)
}

pub fn read(filename: &str) -> Result<String, String> {
    let path = existing(filename)?;
    std::fs::read_to_string(&path).map_err(|e| format!("Failed to read {}: {e}", path.display()))
}

pub fn write(filename: &str, content: &str) -> Result<(), String> {
    let path = existing(filename)?;
    store::atomic_write(&path, content)
}

pub fn create(name: &str) -> Result<String, String> {
    let filename = to_filename(name)?;
    let path = store::prism_dir()?.join(&filename);
    if path.exists() {
        return Err(format!("{filename} already exists"));
    }
    store::atomic_write(&path, NEW_RULE_FILE)?;
    Ok(filename)
}

pub fn delete(filename: &str) -> Result<(), String> {
    let path = existing(filename)?;
    std::fs::remove_file(&path).map_err(|e| format!("Failed to delete {}: {e}", path.display()))?;
    forget_file(filename)
}

pub fn rename(filename: &str, new_name: &str) -> Result<String, String> {
    let path = existing(filename)?;
    let target_name = to_filename(new_name)?;
    if target_name == filename {
        return Ok(target_name);
    }
    let target = store::prism_dir()?.join(&target_name);
    if target.exists() {
        return Err(format!("{target_name} already exists"));
    }
    std::fs::rename(&path, &target).map_err(|e| format!("Failed to rename: {e}"))?;
    forget_file(filename)?;
    Ok(target_name)
}

pub fn toggle(filename: &str, enabled: bool) -> Result<bool, String> {
    let path = existing(filename)?;
    let current = path.to_string_lossy();
    let target = if enabled {
        std::path::PathBuf::from(current.strip_suffix(DISABLED).unwrap_or(&current))
    } else {
        std::path::PathBuf::from(format!("{current}{DISABLED}"))
    };
    if target == path {
        return Ok(true);
    }
    std::fs::rename(&path, &target).map_err(|e| format!("Failed to toggle state: {e}"))?;
    Ok(true)
}

/// Turn pasted Surge / Clash rule lines into a Prism patch file.
///
/// Imports never overwrite: a name already in use gets a counter appended, so
/// pasting a second batch cannot destroy the first one.
pub fn import_text(name: &str, content: &str) -> Result<String, String> {
    let normalized = normalize_to_prism_yaml(content);
    if normalized.is_empty() {
        return Err("No rules to import".to_string());
    }
    let dir = store::prism_dir()?;
    let mut filename = to_filename(name)?;
    let mut counter = 2;
    while dir.join(&filename).exists() {
        let stem = filename.trim_end_matches(EXT);
        filename = to_filename(&format!("{stem} {counter}"))?;
        counter += 1;
    }
    store::atomic_write(&dir.join(&filename), &normalized)?;
    Ok(filename)
}

pub fn read_groups() -> Result<RuleGroups, String> {
    let path = store::prism_dir()?.join("groups.json");
    match std::fs::read_to_string(&path) {
        Ok(text) => Ok(serde_json::from_str(&text).unwrap_or_default()),
        Err(_) => Ok(RuleGroups::default()),
    }
}

pub fn save_groups(groups: &RuleGroups) -> Result<(), String> {
    let path = store::prism_dir()?.join("groups.json");
    let text =
        serde_json::to_string_pretty(groups).map_err(|e| format!("Failed to serialize groups: {e}"))?;
    store::atomic_write(&path, &text)
}

/// Drop the file from every group when it disappears, so `groups.json` cannot
/// keep pointing at files that are gone.
fn forget_file(filename: &str) -> Result<(), String> {
    let mut groups = read_groups()?;
    let before: usize = groups.groups.iter().map(|group| group.files.len()).sum();
    groups.groups.retain_mut(|group| {
        group.files.retain(|file| file != filename);
        !group.files.is_empty()
    });
    let after: usize = groups.groups.iter().map(|group| group.files.len()).sum();
    if after != before {
        save_groups(&groups)?;
    }
    Ok(())
}

fn existing(filename: &str) -> Result<std::path::PathBuf, String> {
    let dir = store::prism_dir()?;
    let path = dir.join(filename);
    if path.is_file() {
        Ok(path)
    } else {
        let disabled = dir.join(format!("{filename}{DISABLED}"));
        if disabled.is_file() {
            Ok(disabled)
        } else {
            Err(format!("{filename} does not exist"))
        }
    }
}

fn to_filename(name: &str) -> Result<String, String> {
    let base = name
        .trim()
        .trim_end_matches(DISABLED)
        .trim_end_matches(EXT)
        .trim_end_matches(".yml");
    let safe = store::sanitize_name(base)?;
    Ok(format!("{safe}{EXT}"))
}

/// Count rule lines under `rules:`, in either a plain list or an `$append`.
pub fn count_rules(content: &str) -> usize {
    let mut in_rules = false;
    let mut count = 0usize;
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed == "rules:" {
            in_rules = true;
            continue;
        }
        if in_rules {
            if trimmed.starts_with("- ") && trimmed.contains(',') {
                count += 1;
            } else if !trimmed.starts_with('#')
                && !trimmed.is_empty()
                && !trimmed.starts_with('-')
                && !trimmed.starts_with('$')
            {
                in_rules = false;
            }
        }
    }
    count
}

pub fn detect_source(content: &str) -> &'static str {
    let trimmed = content.trim();
    if trimmed.is_empty() {
        return "empty";
    }

    let mut surge = 0usize;
    let mut clash = 0usize;
    for line in trimmed.lines() {
        let t = line.trim();
        if t.is_empty() || t.starts_with('#') || !t.contains(',') {
            continue;
        }
        if t.starts_with("- ") {
            clash += 1;
        } else if !t.starts_with('-') && !t.starts_with('$') {
            surge += 1;
        }
    }

    if clash > surge {
        "clash"
    } else if surge > 0 {
        "surge"
    } else {
        "unknown"
    }
}

/// Wrap raw rule lines into a `rules: $append:` patch.
///
/// The policy field of every non-built-in rule becomes `{{proxy}}`, so imported
/// rules do not drag in the policy names of the subscription they came from.
pub fn normalize_to_prism_yaml(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    const BUILTIN: &[&str] = &["DIRECT", "REJECT", "PASS"];

    let mut output = String::with_capacity(trimmed.len() + 32);
    output.push_str("rules:\n  $append:\n");
    let header = output.len();

    for line in trimmed.lines() {
        let t = line.trim();
        if t.is_empty() || t.starts_with('#') {
            continue;
        }
        output.push_str("  ");
        if !t.starts_with("- ") {
            output.push_str("- ");
        }
        output.push_str(&replace_policy(t, BUILTIN));
        output.push('\n');
    }

    if output.len() == header {
        return String::new();
    }
    output
}

fn replace_policy(rule: &str, builtin: &[&str]) -> String {
    let mut parts = rule.splitn(4, ',');

    let Some(first) = parts.next() else {
        return rule.to_string();
    };
    let head = first.trim();
    let is_match = head.eq_ignore_ascii_case("MATCH") || head.eq_ignore_ascii_case("FINAL");

    let Some(second) = parts.next() else {
        return rule.to_string();
    };

    let policy = if is_match { second.trim() } else { "" };
    if is_match {
        if builtin.iter().any(|b| b.eq_ignore_ascii_case(policy)) {
            return rule.to_string();
        }
        let tail: Vec<&str> = parts.collect();
        let mut result = format!("{first},{{{{proxy}}}}");
        for rest in tail {
            result.push(',');
            result.push_str(rest);
        }
        return result;
    }

    let Some(third) = parts.next() else {
        return rule.to_string();
    };
    if builtin.iter().any(|b| b.eq_ignore_ascii_case(third.trim())) {
        return rule.to_string();
    }
    let tail: Vec<&str> = parts.collect();
    let mut result = format!("{first},{second},{{{{proxy}}}}");
    for rest in tail {
        result.push(',');
        result.push_str(rest);
    }
    result
}
