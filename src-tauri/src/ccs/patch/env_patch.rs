//! `.env` / dotenv 配置改写（逐行处理，保留注释、空行和其他 KEY）。
//!
//! 用于 Gemini CLI 的 `.env`。键路径只取最后一段作为环境变量名。

use super::PatchOp;

/// 把一组操作应用到 ENV 文本上，返回改写后的文本。
pub fn apply(contents: &str, ops: &[PatchOp]) -> Result<String, String> {
    let mut lines: Vec<String> = contents.lines().map(|l| l.to_string()).collect();

    for op in ops {
        let path = op.path();
        let key = match path.last() {
            Some(k) => k,
            None => continue,
        };
        match op {
            PatchOp::Set { value, .. } => {
                let rendered = format_env_value(value);
                let line = format!("{key}={rendered}");
                let idx = find_key_line(&lines, key);
                match idx {
                    Some(i) => lines[i] = line,
                    None => lines.push(line),
                }
            }
            PatchOp::Remove { .. } => {
                if let Some(i) = find_key_line(&lines, key) {
                    lines.remove(i);
                }
            }
        }
    }

    // 保留文件末尾换行；新增内容时也补一个换行。
    let mut out = lines.join("\n");
    if contents.ends_with('\n') || (!out.is_empty() && !contents.is_empty()) {
        out.push('\n');
    }
    Ok(out)
}

/// 找到 `KEY=` 起始行的索引（忽略前导空白）。
fn find_key_line(lines: &[String], key: &str) -> Option<usize> {
    lines.iter().position(|l| {
        let trimmed = l.trim_start();
        trimmed == key
            || trimmed.starts_with(&format!("{key}="))
            || trimmed.starts_with(&format!("{key} ="))
    })
}

/// 枚举现有 ENV 中所有属于 floor 的键，返回对应的 Remove 操作。
pub fn floor_removals(contents: &str, is_floor: &dyn Fn(&[String]) -> bool) -> Vec<PatchOp> {
    let mut ops = Vec::new();
    for line in contents.lines() {
        let trimmed = line.trim_start();
        // 跳过注释与空行。
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if let Some(eq_pos) = trimmed.find('=') {
            let key = trimmed[..eq_pos].trim();
            let path = vec![key.to_string()];
            if is_floor(&path) {
                ops.push(PatchOp::remove(&[key]));
            }
        }
    }
    ops
}

/// 把 JSON 值渲染成 env 值；字符串原样，其他类型简单转字符串。
/// 含空格/特殊字符的字符串用双引号包裹。
fn format_env_value(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::String(s) => {
            if s.is_empty() {
                String::new()
            } else if needs_quoting(s) {
                format!("\"{}\"", s.replace('"', "\\\""))
            } else {
                s.clone()
            }
        }
        serde_json::Value::Null => String::new(),
        other => other.to_string(),
    }
}

fn needs_quoting(s: &str) -> bool {
    s.contains(' ') || s.contains('#') || s.contains('\n') || s.starts_with('"')
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn adds_then_updates_key() {
        let ops = vec![PatchOp::set(&["KEY_A"], json!("one"))];
        let out = apply("", &ops).unwrap();
        assert!(out.contains("KEY_A=one"));

        let ops2 = vec![PatchOp::set(&["KEY_A"], json!("two"))];
        let out2 = apply(&out, &ops2).unwrap();
        assert!(out2.contains("KEY_A=two"));
        assert!(!out2.contains("KEY_A=one"));
    }

    #[test]
    fn preserves_other_lines_and_comments() {
        let input = "# comment\nKEY_B=2\n";
        let ops = vec![PatchOp::set(&["KEY_A"], json!("1"))];
        let out = apply(input, &ops).unwrap();
        assert!(out.contains("# comment"));
        assert!(out.contains("KEY_B=2"));
        assert!(out.contains("KEY_A=1"));
    }

    #[test]
    fn removes_key_only() {
        let input = "KEY_A=1\nKEY_B=2\n";
        let ops = vec![PatchOp::remove(&["KEY_A"])];
        let out = apply(input, &ops).unwrap();
        assert!(!out.contains("KEY_A"));
        assert!(out.contains("KEY_B=2"));
    }

    #[test]
    fn quotes_values_with_spaces() {
        let ops = vec![PatchOp::set(&["KEY_A"], json!("a b"))];
        let out = apply("", &ops).unwrap();
        assert!(out.contains("KEY_A=\"a b\""));
    }
}
