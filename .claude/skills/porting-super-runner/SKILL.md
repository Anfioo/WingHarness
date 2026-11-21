---
name: porting-super-runner
description: 一条命令跑完整条移植波次链（super-runner）：从 W0 基线开始，逐波委派 Codeg 子 Agent——每一环执行本波（W0 直接施工，W≥1 调用 porting-wave-runner 并行执行本波与收尾），再把下一环委派出去，直到最后一波 A1 完成。适合长时间无人值守运行。需要把 Codeg 委派深度调到 8。当用户说「一次跑完所有波次」「长时间运行」「super-runner」「从 W0 到 A1 全自动」「一条命令跑完整个移植」「无人值守跑波次」时使用。
---

# 全波次链执行（super-runner）

`porting-wave-runner` 一次只跑一波；本技能把每一波串成一条**委派链**，一次启动就从 W0 跑到最后一波 A1。链的形状：

```
你（仓库窗口，depth 0）
└─ 链头：W0 环节（depth 1）——执行 A0 基线，然后委派 W1 环节
   └─ W1 环节（depth 2）——调用 porting-wave-runner 跑 W1，然后委派 W2 环节
      └─ W2 环节（depth 3）——同上
         …
         └─ 最后一波环节（depth N）——跑完本波，不再委派，逐层回传
```

每一环都是一次 `delegate_to_agent`；子 Agent 自带新会话、无上下文，且**可以继续委派**（Codeg 给每个子连接都注入了 `codeg-mcp`）。因此链能一直往下走，代价是每多一波就多占一层委派深度。

## 何时用 / 不用

- **用**：计划已生成（`.dev/Plans/<module>/inbox/prompts.md`），目标分支已切好、工作区干净，用户希望一次挂机跑完 W0→A1。
- **不用**：只想跑某一波（用 `porting-wave-runner`）；计划还没生成（先用 `porting-plan-waves`）；需要每波之间人工检查。
- **绝不替代**：`porting-wave-runner` 仍是每一波的实际执行者；本技能只负责把波次串起来。
- **依赖 codeg MCP**：`delegate_to_agent`、`get_delegation_status`、`cancel_delegation`。加载不到就停，**不得**改用原生 Agent / Task / Workflow。
- **假定从 depth 0 启动**：由用户直接在仓库窗口调用。若在某个委派会话里再调用本技能，实际深度会叠加，可能触发 `depth_limit`。
- **无人值守前提**：委派 Agent 的权限模式要能自动执行（否则深层子链会停在权限提示上）。本窗口只能直接看到链头的 `blocked_on`；更深的环节停在提示时，去 Codeg 会话列表里找到对应子会话回答，不要取消链头。

## 参数

```
/porting-super-runner <prompts.md 路径> [--from w0] [--to wN] [--agent <agent_type>] [--depth-limit 8] [--dry-run]
```

| 参数 | 说明 |
|------|------|
| `<prompts.md 路径>` | 相对仓库根或绝对路径；也可给目录，按 `inbox/prompts.md` → `inbox.N/prompts.md` → `prompts.md` 查找 |
| `--from` | 起始波次，默认 `w0`；失败后补跑用，如 `--from w2`。`w0` 合法（本技能会委派 W0，不同于 `porting-wave-runner`） |
| `--to` | 结束波次，默认最后一波（含 `A1`，或同时含 `联调` 与 `收尾`；都没有则取最大编号波次） |
| `--agent` | 链上所有委派使用的 agent 类型，默认 `claude_code` |
| `--depth-limit` | Codeg 委派深度上限，默认 `8`（Codeg 的 `DEPTH_MAX`）。只用于可行性计算，不会修改设置 |
| `--dry-run` | 只解析波次、算出链深与调度表，不委派 |

## 深度预算（必须先算）

设选中的波次共 **N** 环（含 W0）：链头在 depth 1，最后一环在 depth N，最后一环还要委派本波执行轨到 depth N+1。所以：

```
required_depth = N + 1
```

| 选中波次数 N | 需要 depth | 8 是否够 |
|---|---|---|
| 4（W0–W3） | 5 | 够 |
| 5（W0–W4，最常见） | 6 | 够 |
| 7（W0–W6） | 8 | 刚好 |
| 8 及以上 | ≥9 | 不够，必须 `--to` 分段跑 |

- `N + 1 > --depth-limit` → 停止，让用户分段（先跑前一段，再用 `--from` 续跑）。
- 用户实际设置可能低于 `--depth-limit`：开工前提醒「在 Codeg 设置 → 委派（Delegation）里把深度调到 ≥ required（最大 8）」。
- 子链任一环的 `delegate_to_agent` 返回 `depth_limit` 错误：不要重试，按 BLOCKED 逐层回传，并在汇总里提示提高委派深度。

## 工作流

### 0. 预检（缺一项就停，不要猜）

1. `git rev-parse --show-toplevel` 确认仓库根；后续命令都在仓库根执行。
2. 确认 `<repoRoot>/.claude/skills/porting-wave-runner/SKILL.md` 与 `<repoRoot>/.claude/skills/porting-super-runner/chain-link.md` 都存在；缺失就停（链环无法执行/无法构造下一环）。
3. 解析 `prompts.md` 路径并确认存在（目录则按 `inbox/prompts.md` → `inbox.N/prompts.md` → `prompts.md` 查找；命中多个就列出让用户指定）。
4. 推导计划目录（与 `porting-wave-runner` §0 相同）：
   - `.dev/Plans/<module>/inbox/prompts.md` → `planRoot=.dev/Plans/<module>`、`inboxDir=.../inbox`。
   - `.dev/Plans/<module>/inbox.N/prompts.md` → `inboxDir` 为该 `inbox.N`。
   - 其他路径 → `planRoot` 取所在目录，`module` 取目录名。
5. 定位 `planPath`：优先与 `inbox.N` 同号的 `plan.N.md`；否则取 `prompts.md` 正文引用的 `plan.<N>.md`；再否则取 `planRoot` 下编号最大的 `plan.*.md`。找不到就停。
6. **解析波次**：`grep -nE '^##[[:space:]]+W[0-9]+' <prompts.md>`。
   - 取唯一波次号（`W0`、`W1`…），按数字升序，记为 `waves[]`。
   - 每个波次的标题行号记为 `headLines[wave]`；`endLine` = 下一条 `^##[[:space:]]+W[0-9]+` 行号 − 1，最后一波取 `wc -l`。
   - **判定最后一波**：任一标题含 `A1`，或同时含 `联调` 与 `收尾`；否则取 `waves[]` 末尾。记为 `lastWave`。
   - `--to` 缺省为 `lastWave`；`--from` 缺省为 `w0`。
   - 选中的波次必须连续（`from` 到 `to` 之间 `waves[]` 的全部项），记为 `selected[]`。
   - 每个选中波次的标题下必须有 `~~~` 或 ``` 围栏；缺失就停并列出异常波次——不要把说明性小节当提示词派发。
   - `from` / `to` 不在 `waves[]` 里，或 `from` 在 `to` 之后 → 停止并列出可用波次。
7. **链深检查**：`N = selected.length`、`requiredDepth = N + 1`；`requiredDepth > depthLimit` → 停止并给出分段建议。
8. **分支检查（仅非 `--dry-run`）**（本技能不做任何分支操作）：
   - `git rev-parse --abbrev-ref HEAD`：在 `main` / `master` 上停止，提示先切到计划的目标分支（如 `feature/<module>`）。
   - 分支名应包含 `<module>` 或与计划 §11 的目标分支一致（`feature/<module>` / `feat/<module>` 都算）；不一致就停止让用户确认。
9. **工作区检查（仅非 `--dry-run`）**：`git status --porcelain` 排除 `.dev/` 与 `.claude/skills/`（工具目录，不算移植改动）后仍有内容 → 停止并逐条列出；不要 stash / reset / clean，不要替用户决定。
10. 非 `--dry-run` 时记录 `startSha = git rev-parse HEAD`、`branch`，并 `mkdir -p <planRoot>/waves`。
11. `--dry-run`：输出调度表（环号、波次、depth、下一环、所需 depth）、`planPath`、报告路径，然后停止。

### 1. 构造链头任务

链头是 `selected[0]`（通常是 W0）。读取 [chain-link.md](chain-link.md)，用下列变量填充后作为 `delegate_to_agent` 的 `task`：

| 变量 | 值 |
|------|----|
| `REPO_ROOT` | 仓库根绝对路径 |
| `MODULE` / `PLAN_ROOT` / `PLAN_PATH` / `PROMPTS_PATH` / `INBOX_DIR` | 预检结果；委派任务里一律用**绝对路径** |
| `CHAIN_INDEX` | `0` |
| `CHAIN_TOTAL` | `N` |
| `DEPTH` | `1` |
| `DEPTH_LIMIT` | `--depth-limit`，默认 8 |
| `WAVES` | 逗号分隔的 `selected[]`，如 `w0,w1,w2,w3,w4` |
| `WAVE` | `selected[0]` |
| `NEXT_WAVE` | `selected[1]`，没有则 `none` |
| `AGENT_TYPE` | `--agent`，默认 `claude_code` |
| `TEMPLATE_PATH` | `<repoRoot>/.claude/skills/porting-super-runner/chain-link.md` 绝对路径 |
| `START_SHA` | `startSha` |
| `BRANCH` | `branch` |
| `W0_HEADING_LINE` / `W0_END_LINE` / `W0_HEADING_TEXT` | 仅当 `WAVE=w0`：取 W0 第一个标题的行号、该波 `endLine`、`——`（其次 `—`，最后 `-`）之后的标题文本；否则 `0` / `0` / `none` |

**不要**把整个 `prompts.md` 或整份计划塞进 task；链头按模板只读 W0 的行区间，W≥1 由 `porting-wave-runner` 自己解析。

### 2. 发起链头

1. 非 `--dry-run` 时加载工具：`ToolSearch` 查询 `select:mcp__codeg-mcp__delegate_to_agent,mcp__codeg-mcp__get_delegation_status,mcp__codeg-mcp__cancel_delegation`；加载不到就停。
2. 调用一次 `delegate_to_agent`：
   - `agent_type`：`--agent`
   - `working_dir`：仓库根绝对路径
   - `task`：第 1 步填充后的全文
3. 记录 `chainHeadTaskId`。链头自身会逐层委派后续波次，**你只等这一个 task_id**。

### 3. 等待

- `get_delegation_status({ task_ids: [chainHeadTaskId], wait_ms: 60000 })` 轮询直到终态；不要发「还在跑」之类的进度消息。
- 返回 `blocked_on`：立即用一句话告诉用户哪一环、卡在什么（通常是被委派会话里的权限/问题/计划审批），然后继续轮询；同一提示只唤醒一次，重调安全。
- 终端状态为 `completed` / `failed` / `canceled`。
- `completed` 但 `text` 中存在以 `STATUS: BLOCKED` 开头的行 → 按阻塞处理。
- `completed` 但完全没有 `STATUS:` 行 → 用各波 `waves/` 报告与 `git log` 判定；仍无法确认就按阻塞处理并在报告里注明「链头未按格式回报」。
- 用户中途要求停止：加载 `cancel_delegation`，对 `chainHeadTaskId` 取消一次即可——Codeg 会连坐取消它在飞的子链（`cancel_by_parent`）。

### 4. 验收

链头结束后运行：

```bash
git rev-parse --abbrev-ref HEAD
git status --porcelain
git log --oneline <startSha>..HEAD
```

- 分支与开始时不一致 → 报告与汇总标红。
- `git status --porcelain` 排除 `.dev/` 与 `.claude/skills/` 后非空 → 报告「有未提交改动」，逐条列出；**不要**替 Agent 提交或清理。
- 提交最多列 50 条。
- **不要自己跑 cargo / pnpm**：门禁由各波执行轨与协调者负责，以它们的 `VERIFY` 为准。

### 5. 写全链报告

路径 `<planRoot>/waves/SUPER-<yyyyMMdd-HHmmss>.md`。**永远带时间戳，不覆盖**旧报告。

```markdown
# <module> · 全波次链执行报告（super-runner）

- 时间：<yyyy-MM-dd HH:mm:ss>
- 计划：<planPath>
- 提示词：<promptsPath>
- 模块：<module>
- 分支：<branch>
- 起始 SHA：<startSha>
- 结束 SHA：<git rev-parse HEAD>
- 委派 Agent：<agentType>
- 深度预算：<depthLimit>（需要 <requiredDepth>）
- 波次序列：<selected 逗号分隔>
- 链头 task_id：<chainHeadTaskId>

## 波次结果

| 环 | 波次 | 结果 | 提交 | 报告 |
|----|------|------|------|------|
| 0 | w0 | ... | ... | <planRoot>/waves/W0.md |
| ... |

> 表格优先取链头回报里的 `WAVES:` 块；缺失或残缺时，逐个读取
> `<planRoot>/waves/W<n>.md` 的「状态 / 可开启下一波」补全。

## 链头回报

<链头最终 text；超过 12000 字时保留前 3000 字 + 后 9000 字并标注「已截断」>

## 工作区

- 当前分支：
- 未提交改动：<none / 逐条>
- 本次提交：

~~~
<git log --oneline startSha..HEAD>
~~~

## 结论

- 状态：全部完成 / 有阻塞
- 完成到：<最后成功波次>
- 恢复命令：全部完成写「无」；有阻塞写 `/porting-super-runner <promptsPath> --from w<第一个未完成波次>`
- 风险与遗留：<逐条；无则 none>
```

### 6. 对话汇总

只汇报 5–10 行：状态、各波结果、最后一波/阻塞点、本链提交数、未提交改动、报告路径、恢复命令。

- 全部成功：给出 `git log --oneline <startSha>..HEAD` 提示，并提醒这是最后一次自动运行，A1 之后按计划做人工联调/验收。
- 有阻塞：明确「链在第 <n> 环停止，未继续委派下一波」，给出恢复命令 `/porting-super-runner <promptsPath> --from w<k>`。
- 深度不够：明确 required 与用户设置，给出 `--to` 分段方案。

## 硬性规则

1. **W0 也由本技能委派**：链头直接执行 A0 基线；这是与 `porting-wave-runner`（拒绝 w0）的关键区别。
2. **只编排，不施工**：本技能不改业务代码、不提交、不跑构建；只读文件、委派链头、写 `waves/` 报告。
3. **只用 codeg MCP 委派**：`delegate_to_agent` / `get_delegation_status` / `cancel_delegation`；加载不到就停，不用原生 Agent / Task / Workflow 代替。
4. **严格按序，不跳波**：链只能 W0→W1→…；某一波 BLOCKED 就不委派下一环，逐层回传。
5. **先算深度再动手**：`required = N + 1`；超过 `--depth-limit` 或 8 就停，不要赌。
6. **按引用执行**：任务里给绝对路径 + 精确波次 + 行区间（W0）或交给 `porting-wave-runner` 自解析（W≥1）；不要复制整段提示词。
7. **不越权处理工作区**：不 stash / reset / clean / checkout / 切分支；发现无关改动就停。本技能本身不做任何分支操作。
8. **不覆盖旧报告**：`SUPER-*` 永远带时间戳。
9. **等待期间少说话**：只有终态、`blocked_on`、失败或需要用户决定时才输出。

## 自检

- [ ] 已确认不在 `main` / `master`、分支与计划一致，且除 `.dev/` 与 `.claude/skills/` 外 `git status` 干净。
- [ ] 已解析出连续波次 `selected[]`，并算出 `requiredDepth = N + 1`。
- [ ] 已提醒用户把 Codeg 委派深度调到 ≥ required（最大 8）。
- [ ] 只委派了链头一个 task_id，没有自己逐波委派。
- [ ] 链头任务引用绝对路径、W0 行区间与 `chain-link.md` 模板路径。
- [ ] 等待时正确轮询，`blocked_on` 时告知用户但未提前结束。
- [ ] 报告写在 `waves/SUPER-<timestamp>.md`，没有覆盖旧文件。
- [ ] 汇总包含恢复命令与报告路径。

## 参考

- [chain-link.md](chain-link.md) —— 每一环的任务模板（含「构造下一环」的步骤）
- 前置技能：`porting-plan-waves` —— 生成 `plan.1.md`、`inbox/<lane>.md` 与 `inbox/prompts.md`
- 单波执行：`porting-wave-runner` —— 并行执行某一波并委派协调者
- Codeg 工具：`mcp__codeg-mcp__delegate_to_agent`、`mcp__codeg-mcp__get_delegation_status`、`mcp__codeg-mcp__cancel_delegation`
