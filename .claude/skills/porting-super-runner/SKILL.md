---
name: porting-super-runner
description: 主窗口按 W0→W1→…→A1 的顺序逐波下发 Codeg 委派：每一波一个子 Agent，W0 直接施工，W≥1 调用 porting-wave-runner 并行执行本波及收尾；主窗口等这一波完成后才委派下一波。不做递归嵌套，一次挂机跑完整条移植。当用户说「一次跑完所有波次」「长时间运行」「super-runner」「从 W0 到 A1 全自动」「一条命令跑完整个移植」「无人值守跑波次」时使用。
---

# 全波次顺序执行（super-runner）

`porting-wave-runner` 一次跑一波；本技能由**主窗口**按顺序逐波下发，一次启动就从 W0 跑到最后一波 A1。

## 结构（重点是：主窗口下发，不是递归）

```
主窗口（你，depth 0）
├─ 委派波次 Agent W0（depth 1）→ 等它完成 → 主窗口检查 → 继续
├─ 委派波次 Agent W1（depth 1）
│    └─ 它调用 porting-wave-runner → runner 并行委派 W1 各轨 + 协调者（depth 2）
│    → 等它完成 → 主窗口检查 → 继续
├─ 委派波次 Agent W2（depth 1）→ 同上
└─ …最后一波
```

- **主窗口负责下发**：每次只委派当前这一波，等它返回后才委派下一波。
- **主窗口必须看得到 N 次委派**：选了几波，主窗口就实际发起几次 `delegate_to_agent`（W0、W1、W2…各一次），在对话里是一行行独立的委派记录；**不是**一次任务包办所有波。
- **波次 Agent 只干自己这一波**：W0 直接执行 A0 基线；W≥1 调用 `porting-wave-runner`，由 runner 去并行委派本波执行轨与协调者。
- **波次 Agent 不委派下一波**：它跑完就返回，下一波由主窗口继续下发。所以不会递归下去。
- 每一波都是全新的子 Agent，深度都是 1；runner 的执行轨在 depth 2。

## 深度

```
required_depth = 2
```

- 主窗口 depth 0 → 波次 Agent depth 1 → 该波执行轨 / 协调者 depth 2。
- **波数不影响深度**：W0–W4 和 W0–W10 都只需要 2 层。
- Codeg 里把委派深度调到 **≥ 2** 即可；调到 8 也没问题，只是用不到。
- 若主窗口本身是某个委派会话（不在 depth 0），实际深度会叠加，需要相应提高设置。
- 任一 `delegate_to_agent` 返回 `depth_limit`：不要重试，按 BLOCKED 停止并提示提高委派深度。

**运行前提**：委派 Agent 的权限模式要能自动执行，否则某一波会停在权限提示上。主窗口只能直接看到当前波次 Agent 的 `blocked_on`；runner 内部执行轨停在提示时，去 Codeg 会话列表里找到对应子会话回答，不要取消主窗口的等待。

## 参数

```
/porting-super-runner <prompts.md 路径> [--from w0] [--to wN] [--agent <agent_type>] [--depth-limit 2] [--dry-run]
```

| 参数 | 说明 |
|------|------|
| `<prompts.md 路径>` | 相对仓库根或绝对路径；也可给目录，按 `inbox/prompts.md` → `inbox.N/prompts.md` → `prompts.md` 查找 |
| `--from` | 起始波次，默认 `w0`；失败后补跑用，如 `--from w2`。`w0` 合法（本技能会委派 W0，不同于 `porting-wave-runner`） |
| `--to` | 结束波次，默认最后一波（含 `A1`，或同时含 `联调` 与 `收尾`；都没有则取最大编号波次） |
| `--agent` | 每一波委派使用的 agent 类型，默认 `claude_code` |
| `--depth-limit` | 只用于可行性检查，默认 `2`。小于 2 就停；不会修改 Codeg 设置 |
| `--dry-run` | 只解析波次与下发顺序，不委派 |

## 工作流

### 0. 预检（缺一项就停，不要猜）

1. `git rev-parse --show-toplevel` 确认仓库根；后续命令都在仓库根执行。
2. 确认 `<repoRoot>/.claude/skills/porting-wave-runner/SKILL.md` 与 `<repoRoot>/.claude/skills/porting-super-runner/wave-task.md` 都存在；缺失就停。
3. 解析 `prompts.md` 路径并确认存在（目录则按 `inbox/prompts.md` → `inbox.N/prompts.md` → `prompts.md` 查找；命中多个就列出让用户指定）。
4. 推导计划目录（与 `porting-wave-runner` §0 相同）：
   - `.dev/Plans/<module>/inbox/prompts.md` → `planRoot=.dev/Plans/<module>`、`inboxDir=.../inbox`。
   - `.dev/Plans/<module>/inbox.N/prompts.md` → `inboxDir` 为该 `inbox.N`。
   - 其他路径 → `planRoot` 取所在目录，`module` 取目录名。
5. 定位 `planPath`：优先与 `inbox.N` 同号的 `plan.N.md`；否则取 `prompts.md` 正文引用的 `plan.<N>.md`；再否则取 `planRoot` 下编号最大的 `plan.*.md`。找不到就停。
6. **解析波次**：`grep -nE '^##[[:space:]]+W[0-9]+' <prompts.md>`。
   - 取唯一波次号（`W0`、`W1`…），按数字升序，记为 `waves[]`。
   - 每个波次的第一个标题行号记为 `headLines[wave]`；`endLine` = 下一条 `^##[[:space:]]+W[0-9]+` 行号 − 1，最后一波取 `wc -l`。
   - **判定最后一波**：任一标题含 `A1`，或同时含 `联调` 与 `收尾`；否则取 `waves[]` 末尾。记为 `lastWave`。
   - `--to` 缺省为 `lastWave`；`--from` 缺省为 `w0`。
   - 选中的波次必须连续（`from` 到 `to` 之间 `waves[]` 的全部项），记为 `selected[]`。
   - 每个选中波次的标题下必须有 `~~~` 或 ``` 围栏；缺失就停并列出异常波次。
   - `from` / `to` 不在 `waves[]` 里，或 `from` 在 `to` 之后 → 停止并列出可用波次。
7. **深度检查**：`--depth-limit` 小于 2 → 停止，提示主窗口 + 波次 Agent + runner 执行轨至少需要 2 层。
8. **分支检查（仅非 `--dry-run`）**（本技能不做任何分支操作）：
   - `git rev-parse --abbrev-ref HEAD`：在 `main` / `master` 上停止，提示先切到计划的目标分支（如 `feature/<module>`）。
   - 分支名应包含 `<module>` 或与计划 §11 的目标分支一致（`feature/<module>` / `feat/<module>` 都算）；不一致就停止让用户确认。
9. **工作区检查（仅非 `--dry-run`）**：`git status --porcelain` 排除 `.dev/` 与 `.claude/skills/`（工具目录，不算移植改动）。非空时**不要立刻停止**，先逐个查看内容：
   - 与本次移植相关（本计划文件、并行轨进度、上一波遗留）→ 读取分析后继续；
   - 与本波次要改的文件冲突或与本次移植完全无关 → 停止并逐条列出；不要 stash / reset / clean。
   - 不确定时按「相关」处理：先读再判断，只有确认冲突或无关才停。
10. 非 `--dry-run` 时记录 `startSha = git rev-parse HEAD`、`branch`，并 `mkdir -p <planRoot>/waves`。
11. `--dry-run`：输出下发顺序表（序号、波次、行区间、depth、说明）、`planPath`、报告路径，然后停止。

### 1. 逐波下发（核心循环）

先加载一次工具：`ToolSearch` 查询 `select:mcp__codeg-mcp__delegate_to_agent,mcp__codeg-mcp__get_delegation_status,mcp__codeg-mcp__cancel_delegation`；加载不到就停。

按 `selected[]` 顺序，**一次只处理一波**。这里的硬性要求：**每一波在主窗口里单独调用一次 `delegate_to_agent`**，task 只装这一波；禁止把所有波合并进一个 task，禁止委派一个「总执行者」代跑全部波。

1. 记录本波起点 `waveStartSha = git rev-parse HEAD`。
2. 读取 [wave-task.md](wave-task.md)，用下列变量填充成 `task`：

| 变量 | 值 |
|------|----|
| `REPO_ROOT` | 仓库根绝对路径 |
| `MODULE` / `PLAN_ROOT` / `PLAN_PATH` / `PROMPTS_PATH` / `INBOX_DIR` | 预检结果；任务里一律用**绝对路径** |
| `WAVE` | 当前波次，如 `w1` |
| `AGENT_TYPE` | `--agent`，默认 `claude_code` |
| `BRANCH` | 当前分支 |
| `WAVE_START_SHA` | 本波起点 `waveStartSha` |
| `W0_HEADING_LINE` / `W0_END_LINE` / `W0_HEADING_TEXT` | 仅当 `WAVE=w0`：W0 第一个标题行号、该波 `endLine`、`——`（其次 `—`，最后 `-`）之后的标题文本；否则 `0` / `0` / `none` |

**不要**把整个 `prompts.md` 塞进 task；W0 按行区间读，W≥1 由 `porting-wave-runner` 自己解析。

3. 调用一次 `delegate_to_agent`：
   - `agent_type`：`--agent`
   - `working_dir`：仓库根绝对路径
   - `task`：上一步填充后的全文
4. 记录 `waveTaskId`，用 `get_delegation_status({ task_ids: [waveTaskId], wait_ms: 60000 })` 轮询直到终态：
   - `blocked_on`：立即用一句话告诉用户哪一波、卡在什么（通常是权限/问题/计划审批），然后继续轮询；同一提示只唤醒一次。
   - `completed` 且 text 中存在以 `STATUS: DONE` 开头的行 → 进入第 5 步。
   - `completed` 且 text 中存在以 `STATUS: BLOCKED` 开头的行，或 `failed` / `canceled`，或完全没有 `STATUS:` 行 → 本波 BLOCKED，停止循环。
   - 用户中途要求停止：`cancel_delegation(waveTaskId)`，写报告并汇总。
5. **本波验收**：
   - `git rev-parse --abbrev-ref HEAD` 应仍为 `branch`；变了就标红并停止。
   - `git status --porcelain` 排除 `.dev/` 与 `.claude/skills/`：**不要求为空**。有改动时逐个查看——本波相关（本计划文件、下一波仍需的进度）→ 记入报告并继续；与本波文件冲突或与本次移植无关 → 本波记 BLOCKED，停止。不要替 Agent 提交或清理。
   - 读取 `<planRoot>/waves/` 下本波最新报告（`<WAVE>.md` 或 `<WAVE>.<timestamp>.md`）；报告不存在或状态为「有阻塞」时本波记 BLOCKED。
   - 记录 `git log --oneline <waveStartSha>..HEAD` 作为本波提交。
6. 把本波结果追加到全波次报告（见 §3），然后回到第 1 步处理下一波。**不要在还有波次未处理时提前结束**。
7. 全部波次 DONE 才进入 §4。

### 2. 失败时

- 某一波 BLOCKED / failed / canceled：**不再下发后续波次**，立即进入 §3 写报告并 §4 汇总。
- 本技能不做自动重试：各波内部的重试由 `porting-wave-runner`（执行轨最多重试一次）和 W0 自己的提示词负责；主窗口不重跑已完成的波。
- 补跑用 `--from w<失败波次>`；已成功的波不要重跑。

### 3. 写全波次报告

路径 `<planRoot>/waves/SUPER-<yyyyMMdd-HHmmss>.md`。**本次运行固定这一个路径**；每完成一波就更新它（同一路径内追加/重写），这样中途失败也有记录。不要写到别的运行的文件里。

```markdown
# <module> · 全波次顺序执行报告（super-runner）

- 时间：<yyyy-MM-dd HH:mm:ss>
- 计划：<planPath>
- 提示词：<promptsPath>
- 模块：<module>
- 分支：<branch>
- 起始 SHA：<startSha>
- 当前/结束 SHA：<git rev-parse HEAD>
- 委派 Agent：<agentType>
- 下发顺序：<selected 逗号分隔>
- 需要的委派深度：2

## 波次结果

| 序号 | 波次 | 结果 | 提交 | 报告 |
|------|------|------|------|------|
| 0 | w0 | DONE | <hash> | <path> |
| 1 | w1 | DONE / BLOCKED | ... | <path> |
| ... |

未执行的波次写「未执行（上游阻塞）」或「未执行（--to 截止）」。

## 各波回报

### <wave>
<该波次 Agent 的最终回报；过长时保留前 3000 字 + 后 3000 字并标注「已截断」>

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

### 4. 汇总

只汇报 5–10 行：状态、各波结果、阻塞点、本次提交数、未提交改动、报告路径、恢复命令。

- 全部成功：给出 `git log --oneline <startSha>..HEAD` 提示，并提醒 A1 之后按计划做人工联调/验收。
- 有阻塞：明确「第 <wave> 波停止，后续波次未下发」，给出 `/porting-super-runner <promptsPath> --from w<k>`。
- 深度不够：明确至少需要 2 层，并提示 Codeg 设置里的委派深度。

## 硬性规则

1. **主窗口下发，不递归**：每次只委派当前一波；主窗口对每一波各发起一次 `delegate_to_agent`，波次 Agent 不委派下一波。
2. **W0 也由本技能委派**：W0 的波次 Agent 直接执行 A0 基线；这是与 `porting-wave-runner`（拒绝 w0）的关键区别。
3. **W≥1 交给 runner**：波次 Agent 调用 `porting-wave-runner`，不自己重写并行执行逻辑。
4. **只编排，不施工**：本技能不改业务代码、不提交、不跑构建；只读文件、委派波次 Agent、写 `waves/` 报告。
5. **只用 codeg MCP 委派**：`delegate_to_agent` / `get_delegation_status` / `cancel_delegation`；加载不到就停，不用原生 Agent / Task / Workflow。
6. **严格按序，不跳波**：某一波 BLOCKED 就停止，不下发后续波。
7. **按引用执行**：W0 给行区间；W≥1 交给 `porting-wave-runner` 自解析。
8. **不越权处理工作区**：不 stash / reset / clean / checkout / 切分支。有未提交改动时先看内容：相关进度继续，冲突或与本次移植无关才停；不强制要求工作树干净。
9. **等待期间少说话**：只有终态、`blocked_on`、失败或需要用户决定时才输出。

## 自检

- [ ] 已确认不在 `main` / `master`、分支与计划一致；`git status` 有改动时已逐个判断：相关则继续，冲突/无关才停。
- [ ] 已解析出连续波次 `selected[]` 和最后一波。
- [ ] 已确认委派深度 ≥ 2（波数不影响深度）。
- [ ] 逐波下发：每一波一个子 Agent，等它完成并验收后才下发下一波。
- [ ] 主窗口实际发起了 N 次 `delegate_to_agent`（每波一次），不是一次总任务。
- [ ] 波次 Agent 的任务里**没有**「委派下一波」的步骤。
- [ ] 某一波 BLOCKED 后没有下发后续波。
- [ ] 报告写在本次运行的 `waves/SUPER-<timestamp>.md`，并包含各波结果。
- [ ] 汇总包含恢复命令与报告路径。

## 参考

- [wave-task.md](wave-task.md) —— 单个波次的委派任务模板（不包含下一波）
- 前置技能：`porting-plan-waves` —— 生成 `plan.1.md`、`inbox/<lane>.md` 与 `inbox/prompts.md`
- 单波执行：`porting-wave-runner` —— 并行执行某一波并委派协调者
- Codeg 工具：`mcp__codeg-mcp__delegate_to_agent`、`mcp__codeg-mcp__get_delegation_status`、`mcp__codeg-mcp__cancel_delegation`
