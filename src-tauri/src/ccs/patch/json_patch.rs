//! JSON 配置改写（serde_json，preserve_order 保持键顺序）。
//!
//! 输出统一为 2 空格缩进的 pretty JSON；原文件中的其他字段和键顺序保留。

use serde_json::{json, Map, Value};

use super::PatchOp;

/// 把一组操作应用到 JSON 文本上，返回改写后的文本。
pub fn apply(contents: &str, ops: &[PatchOp]) -> Result<String, String> {
    let mut root: Value = if contents.trim().is_empty() {
        json!({})
    } else {
        serde_json::from_str(contents).map_err(|e| format!("Invalid JSON: {e}"))?
    };

    for op in ops {
        match op {
            PatchOp::Set { path, value } => set_value(&mut root, path, value.clone()),
            PatchOp::Remove { path } => remove_value(&mut root, path),
        }
    }

    serde_json::to_string_pretty(&root).map_err(|e| format!("Failed to serialize JSON: {e}"))
}

/// 枚举现有 JSON 中所有属于 floor 的键路径，返回对应的 Remove 操作。
///
/// 若某父路径本身就是 floor，只删除父路径、不再深入。
pub fn floor_removals(contents: &str, is_floor: &dyn Fn(&[String]) -> bool) -> Vec<PatchOp> {
    let Ok(root) = serde_json::from_str::<Value>(contents) else {
        return Vec::new();
    };
    let mut ops = Vec::new();
    collect_floor(&root, &[], is_floor, &mut ops);
    ops
}

fn collect_floor(
    value: &Value,
    prefix: &[String],
    is_floor: &dyn Fn(&[String]) -> bool,
    ops: &mut Vec<PatchOp>,
) {
    if let Value::Object(map) = value {
        for (key, child) in map {
            let mut path = prefix.to_vec();
            path.push(key.clone());
            if is_floor(&path) {
                let path_ref: Vec<&str> = path.iter().map(|s| s.as_str()).collect();
                ops.push(PatchOp::remove(&path_ref));
            } else if child.is_object() {
                collect_floor(child, &path, is_floor, ops);
            }
        }
    }
}

/// 沿 `path` 导航/创建对象，在末端设置 `value`。
fn set_value(root: &mut Value, path: &[String], value: Value) {
    if path.is_empty() {
        *root = value;
        return;
    }
    let (key, parents) = path.split_last().unwrap();
    let target = navigate_for_write(root, parents);
    match target {
        Value::Object(map) => {
            map.insert(key.clone(), value);
        }
        _ => {
            // 理论上 navigate_for_write 保证返回对象。
            let mut map = Map::new();
            map.insert(key.clone(), value);
            *target = Value::Object(map);
        }
    }
}

/// 导航到 `parents` 指向的对象，中间层缺失或为标量时创建/替换为对象。
fn navigate_for_write<'a>(root: &'a mut Value, parents: &[String]) -> &'a mut Value {
    let mut current = root;
    for key in parents {
        // 不是对象则替换成空对象。
        if !current.is_object() {
            *current = Value::Object(Map::new());
        }
        let map = current.as_object_mut().unwrap();
        current = map
            .entry(key.clone())
            .or_insert_with(|| Value::Object(Map::new()));
    }
    if !current.is_object() {
        *current = Value::Object(Map::new());
    }
    current
}

/// 导航到父对象并删除末端键；路径不存在则忽略。
fn remove_value(root: &mut Value, path: &[String]) {
    let Some((key, parents)) = path.split_last() else {
        return;
    };
    let mut current = root;
    for p in parents {
        match current.as_object_mut() {
            Some(map) => match map.get_mut(p) {
                Some(v) => current = v,
                None => return,
            },
            None => return,
        }
    }
    if let Some(map) = current.as_object_mut() {
        map.remove(key);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sets_nested_and_preserves_other_keys() {
        let input = r#"{"hooks": {}, "env": {"KEEP": "1"}}"#;
        let ops = vec![PatchOp::set(
            &["env", "ANTHROPIC_BASE_URL"],
            json!("https://x"),
        )];
        let out = apply(input, &ops).unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["env"]["ANTHROPIC_BASE_URL"], "https://x");
        assert_eq!(v["env"]["KEEP"], "1");
        assert!(v["hooks"].is_object());
    }

    #[test]
    fn creates_intermediate_objects() {
        let ops = vec![PatchOp::set(&["a", "b", "c"], json!(1))];
        let out = apply("{}", &ops).unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["a"]["b"]["c"], 1);
    }

    #[test]
    fn removes_only_target_key() {
        let input = r#"{"env": {"A": "1", "B": "2"}}"#;
        let ops = vec![PatchOp::remove(&["env", "A"])];
        let out = apply(input, &ops).unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert!(v["env"].as_object().unwrap().get("A").is_none());
        assert_eq!(v["env"]["B"], "2");
    }

    #[test]
    fn overwrites_scalar_intermediate() {
        let input = r#"{"env": "scalar"}"#;
        let ops = vec![PatchOp::set(&["env", "X"], json!("v"))];
        let out = apply(input, &ops).unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["env"]["X"], "v");
    }
}
