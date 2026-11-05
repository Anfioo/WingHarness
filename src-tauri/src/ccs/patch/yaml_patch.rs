//! YAML 配置改写（serde_yml，保持键顺序）。
//!
//! 用于 Hermes 的 config.yaml。

use serde_yml::Value as YValue;

use super::PatchOp;

/// 把一组操作应用到 YAML 文本上，返回改写后的文本。
pub fn apply(contents: &str, ops: &[PatchOp]) -> Result<String, String> {
    let mut root: YValue = if contents.trim().is_empty() {
        YValue::Mapping(serde_yml::Mapping::new())
    } else {
        serde_yml::from_str(contents).map_err(|e| format!("Invalid YAML: {e}"))?
    };

    for op in ops {
        match op {
            PatchOp::Set { path, value } => set_value(&mut root, path, json_to_yaml(value)),
            PatchOp::Remove { path } => remove_value(&mut root, path),
        }
    }

    serde_yml::to_string(&root).map_err(|e| format!("Failed to serialize YAML: {e}"))
}

/// 枚举现有 YAML 中所有属于 floor 的键路径，返回对应的 Remove 操作。
///
/// 若某父路径本身就是 floor，只删除父路径、不再深入。
pub fn floor_removals(contents: &str, is_floor: &dyn Fn(&[String]) -> bool) -> Vec<PatchOp> {
    let Ok(root) = serde_yml::from_str::<YValue>(contents) else {
        return Vec::new();
    };
    let mut ops = Vec::new();
    collect_mapping(&root, &[], is_floor, &mut ops);
    ops
}

fn collect_mapping(
    value: &YValue,
    prefix: &[String],
    is_floor: &dyn Fn(&[String]) -> bool,
    ops: &mut Vec<PatchOp>,
) {
    if let YValue::Mapping(map) = value {
        for (key, child) in map {
            let Some(key_str) = key.as_str() else {
                continue;
            };
            let mut path = prefix.to_vec();
            path.push(key_str.to_string());
            if is_floor(&path) {
                let path_ref: Vec<&str> = path.iter().map(|s| s.as_str()).collect();
                ops.push(PatchOp::remove(&path_ref));
            } else if matches!(child, YValue::Mapping(_)) {
                collect_mapping(child, &path, is_floor, ops);
            }
        }
    }
}

fn set_value(root: &mut YValue, path: &[String], value: YValue) {
    let Some((key, parents)) = path.split_last() else {
        return;
    };
    let target = navigate_for_write(root, parents);
    if let YValue::Mapping(map) = target {
        map.insert(YValue::String(key.clone()), value);
    }
}

fn navigate_for_write<'a>(root: &'a mut YValue, parents: &[String]) -> &'a mut YValue {
    let mut current = root;
    for key in parents {
        if !matches!(current, YValue::Mapping(_)) {
            *current = YValue::Mapping(serde_yml::Mapping::new());
        }
        let map = current.as_mapping_mut().unwrap();
        let k = YValue::String(key.clone());
        if !map.contains_key(&k) {
            map.insert(k.clone(), YValue::Mapping(serde_yml::Mapping::new()));
        }
        current = map.get_mut(&k).unwrap();
    }
    if !matches!(current, YValue::Mapping(_)) {
        *current = YValue::Mapping(serde_yml::Mapping::new());
    }
    current
}

fn remove_value(root: &mut YValue, path: &[String]) {
    let Some((key, parents)) = path.split_last() else {
        return;
    };
    let mut current = root;
    for p in parents {
        match current.as_mapping_mut() {
            Some(map) => {
                let k = YValue::String(p.clone());
                match map.get_mut(&k) {
                    Some(v) => current = v,
                    None => return,
                }
            }
            None => return,
        }
    }
    if let Some(map) = current.as_mapping_mut() {
        map.remove(YValue::String(key.clone()));
    }
}

/// serde_json::Value → serde_yml::Value。
fn json_to_yaml(v: &serde_json::Value) -> YValue {
    match v {
        serde_json::Value::Null => YValue::Null,
        serde_json::Value::Bool(b) => YValue::Bool(*b),
        serde_json::Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                YValue::Number(serde_yml::Number::from(i))
            } else if let Some(f) = n.as_f64() {
                YValue::Number(serde_yml::Number::from(f))
            } else {
                YValue::Null
            }
        }
        serde_json::Value::String(s) => YValue::String(s.clone()),
        serde_json::Value::Array(arr) => YValue::Sequence(arr.iter().map(json_to_yaml).collect()),
        serde_json::Value::Object(map) => {
            let mut m = serde_yml::Mapping::new();
            for (k, val) in map {
                m.insert(YValue::String(k.clone()), json_to_yaml(val));
            }
            YValue::Mapping(m)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn sets_nested_and_preserves_other_keys() {
        let input = "model: old\nother:\n  keep: 1\n";
        let ops = vec![PatchOp::set(&["provider", "base_url"], json!("https://x"))];
        let out = apply(input, &ops).unwrap();
        let v: YValue = serde_yml::from_str(&out).unwrap();
        assert_eq!(v["provider"]["base_url"], "https://x");
        assert_eq!(v["model"], "old");
        assert_eq!(v["other"]["keep"], 1);
    }

    #[test]
    fn removes_key() {
        let input = "a: 1\nb: 2\n";
        let ops = vec![PatchOp::remove(&["a"])];
        let out = apply(input, &ops).unwrap();
        let v: YValue = serde_yml::from_str(&out).unwrap();
        assert!(v
            .as_mapping()
            .unwrap()
            .get(YValue::String("a".into()))
            .is_none());
        assert_eq!(v["b"], 2);
    }
}
