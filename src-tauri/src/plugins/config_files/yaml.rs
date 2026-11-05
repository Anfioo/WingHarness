//! The `yaml` adapter: a yaml document, addressed by dotted paths.
//!
//! Same shape as the json adapter — parse the whole document, edit by dotted
//! path, serialize it back. The parser is `serde_yml` (the maintained fork of
//! the archived `serde_yaml`), which keeps the code small but does **not**
//! preserve comments on write-back. That trade is deliberate for v1:
//! comment-preserving yaml needs a document API a good deal larger, and a
//! plugin's own yaml is machine-written far more often than a `.env` is.

use std::path::Path;

use serde_json::{Map, Number, Value};

use super::{atomic_write, read_text, ConfigFile};
// The dotted-path helpers are shared with the json adapter: both work on
// `serde_json::Value`, so one implementation covers them.
use super::json::{get_path, set_path};

pub(super) struct YamlFile;

impl ConfigFile for YamlFile {
    fn read(&self, path: &Path, keys: &[String]) -> Result<Map<String, Value>, String> {
        let root = parse(path)?;
        let mut values = Map::new();

        for key in keys {
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

        let text = serde_yml::to_string(&to_yaml(&root))
            .map_err(|error| format!("Failed to serialize {}: {error}", path.display()))?;
        atomic_write(path, text.as_bytes())
    }
}

/// Reads the document as plain json values, so the dotted-path helpers shared
/// with the json adapter work unchanged.
fn parse(path: &Path) -> Result<Value, String> {
    let text = read_text(path)?;
    if text.trim().is_empty() {
        return Ok(Value::Object(Map::new()));
    }

    let document: serde_yml::Value = serde_yml::from_str(&text)
        .map_err(|error| format!("Invalid yaml in {}: {error}", path.display()))?;
    Ok(to_json(&document))
}

fn to_json(value: &serde_yml::Value) -> Value {
    match value {
        serde_yml::Value::Null => Value::Null,
        serde_yml::Value::Bool(flag) => Value::Bool(*flag),
        serde_yml::Value::Number(number) => {
            if let Some(int) = number.as_i64() {
                Value::Number(Number::from(int))
            } else if let Some(uint) = number.as_u64() {
                Value::Number(Number::from(uint))
            } else {
                number
                    .as_f64()
                    .and_then(Number::from_f64)
                    .map(Value::Number)
                    .unwrap_or(Value::Null)
            }
        }
        serde_yml::Value::String(text) => Value::String(text.clone()),
        serde_yml::Value::Sequence(items) => Value::Array(items.iter().map(to_json).collect()),
        serde_yml::Value::Mapping(entries) => {
            let mut map = Map::new();
            for (key, item) in entries {
                // Only string keys are addressable by a dotted path; anything
                // else is kept as its rendered form so nothing is silently lost.
                map.insert(key_text(key), to_json(item));
            }
            Value::Object(map)
        }
        serde_yml::Value::Tagged(tagged) => to_json(&tagged.value),
    }
}

fn to_yaml(value: &Value) -> serde_yml::Value {
    match value {
        Value::Null => serde_yml::Value::Null,
        Value::Bool(flag) => serde_yml::Value::Bool(*flag),
        Value::Number(number) => {
            if let Some(int) = number.as_i64() {
                serde_yml::Value::Number(int.into())
            } else if let Some(uint) = number.as_u64() {
                serde_yml::Value::Number(uint.into())
            } else {
                serde_yml::Value::Number(number.as_f64().unwrap_or(0.0).into())
            }
        }
        Value::String(text) => serde_yml::Value::String(text.clone()),
        Value::Array(items) => serde_yml::Value::Sequence(items.iter().map(to_yaml).collect()),
        Value::Object(map) => {
            let mut entries = serde_yml::Mapping::new();
            for (key, item) in map {
                entries.insert(serde_yml::Value::String(key.clone()), to_yaml(item));
            }
            serde_yml::Value::Mapping(entries)
        }
    }
}

fn key_text(key: &serde_yml::Value) -> String {
    match key {
        serde_yml::Value::String(text) => text.clone(),
        other => serde_yml::to_string(other)
            .unwrap_or_default()
            .trim()
            .to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const DOC: &str = "\
app:
  title: Demo
  retries: 3
schedule:
  checkin_hours:
    - 9
    - 21
";

    #[test]
    fn reads_nested_paths_and_array_indices() {
        let document: serde_yml::Value = serde_yml::from_str(DOC).unwrap();
        let root = to_json(&document);

        assert_eq!(get_path(&root, "app.title"), Some(&json!("Demo")));
        assert_eq!(get_path(&root, "app.retries"), Some(&json!(3)));
        assert_eq!(
            get_path(&root, "schedule.checkin_hours.1"),
            Some(&json!(21))
        );
    }

    #[test]
    fn round_trips_through_yaml_without_losing_values() {
        let document: serde_yml::Value = serde_yml::from_str(DOC).unwrap();
        let as_json = to_json(&document);
        let back = to_yaml(&as_json);

        assert_eq!(
            back["app"]["title"],
            serde_yml::Value::String("Demo".to_string())
        );
        assert_eq!(
            back["schedule"]["checkin_hours"][0],
            serde_yml::Value::Number(9.into())
        );
    }
}
