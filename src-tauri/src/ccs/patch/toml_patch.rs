//! TOML 配置改写（toml_edit，保留键顺序、注释与空行）。
//!
//! 用于 Codex 和 Grok Build 的 config.toml。嵌套对象以内联表（inline table）
//! 形式写入，避免与 TOML 的顶层 `[a.b]` 表结构冲突。

use toml_edit::{DocumentMut, InlineTable, Item, TableLike, Value as TValue};

use super::PatchOp;

/// 把一组操作应用到 TOML 文本上，返回改写后的文本。
pub fn apply(contents: &str, ops: &[PatchOp]) -> Result<String, String> {
    let mut doc = if contents.trim().is_empty() {
        DocumentMut::new()
    } else {
        contents
            .parse::<DocumentMut>()
            .map_err(|e| format!("Invalid TOML: {e}"))?
    };

    for op in ops {
        match op {
            PatchOp::Set { path, value } => {
                let Some((key, parents)) = path.split_last() else {
                    continue;
                };
                let table = navigate_for_write(&mut doc, parents)?;
                table.insert(key, Item::Value(json_to_toml(value)));
            }
            PatchOp::Remove { path } => {
                let Some((key, parents)) = path.split_last() else {
                    continue;
                };
                if let Some(table) = navigate_for_remove(&mut doc, parents) {
                    table.remove(key);
                }
            }
        }
    }

    Ok(doc.to_string())
}

/// 枚举现有 TOML 中所有属于 floor 的键路径，返回对应的 Remove 操作。
///
/// 若某父路径本身就是 floor，只删除父路径、不再深入。
pub fn floor_removals(contents: &str, is_floor: &dyn Fn(&[String]) -> bool) -> Vec<PatchOp> {
    let Ok(doc) = contents.parse::<DocumentMut>() else {
        return Vec::new();
    };
    let mut ops = Vec::new();
    collect_table(doc.as_table(), &[], is_floor, &mut ops);
    ops
}

fn collect_table(
    table: &dyn TableLike,
    prefix: &[String],
    is_floor: &dyn Fn(&[String]) -> bool,
    ops: &mut Vec<PatchOp>,
) {
    let keys: Vec<String> = table.iter().map(|(k, _)| k.to_string()).collect();
    for key in keys {
        let mut path = prefix.to_vec();
        path.push(key.clone());
        if is_floor(&path) {
            let path_ref: Vec<&str> = path.iter().map(|s| s.as_str()).collect();
            ops.push(PatchOp::remove(&path_ref));
        } else if let Some(child) = table.get(&key).and_then(|item| item.as_table_like()) {
            collect_table(child, &path, is_floor, ops);
        }
    }
}

/// 导航/创建 parents 指向的表，返回可插入末端键的表。
fn navigate_for_write<'a>(
    doc: &'a mut DocumentMut,
    parents: &[String],
) -> Result<&'a mut dyn TableLike, String> {
    let mut current: &'a mut dyn TableLike = doc.as_table_mut();
    for key in parents {
        let is_table = current
            .get(key)
            .map(|item| item.is_table_like())
            .unwrap_or(false);
        if !is_table {
            current.insert(key, Item::Table(toml_edit::Table::new()));
        }
        current = current
            .get_mut(key)
            .and_then(|item| item.as_table_like_mut())
            .ok_or_else(|| format!("Cannot navigate into {key}: not a table"))?;
    }
    Ok(current)
}

/// 导航到 parents 指向的表用于删除；任一层缺失返回 None。
fn navigate_for_remove<'a>(
    doc: &'a mut DocumentMut,
    parents: &[String],
) -> Option<&'a mut dyn TableLike> {
    let mut current: &'a mut dyn TableLike = doc.as_table_mut();
    for key in parents {
        current = current.get_mut(key)?.as_table_like_mut()?;
    }
    Some(current)
}

/// serde_json::Value → toml_edit::Value。
fn json_to_toml(v: &serde_json::Value) -> TValue {
    match v {
        serde_json::Value::Null => TValue::from(""),
        serde_json::Value::Bool(b) => TValue::from(*b),
        serde_json::Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                TValue::from(i)
            } else if let Some(f) = n.as_f64() {
                TValue::from(f)
            } else {
                TValue::from("")
            }
        }
        serde_json::Value::String(s) => TValue::from(s.as_str()),
        serde_json::Value::Array(arr) => {
            let mut out = toml_edit::Array::new();
            for item in arr {
                out.push(json_to_toml(item));
            }
            TValue::Array(out)
        }
        serde_json::Value::Object(map) => {
            let mut table = InlineTable::new();
            for (k, val) in map {
                table.insert(k, json_to_toml(val));
            }
            TValue::InlineTable(table)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn sets_top_level_and_preserves_comments() {
        let input = "# keep me\nmodel = \"old\"\n";
        let ops = vec![PatchOp::set(&["model_provider"], json!("custom"))];
        let out = apply(input, &ops).unwrap();
        assert!(out.contains("# keep me"));
        assert!(out.contains("model_provider = \"custom\""));
        assert!(out.contains("model = \"old\""));
    }

    #[test]
    fn sets_nested_inline_table() {
        let ops = vec![PatchOp::set(
            &["model_providers", "custom", "base_url"],
            json!("https://x"),
        )];
        let out = apply("", &ops).unwrap();
        assert!(out.contains("base_url = \"https://x\""));
    }

    #[test]
    fn removes_key() {
        let input = "model = \"x\"\nmodel_provider = \"custom\"\n";
        let ops = vec![PatchOp::remove(&["model_provider"])];
        let out = apply(input, &ops).unwrap();
        assert!(!out.contains("model_provider"));
        assert!(out.contains("model = \"x\""));
    }

    #[test]
    fn round_trips_scalar_types() {
        let ops = vec![
            PatchOp::set(&["a"], json!(1)),
            PatchOp::set(&["b"], json!(true)),
            PatchOp::set(&["c"], json!([1, 2, 3])),
        ];
        let out = apply("", &ops).unwrap();
        assert!(out.contains("a = 1"));
        assert!(out.contains("b = true"));
        assert!(out.contains("c = [1, 2, 3]"));
    }
}
