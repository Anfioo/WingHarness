//! 供应商编辑器的「显示视图」与「增量」。
//!
//! 对齐 cc-switch 的 `editor_view`：供应商表单显示「切到这个供应商之后配置文件的样子」
//! （live 只替换关键字段），所以用户原有的 `[projects]`、`[windows]`、`mcp_servers`、`notify`
//! 等内容会出现在编辑器里；保存时只把「相对 live 真正变化的部分」存进供应商（增量），
//! live 带入的字段不落库、切换时从 live 原样保留。

use serde_json::{json, Map, Value};

use super::app_type::AppType;
use super::provider::Provider;
use super::{patch, paths, project};

/// 编辑器视图：`view` 是编辑器显示/编辑的内容，`baseline` 是保存时算增量的基准
/// （live 去掉关键字段）。
pub struct EditorView {
    pub view: Value,
    pub baseline: Value,
}

/// 计算某个供应商的编辑器视图。`provider` 为 `None` 时视图等于基准（live 去关键字段）。
pub fn view(app: AppType, provider: Option<&Provider>) -> Result<EditorView, String> {
    let file = paths::target_file(app, "main");
    let existing = std::fs::read_to_string(&file).unwrap_or_default();
    let live_auth = read_json_file(app, "auth.json");
    let provider_auth = provider
        .and_then(|p| p.settings_config.get("auth"))
        .cloned()
        .unwrap_or_else(|| json!({}));
    compute(app, &existing, live_auth, provider, provider_auth)
}

/// 纯逻辑：由 live 配置文本 + auth 计算视图与基准（便于单测）。
fn compute(
    app: AppType,
    existing: &str,
    live_auth: Value,
    provider: Option<&Provider>,
    provider_auth: Value,
) -> Result<EditorView, String> {
    let format = app.meta().format;

    let mut removal_ops = Vec::new();
    if !app.meta().additive {
        removal_ops.extend(patch::floor_removals_for(format, existing, &|p| {
            project::is_floor_path(app, "main", p)
        }));
        // Codex：live 当前选中的路由表（可能是别的 id）也清掉，避免遗留旧供应商表。
        if app == AppType::Codex {
            if let Some(id) = super::project::codex::selected_provider_id(existing) {
                removal_ops.push(patch::PatchOp::remove(&["model_providers", id.as_str()]));
            }
        }
    }
    let baseline_text = patch::apply_for(format, existing, &removal_ops)?;

    let mut provider_ops = Vec::new();
    if let Some(provider) = provider {
        for target in project::project(app, provider)? {
            if target.key == "main" && target.raw.is_none() {
                provider_ops.extend(target.ops);
            }
        }
    }
    let view_text = patch::apply_for(format, &baseline_text, &provider_ops)?;

    Ok(match app {
        AppType::Codex => {
            let mut view_auth = live_auth.clone();
            if let (Some(obj), Some(pa)) = (view_auth.as_object_mut(), provider_auth.as_object()) {
                for (k, v) in pa {
                    obj.insert(k.clone(), v.clone());
                }
            }
            EditorView {
                view: json!({ "config": view_text, "auth": view_auth }),
                baseline: json!({ "config": baseline_text, "auth": live_auth }),
            }
        }
        AppType::Claude => EditorView {
            view: serde_json::from_str(&view_text).unwrap_or_else(|_| json!({})),
            baseline: serde_json::from_str(&baseline_text).unwrap_or_else(|_| json!({})),
        },
        _ => EditorView {
            view: Value::Null,
            baseline: Value::Null,
        },
    })
}

/// 由编辑器内容算出应存进供应商的最小配置：去掉与基准相同的部分。
pub fn delta(app: AppType, edited: Value, base: Value) -> Value {
    match app {
        AppType::Codex => {
            let base_cfg =
                toml_text_to_json(base.get("config").and_then(Value::as_str).unwrap_or(""));
            let edited_cfg =
                toml_text_to_json(edited.get("config").and_then(Value::as_str).unwrap_or(""));
            let cfg = json_remove_equal(edited_cfg, &base_cfg).unwrap_or_else(|| json!({}));

            let base_auth = base.get("auth").cloned().unwrap_or_else(|| json!({}));
            let edited_auth = edited.get("auth").cloned().unwrap_or_else(|| json!({}));
            let auth = json_remove_equal(edited_auth, &base_auth);

            let mut out = Map::new();
            out.insert("config".to_string(), Value::String(json_to_toml_text(&cfg)));
            if let Some(auth) = auth {
                out.insert("auth".to_string(), auth);
            }
            Value::Object(out)
        }
        _ => json_remove_equal(edited, &base).unwrap_or_else(|| json!({})),
    }
}

/// 读取应用配置目录下的某个 JSON 文件（不存在或损坏时返回空对象）。
fn read_json_file(app: AppType, name: &str) -> Value {
    let file = paths::config_dir(app).join(name);
    std::fs::read_to_string(&file)
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .filter(|v| v.is_object())
        .unwrap_or_else(|| json!({}))
}

/// TOML 文本 → JSON（解析失败按空对象）。
fn toml_text_to_json(text: &str) -> Value {
    if text.trim().is_empty() {
        return json!({});
    }
    toml::from_str::<toml::Value>(text)
        .ok()
        .and_then(|t| serde_json::to_value(t).ok())
        .unwrap_or_else(|| json!({}))
}

/// JSON → TOML 文本（失败按空串）。
fn json_to_toml_text(value: &Value) -> String {
    toml::Value::try_from(serde_json::to_value(value).unwrap_or(Value::Null))
        .ok()
        .and_then(|t| toml::to_string(&t).ok())
        .unwrap_or_default()
}

/// 递归去掉 `edited` 中与 `base` 相等的部分；全等返回 `None`。
fn json_remove_equal(edited: Value, base: &Value) -> Option<Value> {
    match (edited, base) {
        (Value::Object(e), Value::Object(b)) => {
            let mut out = Map::new();
            for (key, value) in e {
                match b.get(&key) {
                    Some(bv) => {
                        if let Some(d) = json_remove_equal(value, bv) {
                            out.insert(key, d);
                        }
                    }
                    None => {
                        out.insert(key, value);
                    }
                }
            }
            if out.is_empty() {
                None
            } else {
                Some(Value::Object(out))
            }
        }
        (a, b) => {
            if a == *b {
                None
            } else {
                Some(a)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn delta_drops_unchanged_and_keeps_changed() {
        let base = json!({ "model": "a", "hooks": { "k": 1 }, "env": { "X": "1" } });
        let edited = json!({ "model": "b", "hooks": { "k": 1 }, "env": { "X": "2" } });
        let d = json_remove_equal(edited, &base).unwrap();
        assert_eq!(d["model"], "b");
        assert_eq!(d["env"]["X"], "2");
        assert!(d.get("hooks").is_none());
    }

    #[test]
    fn delta_of_identical_is_none() {
        let v = json!({ "a": 1, "b": { "c": [1, 2] } });
        assert!(json_remove_equal(v.clone(), &v).is_none());
    }

    #[test]
    fn delta_keeps_added_keys() {
        let base = json!({ "a": 1 });
        let edited = json!({ "a": 1, "b": 2 });
        let d = json_remove_equal(edited, &base).unwrap();
        assert_eq!(d["b"], 2);
        assert!(d.get("a").is_none());
    }

    #[test]
    fn codex_view_shows_live_sections_and_delta_keeps_only_provider() {
        // live 含用户内容（notify / mcp_servers / projects / windows）+ 旧供应商关键字段。
        let live = "notify = [\"node\", \"notify.cjs\"]\n\
model_provider = \"old\"\n\
model = \"old-model\"\n\
\n\
[model_providers.old]\n\
base_url = \"https://old\"\n\
\n\
[mcp_servers.node_repl]\n\
type = \"stdio\"\n\
\n\
[projects.\"m:\\\\mabang\"]\n\
trust_level = \"trusted\"\n\
\n\
[windows]\n\
sandbox = \"unelevated\"\n";

        let provider = Provider::new(
            "p1".into(),
            "NewAPI".into(),
            json!({
                "config": "model_provider = \"custom\"\nmodel = \"gpt-5.6\"\n[model_providers.custom]\nname = \"NewAPI\"\nbase_url = \"https://ccx.anfioo.com/v1\"\nwire_api = \"responses\"\n",
                "auth": { "OPENAI_API_KEY": "sk-x" }
            }),
        );

        let result = compute(
            AppType::Codex,
            live,
            json!({}),
            Some(&provider),
            json!({ "OPENAI_API_KEY": "sk-x" }),
        )
        .unwrap();

        let view_cfg = result.view["config"].as_str().unwrap();
        // 视图展示：用户内容 + 新供应商关键字段都出现。
        assert!(view_cfg.contains("notify"));
        assert!(view_cfg.contains("mcp_servers"));
        assert!(view_cfg.contains("trust_level"));
        assert!(view_cfg.contains("[windows]"));
        assert!(view_cfg.contains("https://ccx.anfioo.com/v1"));
        assert!(!view_cfg.contains("https://old"));

        // 保存增量：只剩供应商关键字段，live 带入的 mcp/projects/windows/notify 不落库。
        let stored = delta(AppType::Codex, result.view.clone(), result.baseline.clone());
        let stored_cfg = stored["config"].as_str().unwrap();
        assert!(stored_cfg.contains("https://ccx.anfioo.com/v1"));
        assert!(!stored_cfg.contains("mcp_servers"));
        assert!(!stored_cfg.contains("projects"));
        assert!(!stored_cfg.contains("windows"));
        assert!(!stored_cfg.contains("notify"));
        assert_eq!(stored["auth"]["OPENAI_API_KEY"], "sk-x");
    }

    #[test]
    fn claude_view_keeps_mcp_and_delta_is_env_only() {
        // live settings.json：用户的 mcpServers / hooks / permissions + 旧供应商 env。
        let live = serde_json::to_string(&json!({
            "mcpServers": { "x": { "command": "node" } },
            "hooks": { "Stop": [] },
            "permissions": { "allow": ["Bash"] },
            "env": { "ANTHROPIC_BASE_URL": "https://old", "ANTHROPIC_AUTH_TOKEN": "old-tok" }
        }))
        .unwrap();

        let provider = Provider::new(
            "p1".into(),
            "New".into(),
            json!({ "env": { "ANTHROPIC_BASE_URL": "https://new", "ANTHROPIC_AUTH_TOKEN": "new-tok" } }),
        );

        let result = compute(AppType::Claude, &live, json!({}), Some(&provider), json!({})).unwrap();

        // 视图：用户内容保留 + 新 env。
        assert_eq!(result.view["env"]["ANTHROPIC_BASE_URL"], "https://new");
        assert_eq!(result.view["env"]["ANTHROPIC_AUTH_TOKEN"], "new-tok");
        assert!(result.view["mcpServers"].is_object());
        assert!(result.view["hooks"].is_object());
        assert!(result.view["permissions"].is_object());

        // 增量：只有 env，mcp/hooks/permissions 不落库。
        let stored = delta(AppType::Claude, result.view.clone(), result.baseline.clone());
        assert_eq!(stored["env"]["ANTHROPIC_BASE_URL"], "https://new");
        assert!(stored.get("mcpServers").is_none());
        assert!(stored.get("hooks").is_none());
        assert!(stored.get("permissions").is_none());
    }
}
