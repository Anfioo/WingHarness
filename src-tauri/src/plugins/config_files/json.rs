//! The `json` adapter: a json object, addressed by dotted paths.
//!
//! Unlike an `.env`, json is parsed and re-serialized whole, so original
//! formatting is not preserved — the cost of a format with no comments to lose.
//! Missing intermediate objects are created on the way to a key, and a numeric
//! path segment addresses an array index.

use std::path::Path;

use serde_json::{Map, Value};

use super::{atomic_write, read_text, ConfigFile};

pub(super) struct JsonFile;

impl ConfigFile for JsonFile {
    fn read(&self, path: &Path, keys: &[String]) -> Result<Map<String, Value>, String> {
        let root = parse(path)?;
        let mut values = Map::new();

        for key in keys {
            // A path the document does not hold is left out; the caller fills
            // it from the field's default.
            if let Some(value) = get_path(&root, key) {
                values.insert(key.clone(), value.clone());
            }
        }

        Ok(values)
    }

    fn write(&self, path: &Path, edits: &Map<String, Value>) -> Result<(), String> {
        let mut root = if path.is_file() {
            parse(path)?
        } else {
            Value::Object(Map::new())
        };

        for (key, value) in edits {
            set_path(&mut root, key, value.clone())?;
        }

        let text = serde_json::to_string_pretty(&root)
            .map_err(|error| format!("Failed to serialize {}: {error}", path.display()))?;
        atomic_write(path, text.as_bytes())
    }
}

fn parse(path: &Path) -> Result<Value, String> {
    let text = read_text(path)?;
    if text.trim().is_empty() {
        return Ok(Value::Object(Map::new()));
    }
    serde_json::from_str(&text)
        .map_err(|error| format!("Invalid json in {}: {error}", path.display()))
}

/// Splits `a.0.b` into its segments. Empty segments are refused, so a typo
/// fails loudly rather than silently addressing an empty key.
pub(super) fn segments(path: &str) -> Result<Vec<&str>, String> {
    let parts: Vec<&str> = path.split('.').collect();
    if parts.iter().any(|part| part.is_empty()) {
        return Err(format!("'{path}' is not a valid config path."));
    }
    Ok(parts)
}

/// Follows a dotted path through objects and arrays.
pub(super) fn get_path<'a>(root: &'a Value, path: &str) -> Option<&'a Value> {
    let mut current = root;

    for segment in segments(path).ok()? {
        current = match current {
            Value::Object(map) => map.get(segment)?,
            Value::Array(items) => items.get(segment.parse::<usize>().ok()?)?,
            _ => return None,
        };
    }

    Some(current)
}

/// Sets the value at a dotted path, creating containers along the way.
pub(super) fn set_path(root: &mut Value, path: &str, value: Value) -> Result<(), String> {
    let parts = segments(path)?;
    let (last, parents) = parts.split_last().expect("checked non-empty above");

    let mut current = root;
    for (index, segment) in parents.iter().enumerate() {
        // The child of this segment must be an array when the segment after it
        // is an index (`a.0.b`), because that is what the index addresses.
        let child_array = parents
            .get(index + 1)
            .is_some_and(|next| next.parse::<usize>().is_ok());
        current = descend(current, segment, child_array, path)?;
    }

    // The last key lands in `current`; a scalar here has nothing to hold it, so
    // it is replaced by an object.
    let index = last.parse::<usize>().ok();
    match current {
        Value::Object(map) => {
            map.insert(last.to_string(), value);
        }
        Value::Array(items) => {
            let Some(index) = index else {
                return Err(format!("'{path}' needs an array index at '{last}'."));
            };
            if index < items.len() {
                items[index] = value;
            } else {
                // Grow the array to reach the index, matching how a plugin's own
                // defaults would have laid it out.
                items.resize(index + 1, Value::Null);
                items[index] = value;
            }
        }
        _ => {
            *current = Value::Object(Map::new());
            let Value::Object(map) = current else {
                unreachable!("just made it an object")
            };
            map.insert(last.to_string(), value);
        }
    }

    Ok(())
}

/// Steps into one container, making the child the right shape along the way.
///
/// `child_array` requests that the child be an array — which is what a numeric
/// segment following it will address. A container already there keeps its own
/// shape; only a missing one is created, and a scalar standing where the path
/// needs a container is replaced.
fn descend<'a>(
    parent: &'a mut Value,
    segment: &str,
    child_array: bool,
    path: &str,
) -> Result<&'a mut Value, String> {
    let child = match parent {
        Value::Array(items) => {
            let index = segment
                .parse::<usize>()
                .map_err(|_| format!("'{path}' needs an array index at '{segment}'."))?;
            if index >= items.len() {
                items.resize(index + 1, Value::Null);
            }
            &mut items[index]
        }
        Value::Object(map) => map.entry(segment.to_string()).or_insert(Value::Null),
        _ => {
            // A scalar standing where the path needs a container cannot be
            // navigated through, so it is replaced.
            *parent = Value::Object(Map::new());
            let Value::Object(map) = parent else {
                unreachable!("just made it an object")
            };
            map.entry(segment.to_string()).or_insert(Value::Null)
        }
    };

    if child_array && !matches!(child, Value::Array(_)) {
        *child = Value::Array(Vec::new());
    }

    Ok(child)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const DOC: &str = r#"{
        "api_key": "k",
        "cooldown": { "soft_rate": "600s" },
        "schedule": { "checkin_hours": [9, 21] }
    }"#;

    #[test]
    fn reads_nested_paths_and_array_indices() {
        let root: Value = serde_json::from_str(DOC).unwrap();
        assert_eq!(get_path(&root, "api_key"), Some(&json!("k")));
        assert_eq!(get_path(&root, "cooldown.soft_rate"), Some(&json!("600s")));
        assert_eq!(get_path(&root, "schedule.checkin_hours.0"), Some(&json!(9)));
        assert_eq!(
            get_path(&root, "schedule.checkin_hours.1"),
            Some(&json!(21))
        );
        assert_eq!(get_path(&root, "schedule.missing"), None);
    }

    #[test]
    fn writes_a_nested_scalar_in_place() {
        let mut root: Value = serde_json::from_str(DOC).unwrap();
        set_path(&mut root, "cooldown.soft_rate", json!("900s")).unwrap();
        assert_eq!(get_path(&root, "cooldown.soft_rate"), Some(&json!("900s")));
        // The sibling is untouched.
        assert_eq!(get_path(&root, "api_key"), Some(&json!("k")));
    }

    #[test]
    fn writes_an_array_index() {
        let mut root: Value = serde_json::from_str(DOC).unwrap();
        set_path(&mut root, "schedule.checkin_hours.0", json!(10)).unwrap();
        assert_eq!(
            get_path(&root, "schedule.checkin_hours.0"),
            Some(&json!(10))
        );
        assert_eq!(
            get_path(&root, "schedule.checkin_hours.1"),
            Some(&json!(21))
        );
    }

    #[test]
    fn creates_intermediate_objects() {
        let mut root = json!({});
        set_path(&mut root, "a.b.c", json!(1)).unwrap();
        assert_eq!(get_path(&root, "a.b.c"), Some(&json!(1)));
    }

    #[test]
    fn grows_an_array_to_reach_an_index() {
        let mut root = json!({ "hours": [9] });
        set_path(&mut root, "hours.2", json!(22)).unwrap();
        assert_eq!(root["hours"], json!([9, null, 22]));
    }

    #[test]
    fn empty_segments_are_rejected() {
        assert!(segments("a..b").is_err());
        assert!(segments(".a").is_err());
        assert!(segments("a.").is_err());
    }
}
