# 单波次委派任务模板

> 由 `porting-super-runner` 填充后作为 `delegate_to_agent` 的 `task` 正文。所有 `<...>` 都必须替换成实际值；**不要把本文件原样交给子 Agent**。

---

你是 WingHarness 移植计划的**单波次执行 Agent**，运行在仓库根（绝对路径：`<REPO_ROOT>`）。

本轮只负责 **`<WAVE>`** 这一波。完成后立即返回；**下一波由主窗口负责下发，你不要委派下一波**。

## 本次信息

- 模块：`<MODULE>`
- 计划：`<PLAN_PATH>`
- 提示词：`<PROMPTS_PATH>`
- 工作单目录：`<INBOX_DIR>`
- 当前波次：`<WAVE>`
- 委派 Agent 类型：`<AGENT_TYPE>`
- 当前分支：`<BRANCH>`
- 本波起点 SHA：`<WAVE_START_SHA>`

## 硬性边界

- **只执行本波**；不要委派下一波，也不要提前为下一波做什么。
- `WAVE ≥ w1` 时只用 `porting-wave-runner` 的委派逻辑；不要自己另起一套并行 Agent。
- 不做任何分支操作（switch / create / merge / rebase / pull / push / stash / reset / clean）。
- 只 `git add` 明确路径；禁止 `git add -A` / `git add .` / `--no-verify` / `amend` / `force push`。
- 提交信息用 Conventional Commits；不要加 `Co-Authored-By`、`Generated with` 等 AI 署名行。
- 用户不会实时回答问题；必须由用户决定时停止并输出 `STATUS: BLOCKED`。

## 开工检查

1. `git rev-parse --abbrev-ref HEAD` 必须是 `<BRANCH>`；不是就停止。
2. `git status --porcelain` 排除 `.dev/` 与 `.claude/skills/`。**不要求工作树干净**；有未提交改动时先逐个查看：
   - 与本波次/本次移植相关（本计划文件、同一波次其他轨的并行进度、上一波遗留）→ 读取分析后继续；
   - 与本波次要改的文件冲突（同一文件同一区域无法共存）、同一文件混有别人的未提交改动又无法只提交自己的部分，或与本次移植完全无关 → `STATUS: BLOCKED`，逐条列出；
   - 不确定时按「相关」处理：先读再判断。
   - 若 W0 提示词里旧的措辞要求「工作树必须完全干净」或「出现非本轨文件时立即停止」，按这里的放宽规则执行。
3. 若 `WAVE ≥ w1`，用 `ToolSearch` 加载 `mcp__codeg-mcp__delegate_to_agent`、`mcp__codeg-mcp__get_delegation_status`、`mcp__codeg-mcp__cancel_delegation`；加载不到就 `STATUS: BLOCKED`。`WAVE = w0` 不需要委派工具。

## 执行本波

### 如果 `WAVE = w0`（A0 基线）

1. 只读 `<PROMPTS_PATH>` 的第 `<W0_HEADING_LINE>`–`<W0_END_LINE>` 行（Read 用 `offset=<W0_HEADING_LINE>`、`limit=<W0_END_LINE - W0_HEADING_LINE + 1>`，或 `sed -n '<W0_HEADING_LINE>,<W0_END_LINE>p'`），不要读整个文件。
2. 区间第一行必须是以「`<W0_HEADING_TEXT>`」开头的标题；若不符，改为全文搜索该标题，取其后 `~~~`（或 ```）围栏内的完整提示词。
3. 严格执行该区间内的 W0 提示词（通常一个围栏段落）：开工检查、实现、提交、自检都要做。只执行 W0。
4. 完成后写 `<PLAN_ROOT>/waves/W0.md`（已存在则写 `W0.<yyyyMMdd-HHmmss>.md`，不覆盖），包含：状态、改动文件、提交、验收命令与结果、待协调、风险。

### 如果 `WAVE ≥ w1`

1. 调用 **Skill 工具** 执行 `porting-wave-runner`，参数：`<WAVE> <PROMPTS_PATH>`；若 `AGENT_TYPE` 不是 `claude_code`，追加 `--agent <AGENT_TYPE>`。
2. 若 Skill 工具不可用或找不到该技能：读取 `<REPO_ROOT>/.claude/skills/porting-wave-runner/SKILL.md`，严格按其中步骤执行，效果等同。
3. 等 runner 完全结束（它会并行委派本波执行轨、按需重试、再委派波次协调者，并写 `<PLAN_ROOT>/waves/<WAVE>.md`，同名已存在时写带时间戳的新文件）。runner 内部遇到 `blocked_on` 会提示并继续轮询，你按它的指示等待即可，不要提前结束。
4. 读取 `<PLAN_ROOT>/waves/` 下本波最新报告，判定：
   - 「状态：完成」且「可开启下一波：是」→ 本波 DONE。
   - 任一执行轨 BLOCKED / 失败、协调者失败、或有未提交改动 → 本波 BLOCKED。

## 结束检查

- `git status --porcelain` 排除 `.dev/` 与 `.claude/skills/` 后若有改动：逐个查看。本波相关 → 在回报里列出并标注「相关未提交，继续」；与本波文件冲突或与本次移植无关 → 本波 BLOCKED。
- 记录本波提交：`git log --oneline <WAVE_START_SHA>..HEAD`。

## 返回格式

最后只输出下面这段固定格式，不要写客套话：

```
STATUS: DONE | BLOCKED
WAVE: <WAVE>
REPORT: <本波报告路径；无则 none>
COMMITS: <hash subject（每个提交一行）；无则 none>
SUMMARY: <本波一句话结果>
BLOCKED_REASON: <原因；无则 none>
NOTES: <风险/遗留；无则 none>
```

- 本波成功才写 `STATUS: DONE`。
- 阻塞、失败、报告不可信 → `STATUS: BLOCKED` 并说明原因。相关未提交改动不单独构成 BLOCKED；在 `NOTES` 里写明即可。只有与本次移植无关或与本波文件冲突的未提交改动才按 BLOCKED 处理。
- **不要在返回前委派下一波**；返回后本轮就结束了。
