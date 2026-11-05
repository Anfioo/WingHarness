//! Reading and rewriting the config files a plugin declares.
//!
//! A manifest lists one or more [`ConfigFileSource`]s — an `.env`, a json, a
//! yaml — and the keys the app may edit in each. This module is the layer
//! between those declarations and the bytes on disk: it reads the declared keys
//! out of a source, writes edited ones back, and never merges values across
//! sources (the same key in two files is two different things).
//!
//! The app stores no config values of its own: the file is the truth. Writing
//! one touches only the declared keys, so comments and undeclared content in a
//! hand-edited `.env` survive.

mod env;
mod json;
mod yaml;

use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{Map, Value};

use super::manifest::{is_contained, ConfigField, ConfigFileSource, ConfigFileType, FieldType};

/// A source as the config window needs it: where it is, whether it is there,
/// and the current value of every key the manifest declares in it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigFileView {
    /// Which adapter reads and writes it: `env` / `json` / `yaml`.
    pub file_type: String,
    /// Where the file is: relative to the plugin root, or as written when the
    /// plugin declares an absolute source.
    pub path: String,
    /// Set for a source declared `absolute`. Such a file is read and written,
    /// but never created, and the config window says so instead of offering to.
    pub external: bool,
    /// Set when a run is refused while the file is missing.
    pub startmust: bool,
    /// Whether the file is on disk right now.
    pub exists: bool,
    /// Fields to render, with their current values.
    pub fields: Vec<ConfigFieldView>,
}

/// One declared key as the config window needs it: the field, plus the value
/// the file currently holds (or the field's default when it holds none).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigFieldView {
    #[serde(flatten)]
    pub field: ConfigField,
    pub value: Value,
}

/// Everything the adapters share. One implementation per format.
trait ConfigFile {
    /// The current values of `edits`' keys — an ordered map keyed by field key.
    ///
    /// A key the file does not hold comes back as `Value::Null`, so the caller
    /// can tell "absent" from an empty string.
    fn read(&self, path: &Path, keys: &[String]) -> Result<Map<String, Value>, String>;

    /// Writes `edits` back. Keys not in `edits`, comments, blank lines and
    /// ordering all survive byte-for-byte.
    fn write(&self, path: &Path, edits: &Map<String, Value>) -> Result<(), String>;
}

fn adapter_for(file_type: ConfigFileType) -> &'static dyn ConfigFile {
    match file_type {
        ConfigFileType::Env => &env::EnvFile,
        ConfigFileType::Json => &json::JsonFile,
        ConfigFileType::Yaml => &yaml::YamlFile,
    }
}

/// Resolves a declared source to the file on disk.
///
/// A source without `absolute` is joined to the plugin folder and checked again
/// here, because a manifest can be edited after validation and this is the last
/// point before a write reaches disk. A source with it is used as written —
/// that is the author's declaration of a file outside the folder, not input a
/// user supplies, so there is nothing to confine.
fn resolve(dir: &Path, source: &ConfigFileSource) -> Result<PathBuf, String> {
    if source.absolute {
        if source.path.trim().is_empty() {
            return Err("An absolute config file needs a path.".to_string());
        }
        return Ok(PathBuf::from(&source.path));
    }

    if !is_contained(&source.path) {
        return Err(format!(
            "Config path '{}' must be relative and inside the plugin folder.",
            source.path
        ));
    }
    Ok(dir.join(&source.path))
}

/// The path a source resolves to, for callers that need it directly (opening
/// the file in an editor) rather than through an adapter.
pub fn resolve_for_open(dir: &Path, source: &ConfigFileSource) -> Result<PathBuf, String> {
    resolve(dir, source)
}

/// One source's fields and their current values.
///
/// Never fails on a missing file: the fields fall back to their declared
/// defaults, which is what lets a plugin's `ui` resolve before the plugin has
/// generated its own `.env`.
fn read_source(dir: &Path, source: &ConfigFileSource) -> Result<Map<String, Value>, String> {
    let path = resolve(dir, source)?;
    let keys: Vec<String> = source
        .fields
        .iter()
        .map(|field| field.key.clone())
        .collect();

    let mut values = if path.is_file() {
        adapter_for(source.file_type).read(&path, &keys)?
    } else {
        Map::new()
    };

    // A key the file does not hold falls back to the field's default. This runs
    // for a missing file too, where every key is absent.
    for field in &source.fields {
        let value = values
            .get(&field.key)
            .filter(|value| !value.is_null())
            .cloned()
            .unwrap_or_else(|| implicit_default(field));
        values.insert(field.key.clone(), coerce(field, value));
    }

    Ok(values)
}

/// Whether a field offers a fixed set of choices.
///
/// A non-empty `options` fixes the accepted values, whatever the declared
/// `type`: a `select`'s list of N choices, or a `boolean`'s pair of on/off
/// literals. The two differ in how the config window renders them (a dropdown
/// vs a toggle) and in what they mean, not in how the value is stored — both
/// keep the literal text of the chosen option, so a `boolean` whose file spells
/// its states `1`/`0` round-trips as `1`/`0` rather than a coerced bool.
fn is_choice(field: &ConfigField) -> bool {
    !field.options.is_empty()
}

/// The read-path counterpart of [`validate`]: a file's value brought into the
/// type its field declares.
///
/// A plain-text adapter like `env` can only hand back strings, so a `boolean`
/// field would otherwise read as the string `"false"` — which the UI, testing
/// truthiness, shows as on. Reading applies the same text forms the write path
/// accepts, but leniently: text that does not fit the declared type is kept as
/// it is, so a hand-edited file shows what it holds instead of failing to load.
///
/// A choice field is the exception: its value is the literal text of one of its
/// options, so a scalar the file held as another type becomes that text (a JSON
/// `true` becomes `"true"`) and the widget can match it — a dropdown for a
/// `select`, a toggle for a `boolean`.
///
/// Idempotent for `json`/`yaml`, which already return real types, so applying it
/// to every source keeps the two paths symmetric without a special case.
fn coerce(field: &ConfigField, value: Value) -> Value {
    if is_choice(field) {
        return match value {
            Value::String(text) => Value::String(text),
            Value::Number(_) | Value::Bool(_) => {
                Value::String(scalar_string(&value).unwrap_or_default())
            }
            other => other,
        };
    }

    match field.field_type {
        FieldType::Boolean => match value {
            Value::String(text) => match text.trim().to_ascii_lowercase().as_str() {
                "true" | "1" | "yes" | "on" => Value::Bool(true),
                "false" | "0" | "no" | "off" | "" => Value::Bool(false),
                _ => Value::String(text),
            },
            other => other,
        },

        FieldType::Number => match value {
            Value::String(text) => text
                .trim()
                .parse::<f64>()
                .map(number_of)
                .unwrap_or(Value::String(text)),
            other => other,
        },

        // These fields edit text, so a scalar the file held as another type is
        // shown as its text form rather than blanking the input. Arrays/objects
        // are left alone; the write path refuses them.
        FieldType::String | FieldType::Select | FieldType::Textarea => match value {
            Value::Number(_) | Value::Bool(_) => {
                Value::String(scalar_string(&value).unwrap_or_default())
            }
            other => other,
        },
    }
}

/// The value used when neither the file nor the manifest supplies one.
///
/// The type's zero, so the config window always has something to render and a
/// save always has something to write.
fn implicit_default(field: &ConfigField) -> Value {
    if !field.default.is_null() {
        return field.default.clone();
    }

    // A boolean with options is a toggle: with no declared default it reads as
    // off. "Off" is whichever option is not `trueValue`, so the button always
    // shows one of the two named states rather than a blank.
    if field.field_type == FieldType::Boolean && !field.options.is_empty() {
        let off = field
            .options
            .iter()
            .find(|option| Some(&option.value) != field.true_value.as_ref())
            .or_else(|| field.options.first());
        if let Some(off) = off {
            return Value::from(off.value.clone());
        }
    }

    // Any other choice field's zero is "nothing chosen": the dropdown shows its
    // placeholder until the user picks one, and no invented value is written
    // into a file whose options the field never named.
    if !field.options.is_empty() {
        return Value::from("");
    }

    match field.field_type {
        FieldType::Number => Value::from(0),
        FieldType::Boolean => Value::Bool(false),
        FieldType::String | FieldType::Select | FieldType::Textarea => Value::from(""),
    }
}

/// The view of one source, with defaults applied — what the config window shows.
///
/// A file that will not parse still reports `exists: true`: it is there, just
/// unreadable, and telling the user it is missing would send them looking in the
/// wrong place.
pub fn view(dir: &Path, source: &ConfigFileSource) -> ConfigFileView {
    let exists = resolve(dir, source)
        .map(|path| path.is_file())
        .unwrap_or(false);
    let values = read_source(dir, source).unwrap_or_default();

    ConfigFileView {
        file_type: file_type_name(source.file_type).to_string(),
        path: source.path.clone(),
        external: source.absolute,
        startmust: source.startmust,
        exists,
        fields: source
            .fields
            .iter()
            .map(|field| ConfigFieldView {
                value: values.get(&field.key).cloned().unwrap_or(Value::Null),
                field: field.clone(),
            })
            .collect(),
    }
}

/// Every declared key of one source as a key → value map, for `{key}`
/// resolution in the plugin's `ui`.
///
/// A source that will not parse falls back to its defaults rather than failing
/// the whole plugin: a broken file should not blank the plugin's page.
pub fn values_of(dir: &Path, source: &ConfigFileSource) -> Map<String, Value> {
    read_source(dir, source).unwrap_or_default()
}

/// Writes the user's edits to one source, touching only the declared keys.
pub fn write(
    dir: &Path,
    source: &ConfigFileSource,
    values: &Map<String, Value>,
) -> Result<(), String> {
    let path = resolve(dir, source)?;

    // An absolute path is a file the plugin owns somewhere else. Writing it is
    // fine; creating it is not, because "missing" there means the plugin has not
    // been started yet, and an empty file is the one thing that would stop it
    // from producing the real one.
    if source.absolute && !path.is_file() {
        return Err(format!(
            "{} does not exist yet; start the plugin once to create it.",
            path.display()
        ));
    }

    let mut edits = Map::new();
    for field in &source.fields {
        let value = values
            .get(&field.key)
            .filter(|value| !value.is_null())
            .cloned()
            .unwrap_or_else(|| implicit_default(field));
        edits.insert(field.key.clone(), validate(field, value)?);
    }

    // A source with nothing declared has nothing to write; creating an empty
    // file for one would be a surprise, not a save.
    if edits.is_empty() {
        return Ok(());
    }

    adapter_for(source.file_type).write(&path, &edits)
}

/// The first `startmust` source whose file is missing, if any.
///
/// Checked once before a run; `None` means every required file is present.
pub fn missing_required(dir: &Path, sources: &[ConfigFileSource]) -> Option<String> {
    sources
        .iter()
        .filter(|source| source.startmust)
        .find(|source| {
            !resolve(dir, source)
                .map(|path| path.is_file())
                .unwrap_or(false)
        })
        .map(|source| source.path.clone())
}

/// Checks a value against the field's declared type and bounds.
///
/// Runs before anything reaches a file, so a number with a `min`/`max` never
/// gets written out of range and a choice field never holds a value it does not
/// offer.
fn validate(field: &ConfigField, value: Value) -> Result<Value, String> {
    let name = if field.label.trim().is_empty() {
        field.key.clone()
    } else {
        field.label.clone()
    };

    // A choice field — a `select`, or a `boolean` that named its own options —
    // stores the literal text of one of its options. That is what lets a
    // boolean's file hold `1`/`0` or `on`/`off` and still round-trip exactly.
    if is_choice(field) {
        let text = scalar_string(&value)?;
        if !field.options.iter().any(|option| option.value == text) {
            return Err(format!("'{name}' must be one of the offered values."));
        }
        return Ok(Value::String(text));
    }

    match field.field_type {
        FieldType::Number => {
            let number = match value {
                Value::Number(number) => number.as_f64(),
                Value::String(text) if text.trim().is_empty() => None,
                Value::String(text) => text.parse::<f64>().ok(),
                _ => None,
            };

            let Some(number) = number else {
                return Err(format!("'{name}' must be a number."));
            };
            if let Some(min) = field.min {
                if number < min {
                    return Err(format!("'{name}' must be at least {min}."));
                }
            }
            if let Some(max) = field.max {
                if number > max {
                    return Err(format!("'{name}' must be at most {max}."));
                }
            }
            Ok(number_of(number))
        }

        FieldType::Boolean => match value {
            Value::Bool(_) => Ok(value),
            Value::String(text) => match text.trim().to_ascii_lowercase().as_str() {
                "true" | "1" | "yes" | "on" => Ok(Value::Bool(true)),
                "false" | "0" | "no" | "off" | "" => Ok(Value::Bool(false)),
                _ => Err(format!("'{name}' must be true or false.")),
            },
            Value::Number(number) => Ok(Value::Bool(number.as_f64().unwrap_or(0.0) != 0.0)),
            _ => Err(format!("'{name}' must be true or false.")),
        },

        // Reached only for a `select` that declared no options at all — every
        // select with choices takes the `is_choice` branch above. With nothing
        // to constrain it, the field is a free string.
        FieldType::Select => Ok(Value::String(scalar_string(&value)?)),

        FieldType::String | FieldType::Textarea => Ok(Value::String(scalar_string(&value)?)),
    }
}

/// Renders a number without a needless `.0`, so `7864` stays `7864`.
fn number_of(value: f64) -> Value {
    if value.fract() == 0.0 && value.abs() < 9_007_199_254_740_992.0 {
        Value::from(value as i64)
    } else {
        Value::from(value)
    }
}

fn scalar_string(value: &Value) -> Result<String, String> {
    match value {
        Value::String(text) => Ok(text.clone()),
        Value::Number(number) => Ok(number.to_string()),
        Value::Bool(flag) => Ok(flag.to_string()),
        Value::Null => Ok(String::new()),
        Value::Array(_) | Value::Object(_) => {
            Err("A config value must be a single line of text.".to_string())
        }
    }
}

/// The manifest's name for a source type, as the UI displays it.
pub fn file_type_name(file_type: ConfigFileType) -> &'static str {
    match file_type {
        ConfigFileType::Env => "env",
        ConfigFileType::Json => "json",
        ConfigFileType::Yaml => "yaml",
    }
}

/// Replaces every write target atomically: a crash must not leave a config file
/// half-written. Returns `path` once the temp file has been renamed over it.
///
/// The temp file sits beside the target so the rename stays on one volume,
/// which is what makes it atomic on every platform.
fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create {}: {error}", parent.display()))?;
    }

    let temp = path.with_extension("tmp-config-write");
    {
        let mut file = std::fs::File::create(&temp)
            .map_err(|error| format!("Failed to write {}: {error}", temp.display()))?;
        file.write_all(bytes)
            .map_err(|error| format!("Failed to write {}: {error}", temp.display()))?;
        file.sync_all()
            .map_err(|error| format!("Failed to flush {}: {error}", temp.display()))?;
    }

    std::fs::rename(&temp, path)
        .map_err(|error| format!("Failed to replace {}: {error}", path.display()))
}

/// Reads a file as text, tolerating a UTF-8 BOM.
fn read_text(path: &Path) -> Result<String, String> {
    let bytes = std::fs::read(path)
        .map_err(|error| format!("Failed to read {}: {error}", path.display()))?;
    let bytes = crate::config::strip_bom(&bytes);
    String::from_utf8(bytes.to_vec())
        .map_err(|error| format!("{} is not valid UTF-8: {error}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::manifest::{ConfigFileSource, ConfigFileType, FieldType, SelectOption};

    fn field(key: &str, field_type: FieldType) -> ConfigField {
        ConfigField {
            key: key.to_string(),
            label: key.to_string(),
            field_type,
            default: Value::Null,
            hint: None,
            options: Vec::new(),
            true_value: None,
            min: None,
            max: None,
        }
    }

    /// The same, with a choice list — the shape a manifest uses to fix a
    /// field's accepted values.
    fn choice(key: &str, field_type: FieldType, options: &[&str]) -> ConfigField {
        ConfigField {
            options: options
                .iter()
                .map(|value| SelectOption {
                    value: value.to_string(),
                    label: String::new(),
                })
                .collect(),
            ..field(key, field_type)
        }
    }

    /// A boolean toggle: its two states, plus which one is "on".
    fn toggle(key: &str, options: &[&str], true_value: &str) -> ConfigField {
        ConfigField {
            true_value: Some(true_value.to_string()),
            ..choice(key, FieldType::Boolean, options)
        }
    }

    fn source(file_type: ConfigFileType, path: &str, fields: Vec<ConfigField>) -> ConfigFileSource {
        ConfigFileSource {
            file_type,
            path: path.to_string(),
            absolute: false,
            startmust: false,
            fields,
        }
    }

    /// The same, declared `absolute`: the path is used exactly as written.
    fn absolute_source(
        file_type: ConfigFileType,
        path: &str,
        fields: Vec<ConfigField>,
    ) -> ConfigFileSource {
        ConfigFileSource {
            absolute: true,
            ..source(file_type, path, fields)
        }
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("plugin-config-tests-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn an_env_boolean_reads_back_as_a_bool_not_a_string() {
        let dir = temp_dir("env-bool-read");
        std::fs::write(dir.join(".env"), "SYSTEM_PROXY=false\n").unwrap();
        let src = source(
            ConfigFileType::Env,
            ".env",
            vec![field("SYSTEM_PROXY", FieldType::Boolean)],
        );

        let values = read_source(&dir, &src).unwrap();
        // The regression: the string "false" is truthy in the UI, so a boolean
        // field only renders correctly when the read path hands back a real bool.
        assert_eq!(values["SYSTEM_PROXY"], Value::Bool(false));

        std::fs::write(dir.join(".env"), "SYSTEM_PROXY=yes\n").unwrap();
        let values = read_source(&dir, &src).unwrap();
        assert_eq!(values["SYSTEM_PROXY"], Value::Bool(true));
    }

    #[test]
    fn an_env_number_reads_back_as_a_number() {
        let dir = temp_dir("env-number-read");
        std::fs::write(dir.join(".env"), "PORT=7864\nRATIO=1.5\n").unwrap();
        let src = source(
            ConfigFileType::Env,
            ".env",
            vec![
                field("PORT", FieldType::Number),
                field("RATIO", FieldType::Number),
            ],
        );

        let values = read_source(&dir, &src).unwrap();
        assert_eq!(values["PORT"], Value::from(7864));
        assert_eq!(values["RATIO"], Value::from(1.5));
    }

    #[test]
    fn a_value_that_does_not_fit_its_declared_type_is_kept_as_text() {
        let dir = temp_dir("env-coerce-fallback");
        std::fs::write(dir.join(".env"), "SYSTEM_PROXY=maybe\nPORT=soon\n").unwrap();
        let src = source(
            ConfigFileType::Env,
            ".env",
            vec![
                field("SYSTEM_PROXY", FieldType::Boolean),
                field("PORT", FieldType::Number),
            ],
        );

        // Reading is lenient: a hand-edited file shows what it holds rather than
        // failing to load or being silently rewritten to a wrong value.
        let values = read_source(&dir, &src).unwrap();
        assert_eq!(values["SYSTEM_PROXY"], Value::from("maybe"));
        assert_eq!(values["PORT"], Value::from("soon"));
    }

    #[test]
    fn a_scalar_of_another_type_reads_back_as_text_for_string_fields() {
        let dir = temp_dir("json-scalar-string");
        std::fs::write(
            dir.join("cfg.json"),
            r#"{"host":"x","port":7864,"flag":true}"#,
        )
        .unwrap();
        let src = source(
            ConfigFileType::Json,
            "cfg.json",
            vec![
                field("host", FieldType::String),
                field("port", FieldType::String),
                field("flag", FieldType::String),
            ],
        );

        let values = read_source(&dir, &src).unwrap();
        assert_eq!(values["host"], Value::from("x"));
        assert_eq!(values["port"], Value::from("7864"));
        assert_eq!(values["flag"], Value::from("true"));
    }

    #[test]
    fn a_choice_field_reads_and_writes_the_literal_option_text() {
        let dir = temp_dir("choice-literal");
        std::fs::write(dir.join(".env"), "SYSTEM_PROXY=false\n").unwrap();
        let src = source(
            ConfigFileType::Env,
            ".env",
            vec![toggle("SYSTEM_PROXY", &["true", "false"], "true")],
        );

        // A boolean with options is a choice: what the file holds is one of the
        // strings the manifest named, not a coerced bool.
        let values = read_source(&dir, &src).unwrap();
        assert_eq!(values["SYSTEM_PROXY"], Value::from("false"));

        // And it round-trips as that same text.
        let mut edits = Map::new();
        edits.insert("SYSTEM_PROXY".to_string(), Value::from("true"));
        write(&dir, &src, &edits).unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.join(".env")).unwrap(),
            "SYSTEM_PROXY=true\n"
        );
    }

    #[test]
    fn a_choice_field_offers_1_and_0_as_freely_as_true_and_false() {
        let dir = temp_dir("choice-1-0");
        std::fs::write(dir.join("cfg.json"), r#"{"enabled":0}"#).unwrap();
        let src = source(
            ConfigFileType::Json,
            "cfg.json",
            vec![toggle("enabled", &["1", "0"], "1")],
        );

        // The file's number becomes the option text, so the toggle matches it.
        let values = read_source(&dir, &src).unwrap();
        assert_eq!(values["enabled"], Value::from("0"));

        let mut edits = Map::new();
        edits.insert("enabled".to_string(), Value::from("1"));
        write(&dir, &src, &edits).unwrap();

        let after: Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join("cfg.json")).unwrap()).unwrap();
        // The literal "1" is kept as text, not turned into the number 1.
        assert_eq!(after["enabled"], Value::from("1"));
    }

    #[test]
    fn a_choice_value_off_the_list_is_refused() {
        let flag = toggle("SYSTEM_PROXY", &["true", "false"], "true");
        assert_eq!(
            validate(&flag, Value::from("true")).unwrap(),
            Value::from("true")
        );
        assert!(validate(&flag, Value::from("yes")).is_err());
    }

    #[test]
    fn a_boolean_with_options_and_no_default_reads_back_its_off_literal() {
        let dir = temp_dir("bool-no-default");
        let src = source(
            ConfigFileType::Env,
            "missing.env",
            vec![toggle("SYSTEM_PROXY", &["0", "1"], "1")],
        );

        // A toggle always reads as one thing or the other, never blank: with no
        // declared default it falls to the state that is not trueValue — here
        // "0", independent of option order.
        let values = read_source(&dir, &src).unwrap();
        assert_eq!(values["SYSTEM_PROXY"], Value::from("0"));
    }

    #[test]
    fn a_select_with_no_default_reads_back_unset_not_the_type_zero() {
        let dir = temp_dir("select-no-default");
        let src = source(
            ConfigFileType::Env,
            "missing.env",
            vec![choice(
                "LEVEL",
                FieldType::Select,
                &["info", "warn", "error"],
            )],
        );

        // A dropdown has a third state the toggle does not — "nothing chosen" —
        // so with no default it reads unset and the placeholder shows.
        let values = read_source(&dir, &src).unwrap();
        assert_eq!(values["LEVEL"], Value::from(""));
    }

    #[test]
    fn a_missing_file_reads_back_the_field_defaults() {
        let dir = temp_dir("missing-defaults");
        let mut host = field("WEB_HOST", FieldType::String);
        host.default = Value::from("127.0.0.1");
        let mut port = field("WEB_PORT", FieldType::Number);
        port.default = Value::from(7864);
        let src = source(ConfigFileType::Env, ".env", vec![host, port]);

        let values = read_source(&dir, &src).unwrap();
        assert_eq!(values["WEB_HOST"], Value::from("127.0.0.1"));
        assert_eq!(values["WEB_PORT"], Value::from(7864));

        // A key with neither a file value nor a default uses the type's zero, so
        // the window always has something to show.
        let src = source(
            ConfigFileType::Json,
            "cfg.json",
            vec![field("retries", FieldType::Number)],
        );
        let values = read_source(&dir, &src).unwrap();
        assert_eq!(values["retries"], Value::from(0));
    }

    #[test]
    fn an_external_source_is_written_but_never_created() {
        let dir = temp_dir("external-write");
        let outside = dir.join("elsewhere").join("shared.yaml");
        std::fs::create_dir_all(outside.parent().unwrap()).unwrap();
        let path = outside.to_string_lossy().to_string();

        let mut retries = field("site.retries", FieldType::Number);
        retries.default = Value::from(3);
        let src = absolute_source(ConfigFileType::Yaml, &path, vec![retries]);

        // Missing: refused, because creating it would stop the plugin that owns
        // it from producing the real file on its first run.
        let error = write(&dir, &src, &Map::new()).unwrap_err();
        assert!(error.contains("does not exist yet"), "{error}");
        assert!(!outside.exists());

        // Present: written like any other source, by dotted path.
        std::fs::write(&outside, "site:\n  retries: 3\n  title: Demo\n").unwrap();
        let mut edits = Map::new();
        edits.insert("site.retries".to_string(), Value::from(7));
        write(&dir, &src, &edits).unwrap();

        let after: serde_yml::Value =
            serde_yml::from_str(&std::fs::read_to_string(&outside).unwrap()).unwrap();
        assert_eq!(after["site"]["retries"], serde_yml::Value::Number(7.into()));
        // Undeclared keys survive, the same as for a relative source.
        assert_eq!(
            after["site"]["title"],
            serde_yml::Value::String("Demo".to_string())
        );
    }

    #[test]
    fn the_view_marks_an_external_source_and_a_missing_one_is_not_created() {
        let dir = temp_dir("external-view");
        let outside = dir.join("outside.yaml");
        std::fs::write(&outside, "a: 1\n").unwrap();

        let external =
            absolute_source(ConfigFileType::Yaml, &outside.to_string_lossy(), Vec::new());
        let shown = view(&dir, &external);
        assert!(shown.external);
        assert!(shown.exists);

        let inside = source(ConfigFileType::Yaml, "cfg.yaml", Vec::new());
        let shown = view(&dir, &inside);
        assert!(!shown.external);
        assert!(!shown.exists);
    }

    #[test]
    fn writes_validate_numbers_and_offsets() {
        let mut port = field("PORT", FieldType::Number);
        port.min = Some(1024.0);
        port.max = Some(65535.0);
        assert!(validate(&port, Value::from(80)).is_err());
        assert!(validate(&port, Value::from(70000)).is_err());
        assert_eq!(
            validate(&port, Value::from(7864)).unwrap(),
            Value::from(7864)
        );
        // An empty string from a cleared input is refused rather than guessed.
        assert!(validate(&port, Value::from("")).is_err());
    }

    #[test]
    fn writes_validate_select_options() {
        let mut level = field("LEVEL", FieldType::Select);
        level.options = vec![SelectOption {
            value: "info".to_string(),
            label: String::new(),
        }];
        assert!(validate(&level, Value::from("info")).is_ok());
        assert!(validate(&level, Value::from("debug")).is_err());
    }

    #[test]
    fn booleans_accept_the_text_forms_the_files_use() {
        let flag = field("OPEN", FieldType::Boolean);
        assert_eq!(
            validate(&flag, Value::from("1")).unwrap(),
            Value::Bool(true)
        );
        assert_eq!(
            validate(&flag, Value::from("false")).unwrap(),
            Value::Bool(false)
        );
        assert!(validate(&flag, Value::from("maybe")).is_err());
    }

    #[test]
    fn startmust_names_the_file_that_is_missing() {
        let dir = temp_dir("startmust");
        std::fs::write(dir.join("present.json"), "{}").unwrap();

        let mut present = source(ConfigFileType::Json, "present.json", Vec::new());
        present.startmust = true;
        let mut absent = source(ConfigFileType::Json, "absent.json", Vec::new());
        absent.startmust = true;
        let optional = source(ConfigFileType::Json, "optional.json", Vec::new());

        assert!(missing_required(&dir, &[present.clone(), optional.clone()]).is_none());
        assert_eq!(
            missing_required(&dir, &[present, absent, optional]).as_deref(),
            Some("absent.json")
        );
    }

    #[test]
    fn an_env_write_touches_only_the_edited_line() {
        let dir = temp_dir("env-write");
        let original = "# The port the panel listens on.\nWEB_PORT=7864  # default\n\n# Keep loopback.\nWEB_HOST=127.0.0.1\n";
        std::fs::write(dir.join(".env"), original).unwrap();

        let src = source(
            ConfigFileType::Env,
            ".env",
            vec![
                field("WEB_PORT", FieldType::Number),
                field("WEB_HOST", FieldType::String),
            ],
        );

        let mut edits = Map::new();
        edits.insert("WEB_PORT".to_string(), Value::from(9000));
        edits.insert("WEB_HOST".to_string(), Value::from("127.0.0.1"));
        write(&dir, &src, &edits).unwrap();

        let after = std::fs::read_to_string(dir.join(".env")).unwrap();
        // Comment lines, the blank line and the untouched key all survive; only
        // the port's line changed, keeping its inline comment.
        assert_eq!(
            after,
            "# The port the panel listens on.\nWEB_PORT=9000  # default\n\n# Keep loopback.\nWEB_HOST=127.0.0.1\n"
        );
    }

    #[test]
    fn an_env_write_appends_a_key_the_file_lacks_and_creates_a_missing_file() {
        let dir = temp_dir("env-append");
        std::fs::write(dir.join(".env"), "A=1\n").unwrap();
        let src = source(
            ConfigFileType::Env,
            ".env",
            vec![field("A", FieldType::String), field("B", FieldType::String)],
        );

        let mut edits = Map::new();
        edits.insert("A".to_string(), Value::from("1"));
        edits.insert("B".to_string(), Value::from("two"));
        // A key the manifest does not declare is dropped rather than written.
        edits.insert("NOT_DECLARED".to_string(), Value::from("x"));
        write(&dir, &src, &edits).unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.join(".env")).unwrap(),
            "A=1\nB=two\n"
        );

        // A missing file is created from the declared fields' defaults.
        let mut port = field("PORT", FieldType::Number);
        port.default = Value::from(7864);
        let fresh = source(ConfigFileType::Env, "new.env", vec![port]);
        write(&dir, &fresh, &Map::new()).unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.join("new.env")).unwrap(),
            "PORT=7864\n"
        );
    }

    #[test]
    fn a_json_write_keeps_undeclared_keys() {
        let dir = temp_dir("json-write");
        std::fs::write(
            dir.join("cfg.json"),
            r#"{"api_key":"secret","cooldown":{"soft_rate":"600s"}}"#,
        )
        .unwrap();

        let src = source(
            ConfigFileType::Json,
            "cfg.json",
            vec![field("cooldown.soft_rate", FieldType::String)],
        );

        let mut edits = Map::new();
        edits.insert("cooldown.soft_rate".to_string(), Value::from("900s"));
        write(&dir, &src, &edits).unwrap();

        let after: Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join("cfg.json")).unwrap()).unwrap();
        assert_eq!(after["cooldown"]["soft_rate"], Value::from("900s"));
        assert_eq!(after["api_key"], Value::from("secret"));
    }

    #[test]
    fn a_yaml_write_keeps_undeclared_keys() {
        let dir = temp_dir("yaml-write");
        std::fs::write(dir.join("cfg.yaml"), "app:\n  title: Demo\n  retries: 3\n").unwrap();

        let src = source(
            ConfigFileType::Yaml,
            "cfg.yaml",
            vec![field("app.retries", FieldType::Number)],
        );

        let mut edits = Map::new();
        edits.insert("app.retries".to_string(), Value::from(5));
        write(&dir, &src, &edits).unwrap();

        let after = std::fs::read_to_string(dir.join("cfg.yaml")).unwrap();
        let document: serde_yml::Value = serde_yml::from_str(&after).unwrap();
        assert_eq!(
            document["app"]["retries"],
            serde_yml::Value::Number(5.into())
        );
        assert_eq!(
            document["app"]["title"],
            serde_yml::Value::String("Demo".to_string())
        );
    }
}

#[cfg(test)]
mod probe_installed_plugin {
    use super::*;
    use crate::plugins::manifest;

    #[test]
    fn probe_the_installed_agentmemory_plugin() {
        let dir = std::path::PathBuf::from(
            r"C:\Users\Anfioo\AppData\Roaming\com.anfioo.wingharness\plugins\agentmemory",
        );
        if !dir.is_dir() {
            println!("PROBE not installed at {}", dir.display());
            return;
        }
        let manifest = match manifest::read(&dir) {
            Ok(m) => m,
            Err(error) => {
                println!("PROBE MANIFEST ERROR: {error}");
                return;
            }
        };
        println!("PROBE id={} ui={:?}", manifest.id, manifest.ui);
        for source in &manifest.config_files {
            let view = view(&dir, source);
            println!(
                "PROBE source {} path={} absolute={} external={} exists={} fields={}",
                crate::plugins::config_files::file_type_name(source.file_type),
                source.path,
                source.absolute,
                view.external,
                view.exists,
                view.fields.len()
            );
            for field in &view.fields {
                println!("PROBE    {} = {}", field.field.key, field.value);
            }
        }
    }
}
