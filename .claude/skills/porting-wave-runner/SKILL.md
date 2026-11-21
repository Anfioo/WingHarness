---
name: porting-wave-runner
description: 按波次执行 Codeg 委派：读取 .dev/Plans/<module>/inbox/prompts.md，把指定波次（w1、w2…）的执行提示词并行交给 Codeg 子 Agent，全部完成后自动委派波次协调者收尾，最后写 waves/W<n>.md 并汇总。W0 必须由用户手动执行。当用户说「跑 W1 波次」「委派这一波」「一个波次一个波次完成」「/porting-wave-runner w1 <prompts.md 路径>」时使用。
---

# 波次委派执行

W0（A0 基线）由用户手动委派并完成；之后每个波次用本技能一键执行：读取 `prompts.md`，把该波次的执行轨并行委派给 Codeg 子 Agent，等全部结束后自动委派波次协调者处理「待协调」，最后落盘报告并汇总。

## 何时用 / 不用

- **用**：`porting-plan-waves` 已生成 `.dev/Plans/<module>/inbox/prompts.md`，W0 已完成并提交，准备跑 W1、W2……
- **不用**：W0（用户手动）；计划还没生成（先用 `porting-plan-waves`）；只改计划不执行。
- **依赖 codeg MCP**：`delegate_to_agent` 与 `get_delegation_status`。加载不到就停止并告诉用户启用 codeg MCP，**不得**改用原生 Agent / Task 工具代替。

## 参数

```
/porting-wave-runner <wN> <prompts.md 路径> [--agent <agent_type>] [--only <lane,...>] [--dry-run]
```

| 参数 | 说明 |
|------|------|
| `<wN>` | 波次号，`w1`…`w9`，大小写不敏感。`w0` 直接拒绝：W0 必须用户手动执行 |
| `<prompts.md 路径>` | 相对仓库根或绝对路径；也可以给目录，自动找 `inbox/prompts.md`、`inbox.N/prompts.md` 或 `prompts.md` |
| `--agent` | 委派使用的 agent 类型，默认 `claude_code` |
| `--only` | 只跑指定执行轨，逗号分隔，如 `W1-A,W1-B`；用于失败后补跑 |
| `--dry-run` | 只解析并列出本波轨与协调者来源，不委派 |

## 工作流

### 0. 预检（缺一项就停，不要猜）

1. `git rev-parse --show-toplevel` 确认仓库根；后续命令都在仓库根执行。
2. 解析 `prompts.md` 路径并确认存在。目录则按 `inbox/prompts.md` → `inbox.N/prompts.md` → `prompts.md` 顺序查找，命中多个就列出让用户指定。
3. 推导计划目录：
   - `.dev/Plans/<module>/inbox/prompts.md` → `planRoot=.dev/Plans/<module>`，`module=<module>`，`inboxDir=.dev/Plans/<module>/inbox`。
   - `.dev/Plans/<module>/inbox.N/prompts.md` → 同上，`inboxDir` 为该 `inbox.N`。
   - 其他路径 → `planRoot` 取所在目录；`module` 取 `planRoot` 目录名。
4. 定位计划文件 `planPath`：优先与 `inbox.N` 同号的 `plan.N.md`；否则取 `prompts.md` 正文里引用的 `plan.<N>.md`；再否则取 `planRoot` 下编号最大的 `plan.*.md`。找不到就停。
5. 非 `--dry-run` 时加载工具：`ToolSearch` 查询 `select:mcp__codeg-mcp__delegate_to_agent,mcp__codeg-mcp__get_delegation_status`。加载不到就停，说明需要启用 codeg MCP；`--dry-run` 跳过这一步。
6. 非 `--dry-run` 时执行 Git 前置检查：
   - `git rev-parse --abbrev-ref HEAD`：在 `main` / `master` 上停止，提示先手动完成 W0 并切到计划的目标分支。
   - 分支名应包含 `<module>` 或与计划 §11 的目标分支一致（`feature/<module>` / `feat/<module>` 都算）；不一致就停止并让用户确认，避免在错误分支上委派。
   - `git status --porcelain`：排除 `.dev/`（本就不入 Git）和 `.claude/skills/`（工具目录，不属于本次移植改动）后，仍有内容就停止并逐条列出；不要 stash / reset / clean，不要替用户决定其他改动可以忽略。
   - 记录 `git rev-parse HEAD` 作为 `startSha`。
7. 非 `--dry-run` 时 `mkdir -p <planRoot>/waves`。

### 1. 解析本波

用 `grep -nE '^##[[:space:]]+W[0-9]+' <prompts.md>` 列出全部波次标题，然后：

- **本波匹配**：标题以 `## W<n>` 开头，其后必须是空白、`-`、`—` 或行尾，避免 `W1` 误匹配 `W10`。
- **标题文本**：优先取 `——` 之后的部分，没有再看 `—`，最后才用 `-`；标题文本记为 `headingText`，原始标题行号记为 `headingLine`，委派时要按行精确引用。
- **执行轨**：本波除协调者以外的全部标题。
- **必须有围栏**：每个执行轨与协调者标题下都要有 `~~~` 或 ``` 围栏；缺失就停止并列出异常标题，不要把说明性小节当提示词派发。
- **行区间**：每个标题记 `headingLine`，并记 `endLine` = 下一条 `^##[[:space:]]+W[0-9]+` 标题行号 − 1，本波最后一段取 `wc -l` 的总行数。委派时只让子 Agent 读 `headingLine`–`endLine`，不要让它读整个文件。若围栏内出现 `^##[[:space:]]+W[0-9]+` 行，说明标题解析被污染、行区间不可信：停止并列出该行。
- **协调者**：标题含 `协调者`、`收尾协调` 或 `结束协调` 之一。一个波次最多一个；出现多个就停止。
- **最后一波**：任一执行轨标题含 `A1`，或同时含 `联调` 与 `收尾`。最后一波不额外运行协调者。
- **`--only`**：只保留指定的执行轨；指定轨不存在就停止并列出本波可用轨。
- **数量保护**：执行轨为 0 就停止；超过 4 条也停止，提示检查标题或计划（计划的波次上限是 3 个窗口，最多 4 个）。
- **`--dry-run`**：输出 lane 表（轨 id、标题、标题行号、行区间）、协调者来源（现成段落 / 自动生成 / 最后一波跳过）、`planPath`、报告路径，然后停止。

### 2. 并行委派执行轨

在**同一轮**里为每条执行轨各调用一次 `delegate_to_agent`，不要串行等待。

- `working_dir`：仓库根绝对路径。
- `agent_type`：`--agent` 的值，默认 `claude_code`。
- `task`：按下面的模板，让子 Agent 只读 `prompts.md` 的对应行区间，**不要**把整段提示词复制进 task：

~~~
你是 Codeg 委派的独立执行 Agent，运行在 WingHarness 仓库根（绝对路径：<repoRoot>），当前分支 <branch>。你属于 <module> 移植计划的 <wave> 波次，执行轨 <laneId>（<laneTitle>）。

执行方式：只读 <promptsPath 绝对路径> 的第 <headingLine>–<endLine> 行（Read 用 offset=<headingLine>、limit=<endLine - headingLine + 1>，或 `sed -n '<headingLine>,<endLine>p'`），不要读整个文件。区间第一行必须是以「<headingText>」开头的标题；若不符，说明文件已变，改为全文搜索该标题，取其后 ~~~（或 ```）围栏内的完整提示词。严格执行围栏内的提示词，只执行这一节，不要执行其他波次或其他轨。

协作边界：
- 不派发新的 Agent；不联系其他轨；用户不会实时回答问题。
- 遇到必须由用户决定的事项：停止并输出 STATUS: BLOCKED + 具体原因，不要自行猜测。
- 不做任何分支操作（switch/create/merge/rebase/pull/push/stash/reset/clean）。
- 只提交自己的改动；只 git add 明确路径；禁止 git add -A / git add . / --no-verify / amend / force push。
- 提交信息用 Conventional Commits；不要加 Co-Authored-By、Generated with 等 AI 署名行。

完成回报（最后输出，供协调者读取）：
STATUS: DONE | BLOCKED
FILES: <改动文件，每行一个>
COMMITS: <hash> <subject>（每个提交一行；无则 none）
VERIFY: <验收命令与结果>
PENDING_COORDINATION: <写入本轨 inbox「## 待协调」的条目；无则 none>
BLOCKERS: <无则 none>
~~~

- 记录每条轨的 `{laneId, laneTitle, headingLine, endLine, taskId, attempt: 1}`。
- 单个 `delegate_to_agent` 调用本身报错：记为失败，进入重试流程。
- 若工具返回 `blocked_on` 或要求用户处理，按第 3 步处理。

### 3. 等待与阻塞

- 用 `get_delegation_status({ task_ids: [...仍在运行的 id], wait_ms: 60000 })` 轮询；只传仍在运行的 id。
- 终端状态为 `completed` / `failed` / `canceled`；`running` 继续等。
- **等待期间不要发「还在跑」之类的进度消息**；只在有终态、用户阻塞或需要用户决定时说话。
- 返回 `blocked_on`：立即用一句话告诉用户哪条轨、卡在什么，然后继续轮询（同一个提示只唤醒一次，重调安全）。
- `status=completed` 但 `text` 中存在以 `STATUS: BLOCKED` 开头的行：按阻塞/失败处理。
- 用户中途要求停止：加载 `mcp__codeg-mcp__cancel_delegation`，对仍在运行的 task 逐个取消，然后写报告并汇总。

### 4. 失败与重试

失败 = `status` 为 `failed` / `canceled`，或回报里出现 `STATUS: BLOCKED`。

- 先等本波所有执行轨都到终态，再统一处理失败轨的重试；不要在还有轨运行时提前收尾。
- 每条执行轨**最多重试一次**。重试仍用 `delegate_to_agent`，task 在原模板前加：

~~~
这是第 2 次尝试。上一次状态：<status>。上一次回报节选：<前 800 字>。
先用 git status 与 git log -5 检查工作区，在已有进度上继续；不要回滚或清理他人改动。仍然无法推进就输出 STATUS: BLOCKED。
~~~

- 重试成功就继续；仍失败则：**不委派协调者**，直接写报告并汇总停止。
- 已经成功的轨不要重跑。整波重跑时用 `--only` 只补失败轨。

### 5. 委派协调者

- 最后一波：跳过，报告里写「最后一波，不额外运行协调者」。
- 否则：
  - **来源**：本波有协调者标题 → 用 `prompts.md` 里那一节，行区间同 §1（`headingLine`–`endLine`）；没有 → 用 [coordinator-fallback.md](coordinator-fallback.md) 自动生成，并在报告里注明「自动生成」。
  - 只调用一次 `delegate_to_agent`，`working_dir` 与 `agent_type` 同执行轨。
  - `task` 模板：

~~~
你是 Codeg 委派的波次收尾协调者，运行在 WingHarness 仓库根（<repoRoot>），当前分支 <branch>。本波次 <wave> 的执行轨已全部结束。

本次运行信息：
- 计划：<planPath>
- 提示词：<promptsPath>
- 波次起始 SHA：<startSha>
- 协调者来源：<现成段落 / 自动生成>
- 本波次工作单：<inboxDir 下的 *.md，排除 prompts.md>

执行方式：
<现成：只读 <promptsPath> 的第 <coordinatorHeadingLine>–<coordinatorEndLine> 行（Read 用 offset/limit，或 `sed -n`），不要读整个文件。区间第一行必须是以「<coordinatorHeading>」开头的标题；若不符，说明文件已变，改为全文搜索该标题后取其后 ~~~ 围栏内的完整提示词。>
<自动生成：读取 <coordinator-fallback.md 绝对路径>，按模板与上述变量执行。>

本波次各执行轨的委派结果（每条都是独立会话，已经结束，无法联系；每条轨一段）：
### <laneId> — <laneTitle>
status: <completed / failed / canceled>
task_id: <taskId>
report:
<该轨最终回报全文；超过 12000 字时保留前 3000 字 + 后 9000 字并标注「已截断」>

约束：
- 不派发 Agent，不替执行轨补业务代码；只处理共享文件与各轨「## 待协调」。
- 不做任何分支操作；不 stash / reset / clean。
- 只 git add 明确路径；提交信息用 Conventional Commits；不要加 Co-Authored-By、Generated with 等 AI 署名行。
- 完成后按协调者提示词要求的回报格式输出。
~~~

- `--only` 补跑时，在 task 里注明「本次补跑：<lane>；其余轨此前已完成，以工作单与 git log 为准」，不要让协调者误以为本波只有一条轨。
- 协调者失败或阻塞：同样最多重试一次；仍失败则写报告并汇总停止。

### 6. 验收

协调者结束后（最后一波则在执行轨结束后）运行：

```bash
git rev-parse --abbrev-ref HEAD
git status --porcelain
git log --oneline <startSha>..HEAD
```

- 分支与开始时不一致 → 在报告与汇总里标红。
- `git status --porcelain` 非空 → 报告「有未提交改动」，列出文件；**不要**替 Agent 提交或清理。
- 本波提交最多列 50 条。
- **不要自己跑 cargo / pnpm**：门禁由各轨与协调者执行，以它们的 `VERIFY` 为准。

### 7. 写波次报告

路径 `<planRoot>/waves/W<n>.md`。`.dev/` 不入 Git，写报告不会弄脏工作区。文件已存在时写 `W<n>.<yyyyMMdd-HHmmss>.md`，**不覆盖**旧报告。最后一波把报告里的「下一波命令」写成「无（最后一波）」。

```markdown
# <module> · <wave> 波次执行报告

- 时间：<yyyy-MM-dd HH:mm:ss>
- 计划：<planPath>
- 提示词：<promptsPath>
- 分支：<branch>
- 起始 SHA：<startSha>
- 结束 SHA：<git rev-parse HEAD>
- 委派 Agent：<agentType>
- 协调者：<现成段落 / 自动生成 / 最后一波跳过>

## 执行轨

| 轨 | 标题 | task_id | 尝试 | 结果 | 耗时 |
|----|------|---------|------|------|------|
| ... | ... | ... | 1 / 2 | DONE / BLOCKED | ... |

## 各轨回报

### <laneId> — <laneTitle>

<最终回报全文>

## 协调者

- task_id：
- 结果：
- 回报：

<协调者回报全文>

## 工作区

- 当前分支：
- 未提交改动：<none / 逐条>
- 本波提交：

~~~
<git log --oneline startSha..HEAD>
~~~

## 结论

- 状态：完成 / 有阻塞
- 可开启下一波：是 / 否
- 下一波命令：`/porting-wave-runner w<n+1> <promptsPath>`
- 风险与遗留：<逐条；无则 none>
```

### 8. 对话汇总

只汇报 5–10 行：状态、各轨结果、协调者结果、本波提交、未提交改动、阻塞、报告路径、下一波命令。

- 成功时给出：`/porting-wave-runner w<n+1> <promptsPath>`
- 失败时明确「未运行协调者」，并给出补跑命令：`/porting-wave-runner w<n> <promptsPath> --only <失败轨>`
- 最后一波成功时提醒：这是最后一波，协调者已按规则跳过。

## 硬性规则

1. **W0 一律拒绝**：W0 必须用户手动执行；只接受 `w1` 及以上。
2. **只编排，不施工**：本技能不改业务代码、不提交、不跑构建；只读文件、委派 Agent、写 `waves/` 报告。
3. **只用 codeg MCP 委派**：`delegate_to_agent` / `get_delegation_status` / `cancel_delegation`；加载不到就停，不用原生 Agent / Task / Workflow 代替。
4. **按引用执行**：task 里给绝对路径 + 精确标题与行区间（`headingLine`–`endLine`），让子 Agent 只读那一小节，避免复制走样，也避免它读整个 `prompts.md`。
5. **不覆盖旧报告**：同名报告已存在时加时间戳。
6. **不越权处理工作区**：不 stash / reset / clean / checkout / 切分支；发现无关改动就停。
7. **解析不到就停**：波次不存在、多个协调者、执行轨为 0 或超过 4 条，都不要猜。
8. **等待期间少说话**：只有终态、`blocked_on`、失败或需要用户决定时才输出。

## 自检

- [ ] 没有接受 `w0`。
- [ ] 已确认不在 `main` / `master`、分支与计划一致，且除 `.dev/` 与 `.claude/skills/` 外 `git status` 干净。
- [ ] 执行轨全部并行发起，不是串行。
- [ ] 协调者在所有执行轨成功后才发起；最后一波没有额外协调者。
- [ ] 失败轨最多重试一次；仍失败时没有运行协调者。
- [ ] 任务里引用的是绝对 `prompts.md` 路径、精确标题与行区间（`headingLine`–`endLine`），并要求标题不符时全文搜索兜底。
- [ ] 报告写在 `waves/` 且没有覆盖旧文件。
- [ ] 对话汇总包含下一波命令。

## 参考

- [coordinator-fallback.md](coordinator-fallback.md) —— `prompts.md` 缺少协调者段落时的兜底模板
- 上层编排：`porting-super-runner` —— 主窗口按 W0→A1 顺序逐波下发，一次跑完
- 前置技能：`porting-plan-waves` —— 生成 `plan.1.md`、`inbox/<lane>.md` 与 `inbox/prompts.md`
- Codeg 工具：`mcp__codeg-mcp__delegate_to_agent`、`mcp__codeg-mcp__get_delegation_status`、`mcp__codeg-mcp__cancel_delegation`
