//! Splitting SQL scripts into statements (`;`-terminated), aware of string
//! literals, quoted identifiers, comments and PostgreSQL dollar quoting.
//! Offsets are UTF-16 code units, like everything on the IPC boundary.
//!
//! Ported from `ide_db::split` of the reference project (Apache-2.0). The
//! Oracle PL/SQL rules (blocks, `END;`, the SQL*Plus `/` terminator) are gone
//! with the Oracle driver, which keeps this file small.

use serde::{Deserialize, Serialize};

use crate::source::DbDriver;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlStatement {
    /// UTF-16 offsets of the statement text (whitespace trimmed, `;` excluded).
    pub from: u32,
    pub to: u32,
    pub text: String,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum State {
    Code,
    Single,
    Double,
    Backtick,
    LineComment,
    BlockComment,
}

/// Every statement of `text` that contains more than whitespace and comments.
pub fn split(text: &str, driver: DbDriver) -> Vec<SqlStatement> {
    let mysql = driver == DbDriver::Mysql;
    let chars: Vec<(usize, char)> = text.char_indices().collect();
    // UTF-16 offset of each char index (plus the end).
    let mut u16_at = Vec::with_capacity(chars.len() + 1);
    let mut offset = 0u32;
    for &(_, c) in &chars {
        u16_at.push(offset);
        offset += c.len_utf16() as u32;
    }
    u16_at.push(offset);
    let byte_at = |i: usize| chars.get(i).map_or(text.len(), |c| c.0);

    let mut out = Vec::new();
    let mut state = State::Code;
    let mut start = 0usize;
    // Whether the current segment has anything but whitespace / comments.
    let mut has_code = false;
    let mut i = 0usize;
    let push = |out: &mut Vec<SqlStatement>, s: usize, e: usize, has_code: bool| {
        if !has_code {
            return;
        }
        let segment = &text[byte_at(s)..byte_at(e)];
        let lead = segment.len() - segment.trim_start().len();
        let trimmed = segment.trim();
        if trimmed.is_empty() {
            return;
        }
        let leading_chars = segment[..lead].chars().count();
        let trimmed_chars = trimmed.chars().count();
        out.push(SqlStatement {
            from: u16_at[s + leading_chars],
            to: u16_at[s + leading_chars + trimmed_chars],
            text: trimmed.to_owned(),
        });
    };
    while i < chars.len() {
        let c = chars[i].1;
        let next = chars.get(i + 1).map(|c| c.1);
        match state {
            State::Code => match c {
                ';' => {
                    push(&mut out, start, i, has_code);
                    start = i + 1;
                    has_code = false;
                }
                '\'' => {
                    state = State::Single;
                    has_code = true;
                }
                '"' => {
                    state = State::Double;
                    has_code = true;
                }
                '`' if mysql => {
                    state = State::Backtick;
                    has_code = true;
                }
                '/' if next == Some('*') => {
                    state = State::BlockComment;
                    i += 1;
                }
                '-' if next == Some('-') => {
                    state = State::LineComment;
                    i += 1;
                }
                '#' if mysql => state = State::LineComment,
                '$' if driver == DbDriver::Postgres => {
                    // `$tag$ … $tag$` (tag may be empty); `$1` parameters are not quotes.
                    let rest = &text[byte_at(i)..];
                    let tag_len = rest[1..].find('$').filter(|&n| {
                        rest[1..1 + n].chars().all(|c| c.is_alphanumeric() || c == '_')
                            && !rest[1..1 + n].starts_with(|c: char| c.is_ascii_digit())
                    });
                    has_code = true;
                    if let Some(n) = tag_len {
                        let tag = &rest[..n + 2];
                        let body_start = byte_at(i) + tag.len();
                        let close = text[body_start..].find(tag).map_or(text.len(), |p| body_start + p + tag.len());
                        // Jump to the char at byte `close`.
                        while i < chars.len() && chars[i].0 < close {
                            i += 1;
                        }
                        continue;
                    }
                }
                c if !c.is_whitespace() => has_code = true,
                _ => {}
            },
            State::Single => {
                if mysql && c == '\\' {
                    i += 1;
                } else if c == '\'' {
                    if next == Some('\'') {
                        i += 1;
                    } else {
                        state = State::Code;
                    }
                }
            }
            State::Double => {
                if c == '"' {
                    if next == Some('"') {
                        i += 1;
                    } else {
                        state = State::Code;
                    }
                }
            }
            State::Backtick => {
                if c == '`' {
                    state = State::Code;
                }
            }
            State::LineComment => {
                if c == '\n' {
                    state = State::Code;
                }
            }
            State::BlockComment => {
                if c == '*' && next == Some('/') {
                    state = State::Code;
                    i += 1;
                }
            }
        }
        i += 1;
    }
    push(&mut out, start, chars.len(), has_code);
    out
}

/// The statement to run for a caret at `offset` (UTF-16): the one containing
/// it, else the nearest one before it (caret after `;` or on a blank line
/// below), else the next one.
pub fn statement_at(text: &str, offset: u32, driver: DbDriver) -> Option<SqlStatement> {
    let all = split(text, driver);
    if let Some(statement) = all.iter().find(|s| s.from <= offset && offset <= s.to) {
        return Some(statement.clone());
    }
    // Between statements: the previous one when only whitespace / `;` separates it from the caret.
    let previous = all.iter().rev().find(|s| s.to <= offset);
    let next = all.iter().find(|s| s.from > offset);
    match (previous, next) {
        (Some(previous), Some(next)) => {
            let gap = utf16_slice(text, previous.to, offset);
            if gap.matches('\n').count() <= 1 { Some(previous.clone()) } else { Some(next.clone()) }
        }
        (Some(previous), None) => Some(previous.clone()),
        (None, next) => next.cloned(),
    }
}

/// Statements overlapping the UTF-16 range `from..to` (a selection): the
/// selected text itself, split.
pub fn statements_in(text: &str, from: u32, to: u32, driver: DbDriver) -> Vec<SqlStatement> {
    let selected = utf16_slice(text, from, to);
    split(selected, driver)
        .into_iter()
        .map(|statement| SqlStatement { from: statement.from + from, to: statement.to + from, ..statement })
        .collect()
}

fn utf16_slice(text: &str, from: u32, to: u32) -> &str {
    let mut offset = 0u32;
    let (mut start, mut end) = (text.len(), text.len());
    for (index, c) in text.char_indices() {
        if offset == from && start == text.len() {
            start = index;
        }
        if offset == to {
            end = index;
            break;
        }
        offset += c.len_utf16() as u32;
    }
    if start > end { "" } else { &text[start..end] }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn texts(sql: &str, driver: DbDriver) -> Vec<String> {
        split(sql, driver).into_iter().map(|statement| statement.text).collect()
    }

    #[test]
    fn splits_on_semicolons_outside_literals_and_comments() {
        let sql = "select 'a;b' as x; -- c;d\nselect \"x;y\" from t /* ; */;\n\n-- only a comment;\n";
        assert_eq!(
            texts(sql, DbDriver::Sqlite),
            vec!["select 'a;b' as x", "-- c;d\nselect \"x;y\" from t /* ; */"]
        );
    }

    #[test]
    fn mysql_backticks_hashes_and_backslashes() {
        let sql = "select `a;b`, 'it\\'s;' from t # x;y\n; select 2";
        assert_eq!(texts(sql, DbDriver::Mysql), vec!["select `a;b`, 'it\\'s;' from t # x;y", "select 2"]);
    }

    #[test]
    fn postgres_dollar_quotes() {
        let sql =
            "create function f() returns int as $$ select 1; $$ language sql; select $1::int; do $x$ begin; end $x$";
        assert_eq!(
            texts(sql, DbDriver::Postgres),
            vec![
                "create function f() returns int as $$ select 1; $$ language sql",
                "select $1::int",
                "do $x$ begin; end $x$"
            ]
        );
    }

    #[test]
    fn utf16_offsets() {
        let sql = "select '😀';\nselect 2;";
        let statements = split(sql, DbDriver::Sqlite);
        assert_eq!((statements[0].from, statements[0].to), (0, 11));
        assert_eq!((statements[1].from, statements[1].to), (13, 21));
    }

    #[test]
    fn statement_at_caret() {
        let sql = "select 1;\nselect 2;\n\n\nselect 3";
        let at = |offset| statement_at(sql, offset, DbDriver::Sqlite).map(|statement| statement.text);
        assert_eq!(at(0).as_deref(), Some("select 1"));
        assert_eq!(at(9).as_deref(), Some("select 1"), "right after ;");
        assert_eq!(at(12).as_deref(), Some("select 2"));
        assert_eq!(at(20).as_deref(), Some("select 2"), "end of line after ;");
        assert_eq!(at(21).as_deref(), Some("select 3"), "after blank lines, the next one");
        assert_eq!(at(30).as_deref(), Some("select 3"));
        assert_eq!(statement_at("  ", 1, DbDriver::Sqlite), None);
    }

    #[test]
    fn selection() {
        let sql = "x; select 1; select 2; y";
        let statements = statements_in(sql, 3, 21, DbDriver::Sqlite);
        assert_eq!(
            statements.iter().map(|statement| statement.text.as_str()).collect::<Vec<_>>(),
            vec!["select 1", "select 2"]
        );
        assert_eq!((statements[1].from, statements[1].to), (13, 21));
    }
}
