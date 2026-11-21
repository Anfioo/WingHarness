---
name: git-commit-message
description: 根据 git diff 分析变更并生成符合 Conventional Commits 规范的提交信息。当用户提到"写commit"、"提交信息"、"commit message"、"帮我提交"、"整理改动"、"拆分提交"、暂存区代码变更、或需要按约定式提交规范撰写消息时使用此技能。生成后展示给用户确认，不主动执行 git commit。
---

# Git 提交信息

## 概览

基于实际 `git diff` 判断合适的提交类型、作用域和摘要，生成统一、语义明确的 Conventional Commits 提交信息。

优先针对已暂存内容生成提交信息；如果尚未暂存，先确认本次提交应包含的文件范围，再继续操作。

## 提交格式

按以下模板输出可复制的提交信息。message header 中的 type 和 scope 使用英文（Conventional Commits 标准），description 和正文使用中文：

```text
<type>[optional scope]: <description>

- 详细变更点1（中文）
- 详细变更点2（中文）

[optional footer(s)]
```

编写标题时注意：

- 摘要控制在 50 个字符以内，用简洁的动词开头（如"新增"、"修复"、"重构"、"移除"）
- 只描述本次提交实际做了什么，不写背景故事

## 提交类型

| 类型 | 适用场景 |
| --- | --- |
| `feat` | 新增功能 |
| `fix` | 修复缺陷 |
| `docs` | 仅修改文档 |
| `style` | 仅格式或样式调整，不改变逻辑 |
| `refactor` | 重构代码，但不是修复缺陷也不是新增功能 |
| `perf` | 性能优化 |
| `test` | 新增或更新测试 |
| `build` | 构建系统、依赖或打包流程变更 |
| `ci` | CI/CD 或自动化流程配置变更 |
| `chore` | 维护性杂项修改 |
| `revert` | 回滚历史提交 |

## 破坏性变更

遇到破坏性变更时，使用以下两种方式之一明确标记：

```text
feat!: 移除已废弃的 API 端点
```

```text
feat(config): 支持扩展共享配置

BREAKING CHANGE: 变更 extends 字段的解析方式，旧的扁平结构不再兼容
```

只有在接口、行为或兼容性确实被破坏时才添加 `!` 或 `BREAKING CHANGE`。

## 工作流

### 1. 分析改动

先检查当前仓库状态，再决定基于哪份 diff 生成提交信息：

```bash
git status --porcelain
git diff --staged
git diff
```

按以下规则处理：

- 如果存在 staged 文件，优先基于 `git diff --staged`
- 如果没有 staged 文件，再分析工作区改动
- 如果改动明显包含多个逻辑点，先拆分提交，再分别生成消息

### 2. 控制提交边界

每个 commit 只处理一个清晰的逻辑变更。

先向用户说明建议的文件范围，由用户决定暂存哪些文件。确认后再使用明确的暂存命令：

```bash
git add path/to/file1 path/to/file2
git add '*.test.*'
git add src/components/*
git add -p
```

绝不提交敏感信息，例如：

- `.env`
- `credentials.json`
- 私钥、令牌、证书或其他密钥材料

### 3. 生成提交信息

根据 diff 判断以下三个核心字段：

- `type`：这次改动属于什么类别
- `scope`：影响的是哪个模块、目录或子系统；不明确时可以省略
- `description`：一句话概括改动结果

需要补充正文或 footer 时，优先用于以下内容：

- 说明改动原因或约束，而不是重复标题
- 关联任务或问题，例如 `Refs #123`、`Closes #456`
- 标记破坏性变更

### 4. 展示提交信息

生成提交信息后，以可复制的格式展示给用户确认，**不主动执行提交**。

仅当用户明确要求"提交"、"执行"、或给出肯定确认后，再执行。此时使用以下命令：

单行提交：

```bash
git commit -m "<type>[scope]: <description>"
```

需要正文或 footer 时：

```bash
git commit -m "$(cat <<'EOF'
<type>[scope]: <description>

<optional body>

<optional footer>
EOF
)"
```

## 最佳实践

- 优先使用最能反映用户价值的 `type`，不要机械按文件类型分类
- `scope` 只在确实有助于理解时使用，避免写得过细或过泛
- 如果一次改动同时修改代码和测试，通常仍然只提交为一个主要类型，而不是强行拆成两个类型
- 提交标题聚焦结果，正文补充原因、兼容性影响和后续事项
- 在提交前再次检查 `git status --short`，确认不会把无关文件一起带上

## Git 安全约束

- 如果提交因 hooks 失败，先修复问题，再创建新的 commit；不要默认 amend
- 不要在未经用户明确要求的情况下使用 `--no-verify`
- 不要在未经用户明确要求的情况下执行强制推送、`hard reset` 或其他破坏性 git 操作
- 不要修改全局或仓库级 git config
