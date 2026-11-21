# 波次链环节任务模板

> 由 `porting-super-runner` 填充后作为 `delegate_to_agent` 的 `task` 正文。所有 `<...>` 都必须替换成实际值；**不要把本文件原样交给子 Agent**。每一环在委派下一环时，读取本文件、复制正文、替换变量，得到下一环的完整任务。

---

你是 WingHarness 移植计划的波次链环节 Agent（super-runner 链），运行在仓库根（绝对路径：`<REPO_ROOT>`）。

## 本次链信息（按此执行，不要自行推断）

- 模块：`<MODULE>`
- 计划：`<PLAN_PATH>`
- 提示词：`<PROMPTS_PATH>`
- 工作单目录：`<INBOX_DIR>`
- 链序号：`<CHAIN_INDEX>` / `<CHAIN_TOTAL>`（0 基）
- 当前波次：`<WAVE>`
- 下一波次：`<NEXT_WAVE>`
- 本环节委派深度：`<DEPTH>` / 上限 `<DEPTH_LIMIT>`
- 全链波次：`<WAVES>`
- 委派 Agent 类型：`<AGENT_TYPE>`
- 模板路径：`<TEMPLATE_PATH>`
- 工作区起点 SHA：`<START_SHA>`
- 当前分支：`<BRANCH>`

## 硬性边界

- 只用 codeg MCP 委派：先用 `ToolSearch` 加载 `mcp__codeg-mcp__delegate_to_agent`、`mcp__codeg-mcp__get_delegation_status`、`mcp__codeg-mcp__cancel_delegation`；加载不到就输出 `STATUS: BLOCKED`，说明缺少 codeg MCP。
- 只委派「下一环」一个 Agent；不要并发多条链，不要联系其他链。
- 不做任何分支操作（switch / create / merge / rebase / pull / push / stash / reset / clean）。
- `WAVE ≥ w1` 时不替执行轨写业务代码；本波业务由 `porting-wave-runner` 或其执行轨完成。`WAVE = w0` 时本环节就是 A0 执行者，按第 1 步施工。
- 只 `git add` 明确路径；禁止 `git add -A` / `git add .` / `--no-verify` / `amend` / `force push`。
- 提交信息用 Conventional Commits；不要加 `Co-Authored-By`、`Generated with` 等 AI 署名行。
- 本环节自己不要向用户提问；必须由用户决定的事项按阻塞处理。子链的 `blocked_on` 是例外，按第 3 步继续轮询。
- **提前结束本轮会取消你在飞的子链**（Codeg 的 `cancel_by_parent`），所以下一环还在跑时不要结束本轮。

## 第 1 步：执行本波

### 如果 `WAVE = w0`（A0 基线）

1. 只读 `<PROMPTS_PATH>` 的第 `<W0_HEADING_LINE>`–`<W0_END_LINE>` 行（Read 用 `offset=<W0_HEADING_LINE>`、`limit=<W0_END_LINE - W0_HEADING_LINE + 1>`，或 `sed -n '<W0_HEADING_LINE>,<W0_END_LINE>p'`），不要读整个文件。
2. 区间第一行必须是以「`<W0_HEADING_TEXT>`」开头的标题；若不符，说明文件已变，改为全文搜索该标题，取其后 `~~~`（或 ```）围栏内的完整提示词。
3. 严格执行该区间内的 W0 提示词（通常一个围栏段落）：它要求的开工检查、实现、提交、自检都要做。只执行 W0，不执行其他波次。
4. 完成后写 `<PLAN_ROOT>/waves/W0.md`（已存在则写 `W0.<yyyyMMdd-HHmmss>.md`，不覆盖），包含：状态（DONE / BLOCKED）、改动文件、提交 hash、验收命令与结果、待协调、风险。
5. 本波结束检查：`git status --porcelain` 排除 `.dev/` 与 `.claude/skills/` 后应为空；非空则记为 BLOCKED。

### 如果 `WAVE ≥ w1`

1. 调用 **Skill 工具** 执行 `porting-wave-runner`，参数：`<WAVE> <PROMPTS_PATH>`；若 `AGENT_TYPE` 不是 `claude_code`，追加 `--agent <AGENT_TYPE>`。
2. 若 Skill 工具不可用或找不到该技能：读取 `<REPO_ROOT>/.claude/skills/porting-wave-runner/SKILL.md`，严格按其中步骤执行，效果等同。
3. `porting-wave-runner` 会并行委派本波执行轨、等待、最多重试一次、再委派波次协调者，并写 `<PLAN_ROOT>/waves/<WAVE>.md`（同名已存在时写带时间戳的新文件）。
4. 结束后读取 `<PLAN_ROOT>/waves/` 下本波最新的报告（`<WAVE>.md` 或 `<WAVE>.<timestamp>.md`）与 `git status --porcelain` 判定本波结果：
   - 报告「状态：完成」且「可开启下一波：是」→ 本波 DONE。
   - 任一执行轨 BLOCKED / 失败、协调者失败、或工作区（排除 `.dev/`、`.claude/skills/`）有未提交改动 → 本波 BLOCKED。

## 第 2 步：决定是否继续

- 本波 DONE 且 `NEXT_WAVE ≠ none` → 进入第 3 步。
- 本波 BLOCKED / 失败，或 `NEXT_WAVE = none` → 跳过第 3 步，直接进入第 4 步。

## 第 3 步：委派下一环

1. 读取 `<TEMPLATE_PATH>`（就是本模板文件），复制其正文。
2. 替换下面这些变量，构造下一环任务；**其余变量保持不变**：
   - `CHAIN_INDEX` = 当前值 + 1
   - `DEPTH` = 当前值 + 1
   - `WAVE` = 当前 `NEXT_WAVE`
   - `NEXT_WAVE` = `<WAVES>` 中当前 `NEXT_WAVE` 之后的那一项；没有就 `none`
   - `W0_HEADING_LINE` = `0`、`W0_END_LINE` = `0`、`W0_HEADING_TEXT` = `none`（下一环不可能是 w0）
   - `START_SHA` = 当前 `git rev-parse HEAD`
   - `BRANCH` = 当前 `git rev-parse --abbrev-ref HEAD`
3. 深度保护：若 `NEXT_WAVE ≠ none` 且 `DEPTH + 2 > DEPTH_LIMIT`，不要委派；输出 `STATUS: BLOCKED`，原因写「委派深度不足：下一环需要 depth <DEPTH+1>，其执行轨需要 depth <DEPTH+2>，上限 <DEPTH_LIMIT>」。
4. 调用一次 `delegate_to_agent`：
   - `agent_type` = `<AGENT_TYPE>`
   - `working_dir` = `<REPO_ROOT>`
   - `task` = 上一步构造的完整正文
5. 用 `get_delegation_status({ task_ids: [<nextTaskId>], wait_ms: 60000 })` 轮询直到终态：
   - `blocked_on`：这是用户需要在 Codeg 界面回答的提示。继续轮询，不要结束本轮（结束会取消下一环）。只有用户明确要求停止时才取消。
   - `completed` 且 text 含 `STATUS: BLOCKED` → 下一环记 BLOCKED。
   - `completed` 但完全没有 `STATUS:` 行 → 下一环记 BLOCKED（无法确认）。
   - `failed` / `canceled` → 下一环记 BLOCKED。
   - 不要主动取消下一环。

## 第 4 步：汇总返回

最后只输出下面这段固定格式（供上一环读取），不要写客套话：

```
STATUS: DONE | BLOCKED
CHAIN: <CHAIN_INDEX>/<CHAIN_TOTAL> <WAVE> -> <NEXT_WAVE>
WAVES:
- <wave>: DONE|BLOCKED | commits: <h1,h2 或 none> | report: <报告路径>
- ...（含下一环回传的各波，按执行顺序；每波最多 6 行）
THIS_WAVE: <本波一句话结果>
NEXT_RESULT: <下一环的 STATUS 行；无则 none>
BLOCKED_AT: <波次或 none>
BLOCKED_REASON: <原因；无则 none>
REPORTS: <本波及下游的 waves 报告路径，逗号分隔>
NOTES: <风险/遗留；无则 none>
```

判定规则：

- 本波 DONE 且（`NEXT_WAVE = none` 或下一环 DONE）→ `STATUS: DONE`。
- 本波 BLOCKED 或下一环 BLOCKED / failed / canceled → `STATUS: BLOCKED`，`BLOCKED_AT` 写第一个未完成的波次。
- `WAVES:` 必须包含本波与所有下游波；下游回报缺失的波要注明「未执行（上游阻塞）」。
