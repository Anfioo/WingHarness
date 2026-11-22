# inbox/<lane>.md 骨架

一份文件 = 一个执行 Agent 的完整工作单，由用户按原方式手动开启；对应波次结束后由波次协调者读取本文件的「待协调」与完成记录。A0 与 A1 用同一骨架，B/F 轨去掉「冻结接口」一节即可。

````markdown
# <LANE> — <一句话职责>

先读 `plan.1.md` 的 §<相关章节>，以及 `inbox/A0.md` 的冻结接口。本文件只补本轨范围。

- 工作目录：仓库根（WingHarness 仓库根目录），本文所有路径均相对它
- 分支：`feature/<module>`（由协调者建好；本轨不做任何分支操作）
- 开工前：`git status --porcelain`（排除 `.dev/` 与 `.claude/skills/`）有改动时不要立即停：逐个查看内容，与本轨/同波次其他轨/本次移植相关 → 读取分析后继续；与本轨要改的文件冲突、同一文件混有别人的未提交改动又无法只提交自己的部分，或与本次移植无关 → 停下并报告。不要 stash / reset / clean，也不要把别人的未提交改动加入自己的提交。

## 你独占的文件

- `src-tauri/<module>-core/src/<file>.rs`
- `src/pages/<module>/<file>.tsx`
- `.dev/Plans/<module>/inbox/<lane>.md`（只写你自己的）

## 不要改

`src-tauri/Cargo.toml`、`src-tauri/build.rs`、`src-tauri/src/invoke.rs`、`src-tauri/capabilities/default.json`、`src-tauri/src/lib.rs`、`<module>-core/src/{lib,error,paths,models,commands}.rs`、`src/main.tsx`、`src/lib/app-routes.ts`、`src/lib/sidebar-config.ts`、`src/commands/**`、`src/i18n/**`、其他轨的文件。

需要新增命令、DTO 字段、错误码或 i18n 键时，写到本文末尾的 `## 待协调`，不要自己动手。

## 必读

1. `.dev/Plans/<module>/plan.1.md` —— §<章节>
2. `.dev/Plans/<module>/inbox/A0.md` —— 冻结接口
3. <源项目里对应的参考文件：在本仓内写相对路径（如 `.dev/Projects/<source>/src/x.ts`），仓库外写绝对路径>

## 冻结接口（不要改签名）

```rust
// <module>-core/src/<file>.rs
pub fn <fn>(<args>) -> <Module>Result<<T>>;
```

```ts
// src/commands/services/<domain>/index.ts
export function <verb>(<args>): Promise<<T>>;
```

## 实施步骤

1. <可执行的单步，带文件>
2. <可执行的单步，带文件>
3. …

## 实现要点

- <校验规则 / 边界值 / 错误码>
- <锁纪律、异步边界、事件发送时机>
- <空态、错误态、禁用条件>

## 验收

```powershell
cd src-tauri
cargo check -p <module>-core
cargo test -p <module>-core
cd ..
pnpm build
pnpm exec eslint <本轨文件>
```

## 提交

- 只 `git add <明确路径列表>`；禁止 `git add -A` / `git add .` / `--no-verify` / `amend` / `force push`。
- 格式：

```
feat(<scope>): <中文摘要>

- <要点一>
- <要点二>
```

- 每个提交点单独提交；功能与修复分开。

## 完成标准

- [ ] 验收命令全绿。
- [ ] 只改了自己独占的文件；没有把别人的未提交改动加入自己的提交。
- [ ] 提交消息通过 `commitlint`。
- [ ] 回报：改了哪些文件、提交 hash、与计划的偏差、本轨写进「待协调」的条目。

## 协调者读取说明

波次结束后，协调者会读取本文件末尾的 `## 待协调` 与 `## 完成记录`。执行 Agent 必须把需要共享文件、接口、DTO、事件或 i18n 配合的事项写清楚；不得只在自然语言回报中提出。协调者只处理共享协调，不替本轨补做业务实现。


（空。需要共享文件配合时在这里追加，并说明「哪个文件、加什么、为什么」。）

---

## 完成记录（执行后填写）

- 提交：`<hash>` `<消息>`
- 验收：<结果>
- 与计划的差异：<逐条>
````

## A0 专用补充

A0 的工作单在骨架之外必须多两节：

### 必须冻结的内容

1. Cargo 与挂载：workspace `members`、`[dependencies]` path 项、`paths::CONFIG_DIR`、`app.manage(...)`、退出钩子。
2. 命令面：按 plan §6.1 建薄转发，未实现返回 `NotImplemented`；四处登记一次做完。
3. DTO：字段与错误码按 plan §5 / §6.3 写死；serde kebab-case。
4. 事件契约：事件名、payload 字段。
5. 前端：命令 wrapper、DTO 类型、hooks、页面壳、路由、`DEFAULT_GROUP_NAMES`、全部 i18n 键。
6. 公开签名：各轨要并行的 `store` / `process` / `config` 接口先写成可编译的桩。

### W1/W2 需要知道的

写完基线后，把「各轨实际可用的入口」逐条列在这里（wrapper 参数形态、hook 返回值、事件已由页面壳订阅、错误映射函数名、i18n 键前缀），避免各轨去读页面壳源码猜。
