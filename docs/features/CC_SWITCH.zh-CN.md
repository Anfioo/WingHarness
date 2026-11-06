# CC Switch

**CC Switch** 页面管理 AI 编程 CLI 的供应商。它位于侧边栏「Agent」分组；已启用
应用的列表、它们的版本检查与配置目录覆盖都在「设置 → 应用配置」中。

一个供应商就是一个端点——base URL、key、默认模型——切换即把它写入 CLI 自己的
配置文件。这里没有任何代理：切换之后 CLI 直接与供应商通信，因此运行时的真相来源
是配置文件，而不是本应用。

本模块读取与 [cc-switch](https://github.com/farion1231/cc-switch)（MIT）相同的
SQLite schema，并可从其数据库导入。应用从不写入 `~/.cc-switch`。

## 支持的应用

| 标识 | 显示名 | 写入的配置 | 模式 |
| --- | --- | --- | --- |
| `claude` | Claude Code | `~/.claude/settings.json`（JSON） | 清除 + 写入 |
| `codex` | Codex | `~/.codex/config.toml`（TOML）、`~/.codex/auth.json` | 清除 + 写入 |
| `gemini` | Gemini CLI | `~/.gemini/settings.json`、`~/.gemini/.env` | 清除 + 写入 |
| `grokbuild` | Grok Build | `~/.grok/config.toml`（TOML） | 清除 + 写入 |
| `opencode` | OpenCode | `~/.config/opencode/opencode.jsonc` 或 `.json` | 追加 |
| `openclaw` | OpenClaw | `~/.openclaw/openclaw.json` | 追加 |
| `hermes` | Hermes | `~/.hermes/config.yaml`（YAML） | 追加 |
| `pi` | Pi | `~/.pi`（无固定文件） | 仅高级编辑器 |
| `mcode` | MiniMax Code | `~/.minimax` | 仅高级编辑器 |

前五个默认可见；其余初始隐藏，在设置中开启。设置里的配置目录覆盖同时作用于
检测、写入与浏览对话框。

**清除 + 写入** 意味着切换时先从现有文件中移除描述连接或凭据的键——对 Claude，
是每个以 `ANTHROPIC_`、`AWS_` 或 `VERTEX_REGION_` 为前缀的 `env` 键、
`CLAUDE_CODE_*` 选择器，以及顶层的 `apiKeyHelper` / `apiBaseUrl` / `model` /
`fallbackModel` 等；对 Codex，是 `model_provider`、`openai_base_url`、`model`、
推理力度相关的键和整个 `[model_providers.custom]` 表——然后再写入该供应商的值。
没有这一步，上一个供应商的 token 会残留，仍可能被 CLI 取用。

**追加**类应用只写自己的节点（`provider.<id>`、`models.providers.<id>`），其他
一律不动。

写入是原子的（临时文件 + rename），但**不做任何备份**：没有「切回」存档，只有
下一次切换。如果手工修改很重要，请放进 git。

## 供应商

```json
{ "id": "…", "name": "work", "settingsConfig": { … }, "websiteUrl": "…",
  "category": "…", "sortIndex": 0, "notes": "…",
  "meta": { "providerType": "…", "apiKeyField": "…" }, "icon": "…", "iconColor": "…" }
```

`settingsConfig` 按应用而定：

| 应用 | 形态 |
| --- | --- |
| Claude | `{ env: { ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY, ANTHROPIC_MODEL, ANTHROPIC_SMALL_FAST_MODEL } }` |
| Codex | `{ config: "<config.toml text>", auth: { OPENAI_API_KEY } }` |
| Gemini | `{ env: { GOOGLE_GEMINI_BASE_URL, GEMINI_API_KEY, GEMINI_MODEL }, authType, model: { name } }` |
| Grok Build | `{ models: { default }, model: { <id>: { base_url, api_key } } }` |
| OpenCode / OpenClaw | `{ providerId, baseURL, apiKey, model }` |
| Hermes / Pi / MiniMax Code | 自由格式，仅高级编辑器 |

表单按每个应用的 schema（`form-schema.ts`）生成，Claude 有专用表单，Codex 有一个
（TOML），其余用通用的 JSON/YAML 表单，因此 schema 描述不了的供应商仍可作为文本
编辑。

**Codex 的特殊之处。** 供应商的 `OPENAI_API_KEY` 写入
`[model_providers.custom].experimental_bearer_token`，因为 Codex 不再从 `auth.json`
读取第三方 key。只有当供应商携带的是官方登录状态而非 key 时，`auth.json` 才会
整份写入。

## 导入

| 来源 | 作用 |
| --- | --- |
| **实时配置** | 把应用的当前配置读成一个名为 "默认（本机配置）" 的供应商。仅 Claude 与 Codex |
| **cc-switch 数据库** | 以只读方式打开 `~/.cc-switch/cc-switch.db`（或选中的 `.db`），读取其 `providers` 表，字段与本模块的 schema 相同 |
| **JSON** | 接受 `{ data: { <app>: { list: [...] } } }`、裸数组或单个对象；预览会标记每个条目是新增还是更新 |

首次运行时，应用从实时配置填充空存储，并一次性添加一个 `claude-official` 条目
（标记文件 `official-seeded`）。

复制会用新的 UUID 复制一个供应商，名字追加 " Copy"，放在顺序末尾。编辑供应商会
保留其主键，因此 `is_current` 与排序位置不变；编辑当前供应商会立即重新应用它。

## 模型列表与版本检查

`ccs_fetch_models` 向供应商的 base URL 请求其模型列表。候选 URL 由 base 推导：
`/vN` 后缀得到 `{base}/models`（N 不是 1 时还有 `{base}/v1/models`），其他情况
得到 `{base}/v1/models`，已知的 Anthropic 兼容后缀还会额外尝试根路径。
`settingsConfig` 中显式的 `modelsUrl` 优先。认证头跟随 `apiFormat`——默认
`Authorization: Bearer`，`anthropic-messages` 用 `x-api-key`，
`google-generative-ai` 用 `x-goog-api-key`。超时 15 秒；404/405 则继续下一个
候选。仅 Claude 与 Codex 支持此功能。

`ccs_get_tool_versions` 对每个已启用应用并发运行 `<command> --version`，超时
10 秒，并从其输出中提取 semver。命令能运行但输出无法解析时，报告为已安装但
损坏，这与「未安装」是不同的状态。

## 数据布局

```
<data dir>/ccs/
├── ccs.db                 # SQLite；providers 表（id, app_type, …, is_current）
├── providers.json.migrated# 旧的 JSON 存储，重命名一次
└── official-seeded        # 一次性的填充标记
```

`providers` 表与官方 cc-switch 逐字段一致，因此从它的数据库导入就是直接读取。
应用级设置（可见应用、配置目录）存放在应用自己的 `config.json` 的 `ccs` 下。

## 与官方 cc-switch 数据库同步

设置 → CC Switch → 应用配置里有一个「同步 CC Switch 数据库」开关。打开后，每次
切换供应商都会顺带把官方 cc-switch 数据库（`~/.cc-switch/cc-switch.db`）里该应用
的 `is_current` 标记改成同一条，两个工具显示的当前供应商保持一致。

- 只有检测到默认路径的数据库时开关才可用；`ccs_get_ccswitch_db` 返回路径与是否
  存在。仅支持默认路径。
- 官方库里没有相同 ID 的供应商时跳过写入——直接置位会清空它的当前选择。
- 同步是单向的：在 cc-switch 里切换不会回写本应用，它之后的切换会覆盖这里写入
  的标记。
- 写入失败只记日志，不影响切换；此时 CLI 配置文件与本应用的当前指针都已写好。

## 命令

| 分组 | 命令 |
| --- | --- |
| 供应商 | `ccs_get_providers`、`ccs_get_current_provider`、`ccs_add_provider`、`ccs_update_provider`、`ccs_delete_provider`、`ccs_duplicate_provider`、`ccs_switch_provider`、`ccs_update_sort_order` |
| 导入 | `ccs_import_live_config`、`ccs_import_preview`、`ccs_import_save`、`ccs_pick_import_file` |
| 应用与设置 | `ccs_get_tool_versions`、`ccs_get_visible_apps`、`ccs_set_app_visible`、`ccs_get_settings`、`ccs_save_settings`、`ccs_get_config_dir`、`ccs_set_config_dir`、`ccs_browse_directory`、`ccs_get_resolved_dirs`、`ccs_get_ccswitch_db`、`ccs_set_sync_ccswitch_db` |
| 编辑器与杂项 | `ccs_editor_base`、`ccs_editor_delta`、`ccs_fetch_models`、`ccs_get_claude_switches`、`ccs_set_skip_onboarding`、`ccs_set_plugin_integration`、`ccs_get_codex_switches`、`ccs_set_codex_session_compression` |

`ccs_switch_provider` 返回已应用的供应商与写入的配置文件，这是查看覆盖是否把
写入导向意料之外位置的最快方式。

## 限制

- **没有备份，也没有回滚。** 一次切换会覆盖真实配置文件中的连接键。
- Hermes、Pi 与 MiniMax Code 的供应商是自由文本；应用无法校验它们。
- 删除供应商只会为 OpenCode 与 OpenClaw 清除节点；其他追加类应用需要手工编辑。
- 使用配置目录覆盖时，CLI 读取的文件可能与写入的不是同一个。
- cc-switch 数据库同步是单向的，且只写默认路径；cc-switch 正在运行时可能持有
  写锁，此时同步会被静默跳过。

## 把本模块接入其他应用

1. 把 `ccs` 模块（及其内嵌的 SQLite schema）加入 `src-tauri`，并从 `invoke.rs`、
   `build.rs` 和 `capabilities/default.json` 暴露命令。
2. 复制 `src/pages/cc-switch`，包括 `app-meta.ts` 与 `form-schema.ts`——它们是
   前端应用列表的唯一来源。
3. 在设置中添加应用配置一节。
4. 如果沿用了 cc-switch 的图标集，在 `THIRD_PARTY_NOTICES` 中保留其署名。

## 常见问题

| 现象 | 可能原因 |
| --- | --- |
| 切换成功但 CLI 仍使用旧端点 | 配置目录覆盖指向别处；把 `ccs_get_resolved_dirs` 与 CLI 实际读取的位置对比 |
| 上一个供应商的 token 仍在 `settings.json` 中 | 该键不在清除列表里——只清除已知的连接键 |
| 切换后 Codex 认证失败 | key 写到了 `[model_providers.custom].experimental_bearer_token`；`model_provider` 必须是 `custom` |
| 从 cc-switch 导入失败 | `~/.cc-switch/cc-switch.db` 不存在，或它被 cc-switch 锁定 |
| 版本显示为已安装但损坏 | 命令运行了但输出无法解析，或在 10 秒时超时 |
| 模型列表为空 | 非 Claude/Codex 应用、key 字段缺失或命名不对，或所有候选 URL 都返回 404 |
| 删除供应商后残留旧节点 | 只有 OpenCode 与 OpenClaw 的节点会自动清理 |
