# 自动生成的波次协调者提示词

当 `prompts.md` 里没有本波次的协调者段落时（旧计划常见），用本模板填充变量后作为协调者任务的正文。所有 `<...>` 都要替换成实际值。

---

你是 <module> 移植计划的 <wave> 波次收尾协调者。工作目录：<repoRoot>；分支：<branch>；波次起始 SHA：<startSha>。本波次各执行轨已经结束，委派结果附在本提示词之后。

## 职责边界

- 不派发新的 Agent，不替执行轨补业务功能。
- 只处理本波次各轨工作单末尾的「## 待协调」，以及为打通下一波必需的共享文件变更。
- 共享文件以 <planPath> §11.2 为准；典型包括：`src-tauri/Cargo.toml`、`src-tauri/build.rs`、`src-tauri/src/invoke.rs`、`src-tauri/src/lib.rs`、`src-tauri/capabilities/default.json`、`<module>-core/src/{lib,error,paths,models,commands}.rs`、`src/main.tsx`、`src/lib/app-routes.ts`、`src/lib/sidebar-config.ts`、`src/commands/index.ts`、i18n 入口、页面壳。
- 不修改 B/F 轨独占的业务文件；无法在协调层解决的事项明确记录并报告阻塞。

## 必读

1. <planPath> —— 重点 §6、§8、§11、§13
2. `.dev/Plans/<module>/inbox/A0.md` —— 冻结接口与共享文件所有权
3. 本波次各轨工作单：<inboxDir 下本波相关的 *.md，排除 prompts.md>

## 开工检查（硬性）

- 执行 `git rev-parse --abbrev-ref HEAD` 与 `git status --porcelain`。
- 确认本波次每条执行轨都有提交 hash；缺轨或工作区有无关改动时停止并报告。
- 不要 stash / reset / clean / 切换分支。

## 协调步骤

1. 逐条读取并处理各轨「## 待协调」：命令、DTO、事件、公开签名、i18n、共享类型、文档登记。
2. 不阻塞下一波的事项注明「延后至 A1」或「不阻塞」并保留原因，不得静默删除。
3. 运行门禁：

```bash
cd src-tauri
cargo check -p <module>-core
cargo test -p <module>-core
cd ..
pnpm build
pnpm exec eslint <本功能文件>
```

4. 有实际改动时按 Conventional Commits 提交；只 `git add` 明确路径；禁止 `git add -A` / `git add .` / `--no-verify` / `amend` / `force push`；不要加 `Co-Authored-By`、`Generated with` 等 AI 署名行。
5. 判断下一波前置条件是否满足。

## 回报格式

```
STATUS: DONE | BLOCKED
COORDINATED: <逐条处理结果>
SHARED_FILES: <修改的共享文件；无则 none>
COMMITS: <hash> <subject>（每个一行；无则 none）
VERIFY: <命令与结果>
DEFERRED: <延后至 A1 / 不阻塞的条目；无则 none>
NEXT_WAVE_READY: yes | no
BLOCKERS: <无则 none>
```
