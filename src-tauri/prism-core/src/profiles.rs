//! Source profiles — the compiler's input side.
//!
//! These files are only ever read by Prism. The compiled result lands in
//! `run/config.yaml`, which is what the core is pointed at. Keeping the two
//! apart is what makes repeated applies idempotent.

use serde::Serialize;
use std::path::Path;

use crate::settings;
use crate::store;

pub const DEFAULT_PROFILE_ID: &str = "default.yaml";

/// Minimal valid mihomo config, so a fresh install can compile and start
/// before the user replaces it with their own subscription output.
pub const DEFAULT_PROFILE: &str = r#"# Clash source profile.
# Prism reads this file, applies the patches under prism/, and writes the
# result to run/config.yaml.
mixed-port: 7890
allow-lan: false
mode: rule
log-level: info
external-controller: 127.0.0.1:9090

proxies: []

proxy-groups:
  - name: PROXY
    type: select
    proxies:
      - DIRECT

rules:
  - MATCH,DIRECT
"#;

const NEW_PROFILE: &str = r#"# New source profile
mixed-port: 7890
mode: rule

proxy-groups:
  - name: PROXY
    type: select
    proxies:
      - DIRECT

rules:
  - MATCH,DIRECT
"#;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClashProfile {
    pub id: String,
    pub name: String,
    pub size: u64,
    pub active: bool,
}

/// Create the default profile and pick an active one on first run.
pub fn ensure_default() -> Result<(), String> {
    let mut ids = ids()?;
    if ids.is_empty() {
        write(DEFAULT_PROFILE_ID, DEFAULT_PROFILE)?;
        ids.push(DEFAULT_PROFILE_ID.to_string());
    }
    let current = settings::load().active_profile;
    let still_valid = current.as_ref().is_some_and(|id| ids.contains(id));
    if !still_valid {
        settings::set_active(Some(ids[0].clone()))?;
    }
    Ok(())
}

pub fn ids() -> Result<Vec<String>, String> {
    let dir = store::profiles_dir()?;
    let mut ids = Vec::new();
    let entries =
        std::fs::read_dir(&dir).map_err(|e| format!("Failed to read profiles directory: {e}"))?;
    for entry in entries.flatten() {
        if !entry.path().is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if is_profile_name(&name) {
            ids.push(name);
        }
    }
    ids.sort_by_key(|a| a.to_lowercase());
    Ok(ids)
}

pub fn list() -> Result<Vec<ClashProfile>, String> {
    let dir = store::profiles_dir()?;
    let active = active_id()?;
    let mut profiles = Vec::new();
    for id in ids()? {
        let path = dir.join(&id);
        profiles.push(ClashProfile {
            name: id.trim_end_matches(".yaml").trim_end_matches(".yml").to_string(),
            size: std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0),
            active: active.as_deref() == Some(id.as_str()),
            id,
        });
    }
    Ok(profiles)
}

pub fn active_id() -> Result<Option<String>, String> {
    let ids = ids()?;
    let stored = settings::load().active_profile;
    Ok(stored
        .filter(|id| ids.contains(id))
        .or_else(|| ids.first().cloned()))
}

pub fn active_content() -> Result<Option<String>, String> {
    match active_id()? {
        Some(id) => Ok(Some(read(&id)?)),
        None => Ok(None),
    }
}

pub fn read(id: &str) -> Result<String, String> {
    let path = resolve(id)?;
    std::fs::read_to_string(&path).map_err(|e| format!("Failed to read {}: {e}", path.display()))
}

pub fn write(id: &str, content: &str) -> Result<(), String> {
    let path = resolve(id)?;
    parse(content)?;
    store::atomic_write(&path, content)
}

pub fn create(name: &str) -> Result<String, String> {
    let id = to_id(name)?;
    let path = resolve(&id)?;
    if path.exists() {
        return Err(format!("Profile {id} already exists"));
    }
    store::atomic_write(&path, NEW_PROFILE)?;
    Ok(id)
}

pub fn delete(id: &str) -> Result<(), String> {
    let path = resolve(id)?;
    let remaining: Vec<String> = ids()?.into_iter().filter(|x| x != id).collect();
    if remaining.is_empty() {
        return Err("At least one profile must remain".to_string());
    }
    std::fs::remove_file(&path).map_err(|e| format!("Failed to delete {}: {e}", path.display()))?;
    if settings::load().active_profile.as_deref() == Some(id) {
        settings::set_active(Some(remaining[0].clone()))?;
    }
    Ok(())
}

pub fn select(id: &str) -> Result<(), String> {
    let path = resolve(id)?;
    if !path.is_file() {
        return Err(format!("Profile {id} does not exist"));
    }
    settings::set_active(Some(id.to_string()))
}

/// Copy a file the user picked into `profiles/`. Returns the new id.
pub fn import_file(path: &str) -> Result<String, String> {
    let source = Path::new(path);
    let content = std::fs::read_to_string(source)
        .map_err(|e| format!("Failed to read {}: {e}", source.display()))?;
    parse(&content)?;

    let stem = source
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "imported".to_string());
    let mut id = to_id(&stem)?;
    let mut counter = 2;
    while resolve(&id)?.exists() {
        id = to_id(&format!("{stem} {counter}"))?;
        counter += 1;
    }
    store::atomic_write(&resolve(&id)?, &content)?;
    Ok(id)
}

fn resolve(id: &str) -> Result<std::path::PathBuf, String> {
    let safe = store::sanitize_name(id)?;
    if !is_profile_name(&safe) {
        return Err("Profile file name must end with .yaml or .yml".to_string());
    }
    Ok(store::profiles_dir()?.join(safe))
}

fn to_id(name: &str) -> Result<String, String> {
    let base = name
        .trim_end_matches(".yaml")
        .trim_end_matches(".yml")
        .trim();
    let safe = store::sanitize_name(base)?;
    Ok(format!("{safe}.yaml"))
}

fn is_profile_name(name: &str) -> bool {
    name.ends_with(".yaml") || name.ends_with(".yml")
}

fn parse(content: &str) -> Result<(), String> {
    serde_yaml_ng::from_str::<serde_yaml_ng::Value>(content)
        .map(|_| ())
        .map_err(|e| format!("Failed to parse YAML: {e}"))
}
