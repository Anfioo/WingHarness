//! The `plugin.json` a plugin carries at its root.
//!
//! Everything the app knows about a plugin — what to run, and which files it
//! may configure — comes from this file. Installing a plugin therefore never
//! requires touching the app: the config window draws the fields each declared
//! file contributes, and writes the user's edits straight back into those files.

use std::fs;
use std::path::{Component, Path};

use serde::{Deserialize, Serialize};

use crate::config::strip_bom;

/// Manifest file expected at the root of every plugin folder.
pub const MANIFEST_FILE: &str = "plugin.json";

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PluginManifest {
    /// Folder name and state key; also how the settings page refers to it.
    pub id: String,
    /// Shown in the UI. Falls back to `id` when blank.
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub description: String,
    /// Script to run, relative to the plugin root — usually a `.cmd`.
    pub entry: String,
    /// Script to run when the plugin is stopped, relative to the plugin root.
    ///
    /// Optional, and not a duplicate of the process-tree kill that stopping
    /// always does: a plugin that `start`s helpers of its own — a daemon next to
    /// its panel, say — leaves them outside the tree the app can see, and only
    /// the plugin knows how to find and stop them. Absent, stopping is the tree
    /// kill alone.
    #[serde(default)]
    pub stop_script: Option<String>,
    /// Address of the page the plugin serves, embedded by the app. Empty for a
    /// plugin that has no interface.
    ///
    /// `{key}` stands for the current value of that config key, so a plugin
    /// whose port is a setting can still point at its own page:
    /// `http://127.0.0.1:{port}/`. The key may be an env file's flat key or a
    /// json/yaml dotted path; the sources are searched in declaration order.
    #[serde(default)]
    pub ui: String,
    /// Config files the app may read and rewrite, in declaration order. Each
    /// one is a "source": one block in the config window, one file on disk.
    ///
    /// A missing `configFiles` is legal — the plugin simply has no configurable
    /// files, and its page (if any) works as before.
    #[serde(default)]
    pub config_files: Vec<ConfigFileSource>,
}

impl PluginManifest {
    /// The name to show, never blank.
    pub fn display_name(&self) -> String {
        let name = self.name.trim();
        if name.is_empty() {
            self.id.clone()
        } else {
            name.to_string()
        }
    }
}

/// One config file a plugin declares, plus the keys the app may edit in it.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ConfigFileSource {
    /// Which adapter reads and writes the file.
    #[serde(rename = "type", default)]
    pub file_type: ConfigFileType,
    /// Where the file is. Relative to the plugin root by default; with
    /// [`ConfigFileSource::absolute`] it is used as written instead.
    pub path: String,
    /// Whether `path` names the file outright instead of being resolved against
    /// the plugin folder. Optional, and relative when absent.
    ///
    /// The flag is what lets a plugin edit a file outside its own folder (a
    /// shared data directory, say). It is the plugin author's own declaration
    /// in `plugin.json`, not input a user or an archive can steer at install
    /// time — a hostile plugin can already do far worse by running its entry
    /// script, so confining this path would be theatre. Such a file is read and
    /// written but never created: the plugin that owns it makes it on its first
    /// run, and an empty stand-in would stop that from happening.
    #[serde(default)]
    pub absolute: bool,
    /// Whether a run is refused while the file is missing. `false` lets a
    /// plugin generate the file itself on first boot.
    #[serde(default)]
    pub startmust: bool,
    /// Keys this source exposes to the config window, in declaration order.
    #[serde(default)]
    pub fields: Vec<ConfigField>,
}

/// The format adapter a source uses.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ConfigFileType {
    /// A text file of `KEY=VALUE` lines, comments allowed.
    #[default]
    Env,
    Json,
    Yaml,
}

/// One renderable setting, declared by the plugin.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ConfigField {
    /// Which value this field edits. Its meaning depends on the source's type:
    /// a flat key for `env` (dots are literal, not a path), a dotted path for
    /// `json`/`yaml`, where an all-numeric segment is an array index (`a.0.b`).
    pub key: String,
    #[serde(default)]
    pub label: String,
    #[serde(rename = "type", default)]
    pub field_type: FieldType,
    /// Value used until the user changes it; also what the UI shows for a
    /// freshly installed plugin.
    #[serde(default)]
    pub default: serde_json::Value,
    #[serde(default)]
    pub hint: Option<String>,
    /// Choices this field offers, as `{ value, label }` objects. A non-empty
    /// list makes the field a choice; a value off the list is refused on save.
    /// Empty (the default) leaves the field to render by its `type`.
    ///
    /// The two choice types differ in what they mean and how they render:
    /// `select` is an N-way dropdown, `boolean` a two-state toggle whose
    /// [`ConfigField::true_value`] names the option that means "on".
    #[serde(default)]
    pub options: Vec<SelectOption>,
    /// Which option is the "on" state. Required for a `boolean` that declares
    /// options, and forbidden on every other type: it is the toggle's whole
    /// point — the file's own on-literal, given by an option's `value`.
    #[serde(default)]
    pub true_value: Option<String>,
    /// Bounds for `number`.
    #[serde(default)]
    pub min: Option<f64>,
    #[serde(default)]
    pub max: Option<f64>,
}

/// One choice a field offers.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SelectOption {
    pub value: String,
    /// Shown in the dropdown, or on the toggle's button. Falls back to `value`
    /// when blank.
    #[serde(default)]
    pub label: String,
}

/// How the settings page renders a field.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum FieldType {
    #[default]
    String,
    Number,
    Boolean,
    Select,
    Textarea,
}

/// The manifest's own spelling of a field type, for error messages.
pub fn field_type_name(field_type: FieldType) -> &'static str {
    match field_type {
        FieldType::String => "string",
        FieldType::Number => "number",
        FieldType::Boolean => "boolean",
        FieldType::Select => "select",
        FieldType::Textarea => "textarea",
    }
}

/// Reads and validates the manifest in `dir`.
pub fn read(dir: &Path) -> Result<PluginManifest, String> {
    let path = dir.join(MANIFEST_FILE);
    let bytes =
        fs::read(&path).map_err(|error| format!("Failed to read {}: {error}", path.display()))?;
    let manifest: PluginManifest = serde_json::from_slice(strip_bom(&bytes))
        .map_err(|error| format!("Invalid {}: {error}", path.display()))?;
    validate(&manifest)?;
    Ok(manifest)
}

pub fn validate(manifest: &PluginManifest) -> Result<(), String> {
    validate_id(&manifest.id)?;

    if !is_contained(&manifest.entry) {
        return Err(format!(
            "Entry '{}' must be a relative path inside the plugin folder.",
            manifest.entry
        ));
    }

    if let Some(script) = manifest.stop_script.as_deref().map(str::trim) {
        if !script.is_empty() && !is_contained(script) {
            return Err(format!(
                "Stop script '{script}' must be a relative path inside the plugin folder."
            ));
        }
    }

    for source in &manifest.config_files {
        if source.path.trim().is_empty() {
            return Err("Every config file needs a path.".to_string());
        }

        // An `absolute` source names its own file; every other one is confined
        // to the plugin folder.
        if !source.absolute && !is_contained(&source.path) {
            return Err(format!(
                "Config file '{}' must be a relative path inside the plugin folder, or set \"absolute\": true to name a file outside it.",
                source.path
            ));
        }

        for field in &source.fields {
            if field.key.trim().is_empty() {
                return Err(format!(
                    "Every config field in '{}' needs a non-empty key.",
                    source.path
                ));
            }

            // `options` is the choice mechanism: a `select`'s list, or a
            // `boolean`'s two states. On the other types it would be silently
            // ignored, which hides a manifest typo.
            if !field.options.is_empty()
                && !matches!(field.field_type, FieldType::Boolean | FieldType::Select)
            {
                return Err(format!(
                    "Config field '{}' in '{}' declares options, but its type is '{}'. Options apply to 'boolean' and 'select'.",
                    field.key,
                    source.path,
                    field_type_name(field.field_type)
                ));
            }

            // `trueValue` is the toggle's "on" literal and nothing else, so it is
            // required on a boolean with options and has no meaning anywhere
            // else. A `select` carrying one would be ignored silently — a typo
            // with no symptom — so it is refused instead.
            if field.true_value.is_some()
                && !(field.field_type == FieldType::Boolean && !field.options.is_empty())
            {
                return Err(format!(
                    "Config field '{}' in '{}' declares trueValue, but only a boolean with options uses it.",
                    field.key, source.path
                ));
            }

            // A boolean's options come as one pair — the on and off states, in
            // that order. A third has nowhere to render on a two-state toggle and
            // would silently vanish, so it is refused. No options at all is the
            // plain on/off button and stays legal.
            if field.field_type == FieldType::Boolean && !field.options.is_empty() {
                if field.options.len() != 2 {
                    return Err(format!(
                        "Config field '{}' in '{}' is a boolean with options, so it must name exactly the on and off states (two entries).",
                        field.key, source.path
                    ));
                }

                // The toggle needs to know which of the two is "on". Without it
                // the UI would have to guess, which is the very thing options
                // exist to stop.
                let Some(true_value) = field.true_value.as_deref() else {
                    return Err(format!(
                        "Config field '{}' in '{}' is a boolean with options, so it must set trueValue to one of their values.",
                        field.key, source.path
                    ));
                };
                if !field
                    .options
                    .iter()
                    .any(|option| option.value == true_value)
                {
                    return Err(format!(
                        "Config field '{}' in '{}' has trueValue '{}', which is not one of its option values.",
                        field.key, source.path, true_value
                    ));
                }
            }
        }
    }

    if !manifest.ui.trim().is_empty() && !is_http_url(&manifest.ui) {
        return Err(format!(
            "UI '{}' must be an http:// or https:// address.",
            manifest.ui
        ));
    }

    Ok(())
}

/// Whether the app is willing to embed this address.
///
/// Only http(s) passes. The value becomes the `src` of an `<iframe>` in the app
/// window, where a `data:` or `javascript:` URL would be script the app itself
/// ends up running — the one place a plugin's manifest reaches into the app's
/// own origin. Checked against the template, before any `{key}` is filled in,
/// so the placeholder cannot smuggle a scheme in.
pub fn is_http_url(url: &str) -> bool {
    let url = url.trim().to_ascii_lowercase();
    let rest = url
        .strip_prefix("http://")
        .or_else(|| url.strip_prefix("https://"));

    // Something has to follow the scheme, and it cannot start with a slash:
    // `http:///x` names no host, so there would be nothing to load.
    matches!(rest, Some(rest) if !rest.is_empty() && !rest.starts_with('/'))
}

/// Rejects ids that would be unsafe as a folder name.
///
/// The id becomes a directory under `plugins/`, so a value like `..\\config`
/// would let a hostile zip name its own install path. Anything that is not a
/// plain name is refused rather than sanitized — a silently rewritten id would
/// make a plugin impossible to find again.
pub fn validate_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 64 {
        return Err("Plugin id must be 1-64 characters.".to_string());
    }
    if id.starts_with('.') {
        return Err(format!("Plugin id '{id}' may not start with '.'."));
    }
    if !id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    {
        return Err(format!(
            "Plugin id '{id}' may only contain letters, digits, '-', '_' and '.'."
        ));
    }
    Ok(())
}

/// True when `path` is relative and has no way out of its parent.
pub fn is_contained(path: &str) -> bool {
    let path = Path::new(path);
    !path.as_os_str().is_empty()
        && path.is_relative()
        // `Normal` is the only component that stays put: anything else is a
        // root, a prefix (`C:`) or a `..` hop.
        && path.components().all(|part| matches!(part, Component::Normal(_)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest(id: &str, entry: &str) -> PluginManifest {
        PluginManifest {
            id: id.to_string(),
            name: String::new(),
            version: String::new(),
            description: String::new(),
            entry: entry.to_string(),
            stop_script: None,
            ui: String::new(),
            config_files: Vec::new(),
        }
    }

    #[test]
    fn parses_a_manifest_and_defaults_the_field_types() {
        let parsed: PluginManifest = serde_json::from_str(
            r#"{
                "id": "sync-docs",
                "name": "文档同步",
                "entry": "run.cmd",
                "configFiles": [
                    {
                        "type": "env",
                        "path": ".env",
                        "startmust": true,
                        "fields": [
                            { "key": "TARGET", "label": "目标" },
                            { "key": "RETRIES", "label": "重试", "type": "number", "default": 3 },
                            { "key": "LEVEL", "label": "级别", "type": "select",
                              "options": [{ "value": "info" }] },
                            { "key": "PROXY", "label": "系统代理", "type": "boolean",
                              "options": [{ "value": "1", "label": "开" },
                                          { "value": "0", "label": "关" }],
                              "trueValue": "1" }
                        ]
                    },
                    { "type": "json", "path": "cfg.json", "fields": [] }
                ]
            }"#,
        )
        .unwrap();

        assert_eq!(parsed.id, "sync-docs");
        assert_eq!(parsed.display_name(), "文档同步");
        assert_eq!(parsed.config_files[0].file_type, ConfigFileType::Env);
        assert!(parsed.config_files[0].startmust);
        assert_eq!(
            parsed.config_files[0].fields[0].field_type,
            FieldType::String
        );
        assert_eq!(
            parsed.config_files[0].fields[1].field_type,
            FieldType::Number
        );
        assert_eq!(
            parsed.config_files[0].fields[1].default,
            serde_json::json!(3)
        );
        assert_eq!(
            parsed.config_files[0].fields[2].field_type,
            FieldType::Select
        );
        assert_eq!(parsed.config_files[0].fields[2].options[0].value, "info");
        assert_eq!(parsed.config_files[0].fields[3].options[0].value, "1");
        assert_eq!(parsed.config_files[0].fields[3].options[0].label, "开");
        assert_eq!(
            parsed.config_files[0].fields[3].true_value.as_deref(),
            Some("1")
        );
        assert_eq!(parsed.config_files[1].file_type, ConfigFileType::Json);
        // `startmust` defaults to false.
        assert!(!parsed.config_files[1].startmust);
        validate(&parsed).unwrap();
    }

    #[test]
    fn a_manifest_with_no_config_files_is_valid() {
        let parsed: PluginManifest =
            serde_json::from_str(r#"{"id":"plain","entry":"run.cmd"}"#).unwrap();
        assert!(parsed.config_files.is_empty());
        validate(&parsed).unwrap();
    }

    /// Every example shipped under `examples/` must be a manifest this app would
    /// actually accept, so a developer copying one never inherits a manifest the
    /// loader would reject.
    #[test]
    fn the_shipped_examples_are_valid_manifests() {
        let examples = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("examples");
        let entries = fs::read_dir(&examples)
            .unwrap_or_else(|error| panic!("cannot read {}: {error}", examples.display()));

        let mut checked = 0;
        for entry in entries {
            let dir = entry.unwrap().path();
            if !dir.join(MANIFEST_FILE).is_file() {
                continue;
            }
            let manifest = read(&dir)
                .unwrap_or_else(|error| panic!("{} does not load: {error}", dir.display()));

            // The id has to match the folder, or installing the example would
            // land it somewhere other than where a reader expects to look.
            assert_eq!(
                manifest.id,
                dir.file_name().unwrap().to_string_lossy(),
                "{} declares a different id",
                dir.display()
            );
            checked += 1;
        }

        assert!(
            checked > 0,
            "no examples were found under {}",
            examples.display()
        );
    }

    #[test]
    fn options_are_allowed_on_boolean_and_select_but_no_other_type() {
        // A boolean's options must come as a pair with a trueValue; a select's
        // may be any length. Both are exercised so the gate is about the type,
        // not the shape.
        let with_type = |field_type: &str, extra: &str| {
            let text = format!(
                r#"{{"id":"a","entry":"run.cmd","configFiles":[{{"type":"env","path":".env","fields":[{{"key":"K","type":"{field_type}","options":[{{"value":"x"}},{{"value":"y"}}]{extra}}}]}}]}}"#
            );
            serde_json::from_str::<PluginManifest>(&text).unwrap()
        };

        for field_type in ["boolean", "select"] {
            let extra = if field_type == "boolean" {
                r#","trueValue":"x""#
            } else {
                ""
            };
            validate(&with_type(field_type, extra)).unwrap_or_else(|error| {
                panic!("{field_type} with options should be valid: {error}")
            });
        }

        // On a type that has no choices to offer, options would be ignored
        // silently — a manifest typo with no symptom, so it is refused.
        for field_type in ["string", "number", "textarea"] {
            assert!(
                validate(&with_type(field_type, "")).is_err(),
                "{field_type} with options should be rejected"
            );
        }
    }

    #[test]
    fn a_boolean_with_options_needs_a_matching_true_value() {
        let with_bool = |field: &str| {
            let text = format!(
                r#"{{"id":"a","entry":"run.cmd","configFiles":[{{"type":"env","path":".env","fields":[{{"key":"K","type":"boolean"{field}}}]}}]}}"#
            );
            serde_json::from_str::<PluginManifest>(&text).unwrap()
        };

        // No options is the plain on/off button, and needs no trueValue.
        validate(&with_bool("")).unwrap();

        // The toggle: exactly the two states plus a trueValue naming one.
        validate(&with_bool(
            r#","options":[{"value":"1"},{"value":"0"}],"trueValue":"1""#,
        ))
        .unwrap();

        // Missing trueValue: the UI would have to guess which state is "on".
        assert!(validate(&with_bool(r#","options":[{"value":"1"},{"value":"0"}]"#,)).is_err());

        // trueValue naming no option.
        assert!(validate(&with_bool(
            r#","options":[{"value":"1"},{"value":"0"}],"trueValue":"yes""#,
        ))
        .is_err());

        // A third state has nowhere to render on a two-state toggle.
        assert!(validate(&with_bool(
            r#","options":[{"value":"1"},{"value":"0"},{"value":"x"}],"trueValue":"1""#,
        ))
        .is_err());

        // trueValue on a boolean with no options has nothing to point at.
        assert!(validate(&with_bool(r#","trueValue":"1""#)).is_err());
    }

    #[test]
    fn a_select_may_not_declare_a_true_value() {
        let with_select = |extra: &str| {
            let text = format!(
                r#"{{"id":"a","entry":"run.cmd","configFiles":[{{"type":"env","path":".env","fields":[{{"key":"K","type":"select","options":[{{"value":"x"}}]{extra}}}]}}]}}"#
            );
            serde_json::from_str::<PluginManifest>(&text).unwrap()
        };

        validate(&with_select("")).unwrap();
        // trueValue means nothing on a select, so writing one is a silent typo.
        assert!(validate(&with_select(r#","trueValue":"x""#)).is_err());
    }

    #[test]
    fn a_blank_name_falls_back_to_the_id() {
        assert_eq!(manifest("a", "run.cmd").display_name(), "a");
    }

    #[test]
    fn rejects_ids_that_could_escape_the_plugins_folder() {
        for id in ["", "..", "../evil", "a/b", "a\\b", "C:", ".hidden", "a b"] {
            assert!(validate_id(id).is_err(), "{id} should be rejected");
        }
        for id in ["sync-docs", "a_b.c", "Plugin2"] {
            validate_id(id).unwrap_or_else(|error| panic!("{id} should be allowed: {error}"));
        }
    }

    #[test]
    fn rejects_entries_outside_the_plugin_folder() {
        for entry in ["", "..\\run.cmd", "/run.cmd", "bin/../../run.cmd"] {
            assert!(!is_contained(entry), "{entry} should be rejected");
        }
        for entry in ["run.cmd", "bin/run.cmd", "scripts/sync all.cmd"] {
            assert!(is_contained(entry), "{entry} should be allowed");
        }

        let mut bad = manifest("a", "..\\run.cmd");
        assert!(validate(&bad).is_err());
        bad.entry = "run.cmd".to_string();
        validate(&bad).unwrap();
    }

    #[test]
    fn only_http_addresses_may_be_embedded() {
        for url in [
            "http://127.0.0.1:11212/",
            "http://127.0.0.1:{port}/",
            "https://example.com/x",
            "HTTP://LOCALHOST/",
        ] {
            assert!(is_http_url(url), "{url} should be allowed");
        }

        for url in [
            "",
            "javascript:alert(1)",
            "data:text/html,<script>alert(1)</script>",
            "file:///c:/x",
            // No host to load.
            "http:///nohost",
            "http://",
        ] {
            assert!(!is_http_url(url), "{url} should be rejected");
        }
    }

    #[test]
    fn a_bad_or_missing_ui_is_the_only_thing_that_changes() {
        let mut good = manifest("a", "run.cmd");
        // No UI at all is the common case, and it must stay valid.
        validate(&good).unwrap();

        good.ui = "http://127.0.0.1:{port}/".to_string();
        validate(&good).unwrap();

        good.ui = "javascript:alert(1)".to_string();
        assert!(validate(&good).is_err());
    }

    #[test]
    fn a_stop_script_is_optional_and_must_stay_inside_the_folder() {
        let parsed: PluginManifest =
            serde_json::from_str(r#"{"id":"a","entry":"start.cmd","stopScript":"stop.cmd"}"#)
                .unwrap();
        assert_eq!(parsed.stop_script.as_deref(), Some("stop.cmd"));
        validate(&parsed).unwrap();

        // No stop script is the common case, not an error.
        let plain: PluginManifest =
            serde_json::from_str(r#"{"id":"a","entry":"start.cmd"}"#).unwrap();
        assert!(plain.stop_script.is_none());
        validate(&plain).unwrap();

        for script in ["..\\stop.cmd", "/stop.cmd", "bin/../../stop.cmd"] {
            let mut bad = manifest("a", "start.cmd");
            bad.stop_script = Some(script.to_string());
            assert!(validate(&bad).is_err(), "{script} should be rejected");
        }
    }

    #[test]
    fn rejects_config_fields_without_a_key() {
        let mut bad = manifest("a", "run.cmd");
        bad.config_files.push(ConfigFileSource {
            file_type: ConfigFileType::Env,
            path: ".env".to_string(),
            absolute: false,
            startmust: false,
            fields: vec![ConfigField {
                key: "  ".to_string(),
                label: "x".to_string(),
                field_type: FieldType::String,
                default: serde_json::Value::Null,
                hint: None,
                options: Vec::new(),
                true_value: None,
                min: None,
                max: None,
            }],
        });
        assert!(validate(&bad).is_err());
    }

    #[test]
    fn rejects_config_files_outside_the_plugin_folder() {
        for path in [
            "",
            "..\\run.cmd",
            "bin/../../secret",
            "a/../..",
            "/etc/passwd",
        ] {
            let mut bad = manifest("a", "run.cmd");
            bad.config_files.push(ConfigFileSource {
                file_type: ConfigFileType::Json,
                path: path.to_string(),
                absolute: false,
                startmust: false,
                fields: Vec::new(),
            });
            assert!(validate(&bad).is_err(), "{path} should be rejected");
        }

        for path in [
            ".env",
            "upstream/config.json",
            "cfg.yaml",
            "sub/dir/cfg.json",
        ] {
            let mut good = manifest("a", "run.cmd");
            good.config_files.push(ConfigFileSource {
                file_type: ConfigFileType::Json,
                path: path.to_string(),
                absolute: false,
                startmust: false,
                fields: Vec::new(),
            });
            validate(&good).unwrap_or_else(|error| panic!("{path} should be allowed: {error}"));
        }
    }

    #[test]
    fn an_absolute_source_may_name_a_file_outside_the_folder() {
        // A plugin may point at a file outside its folder — a shared data
        // directory, say. The declaration is the author's, so with the flag set
        // it is taken as given rather than confined.
        for path in [
            "/etc/passwd",
            "\\\\server\\share\\cfg.yaml",
            "..\\..\\outside.yaml",
        ] {
            let mut good = manifest("a", "run.cmd");
            good.config_files.push(ConfigFileSource {
                file_type: ConfigFileType::Yaml,
                path: path.to_string(),
                absolute: true,
                startmust: false,
                fields: Vec::new(),
            });
            validate(&good).unwrap_or_else(|error| panic!("{path} should be allowed: {error}"));
        }

        // A blank path is still nothing to read or write, flag or no flag.
        let mut bad = manifest("a", "run.cmd");
        bad.config_files.push(ConfigFileSource {
            file_type: ConfigFileType::Yaml,
            path: "   ".to_string(),
            absolute: true,
            startmust: false,
            fields: Vec::new(),
        });
        assert!(validate(&bad).is_err());
    }

    #[test]
    fn an_absolute_source_is_optional_and_defaults_to_relative() {
        let parsed: PluginManifest = serde_json::from_str(
            r#"{"id":"a","entry":"run.cmd","configFiles":[
                 {"type":"env","path":".env"},
                 {"type":"yaml","path":"C:\\elsewhere\\cfg.yaml","absolute":true}
               ]}"#,
        )
        .unwrap();
        assert!(!parsed.config_files[0].absolute);
        assert!(parsed.config_files[1].absolute);
        validate(&parsed).unwrap();
    }
}
