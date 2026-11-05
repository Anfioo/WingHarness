//! The `env` adapter: a text file of `KEY=VALUE` lines.
//!
//! Write-back is line surgery. A file a plugin ships is documentation as much
//! as configuration — the `#` comments explain what each key does — so only the
//! line holding an edited key may change. Comments, blank lines, other keys and
//! the file's own line endings all survive exactly as they were.

use std::path::Path;

use serde_json::{Map, Value};

use super::{atomic_write, read_text, ConfigFile};

pub(super) struct EnvFile;

impl ConfigFile for EnvFile {
    fn read(&self, path: &Path, keys: &[String]) -> Result<Map<String, Value>, String> {
        let text = read_text(path)?;
        let mut values = Map::new();

        for line in text.lines() {
            // A dot inside an env key is part of the name, not a path segment,
            // so this lookup is a plain key match.
            let Some((key, value)) = parse_line(line) else {
                continue;
            };
            if keys.iter().any(|wanted| wanted == key) {
                values.insert(key.to_string(), Value::String(unquote(value)));
            }
        }

        Ok(values)
    }

    fn write(&self, path: &Path, edits: &Map<String, Value>) -> Result<(), String> {
        let newline = if path.is_file() {
            detect_newline(&read_text(path)?)
        } else {
            "\n"
        };

        // Editing a file that is not there creates it from the declared keys:
        // a plugin with no `.env` yet is exactly the case this is for.
        let original = if path.is_file() {
            read_text(path)?
        } else {
            String::new()
        };
        let had_bom = std::fs::read(path)
            .ok()
            .is_some_and(|bytes| bytes.starts_with(&[0xEF, 0xBB, 0xBF]));

        let mut lines: Vec<String> = if original.is_empty() {
            Vec::new()
        } else {
            original
                .split('\n')
                .map(|line| line.trim_end_matches('\r').to_string())
                .collect()
        };

        // A trailing newline leaves an empty final element; writing it back
        // would add a blank line on every save, so it is added once at the end.
        let trailing = lines.last().is_some_and(|line| line.is_empty());
        if trailing {
            lines.pop();
        }

        let mut remaining: Vec<(&String, &Value)> = edits.iter().collect();

        for line in lines.iter_mut() {
            let Some((key, original_value)) = parse_line(line) else {
                continue;
            };
            let Some(position) = remaining
                .iter()
                .position(|(edited, _)| edited.as_str() == key)
            else {
                continue;
            };

            let (edited, value) = remaining.remove(position);
            let suffix = inline_comment_suffix(original_value);
            *line = format!("{edited}={}{suffix}", render(value));
        }

        // Keys the file did not hold are appended, in declaration order, with no
        // invented comment lines.
        for (key, value) in remaining {
            lines.push(format!("{key}={}", render(value)));
        }

        let mut output = lines.join(newline);
        // Empty files stay empty rather than gaining a lone newline.
        if !output.is_empty() {
            output.push_str(newline);
        }

        let mut bytes = Vec::new();
        if had_bom {
            bytes.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
        }
        bytes.extend_from_slice(output.as_bytes());

        atomic_write(path, &bytes)
    }
}

/// Splits a line into `(key, raw value)` when it is a real assignment.
///
/// Returns `None` for comments, blanks and lines with no `=`.
fn parse_line(line: &str) -> Option<(&str, &str)> {
    let trimmed = line.trim_start();
    if trimmed.is_empty() || trimmed.starts_with('#') {
        return None;
    }

    let (key, value) = line.split_once('=')?;
    let key = key.trim();
    if key.is_empty() || key.contains(char::is_whitespace) {
        return None;
    }
    Some((key, value))
}

/// The inline ` # comment` on a value, with a single leading space, or empty.
///
/// Only a `#` preceded by whitespace starts a comment; `a#b` is a literal `#`
/// inside the value. Run of whitespace before the `#` is trimmed to one space,
/// so rewriting a value does not reflow the line.
fn inline_comment_suffix(value: &str) -> &str {
    let bytes = value.as_bytes();
    for (index, byte) in bytes.iter().enumerate() {
        if *byte == b'#' && index > 0 && bytes[index - 1].is_ascii_whitespace() {
            let mut start = index;
            while start > 0 && bytes[start - 1].is_ascii_whitespace() {
                start -= 1;
            }
            // Keep exactly the one space that separated value from comment.
            return &value[start..];
        }
    }
    ""
}

/// The value with its inline comment removed, both ends trimmed.
fn value_without_comment(value: &str) -> &str {
    let suffix = inline_comment_suffix(value);
    let end = value.len() - suffix.len();
    value[..end].trim()
}

/// Strips one matched pair of surrounding quotes.
fn unquote(value: &str) -> String {
    let value = value_without_comment(value);
    let bytes = value.as_bytes();

    if value.len() >= 2 {
        let first = bytes[0];
        let last = bytes[bytes.len() - 1];
        if (first == b'"' && last == b'"') || (first == b'\'' && last == b'\'') {
            return value[1..value.len() - 1].to_string();
        }
    }

    value.to_string()
}

/// Renders a value the way env files hold it: no quotes, numbers bare,
/// booleans as `true` / `false`.
fn render(value: &Value) -> String {
    match value {
        Value::String(text) => text.trim().to_string(),
        Value::Number(number) => number.to_string(),
        Value::Bool(flag) => flag.to_string(),
        Value::Null => String::new(),
        Value::Array(_) | Value::Object(_) => String::new(),
    }
}

/// The line ending a file already uses, so a save does not change it.
fn detect_newline(text: &str) -> &'static str {
    if text.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_keys_and_ignores_comments_and_blanks() {
        assert_eq!(parse_line("A=1"), Some(("A", "1")));
        assert_eq!(parse_line("  B = 2  "), Some(("B", " 2  ")));
        assert_eq!(parse_line("# comment"), None);
        assert_eq!(parse_line("   "), None);
        assert_eq!(parse_line("NO EQUALS"), None);
    }

    #[test]
    fn an_inline_comment_is_kept_and_not_part_of_the_value() {
        assert_eq!(inline_comment_suffix("7864  # the port"), "  # the port");
        assert_eq!(inline_comment_suffix("a#b"), "");
        assert_eq!(unquote("7864  # the port"), "7864");
    }

    #[test]
    fn matched_quotes_are_unwrapped() {
        assert_eq!(unquote("\"hello world\""), "hello world");
        assert_eq!(unquote("'single'"), "single");
        assert_eq!(unquote("\"unbalanced"), "\"unbalanced");
        assert_eq!(unquote("plain"), "plain");
    }

    #[test]
    fn values_render_without_quotes() {
        assert_eq!(render(&json!("127.0.0.1")), "127.0.0.1");
        assert_eq!(render(&json!(7864)), "7864");
        assert_eq!(render(&json!(true)), "true");
    }
}
