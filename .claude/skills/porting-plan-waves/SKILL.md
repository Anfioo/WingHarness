---
name: porting-plan-waves
description: 为一个待移植或集成的项目生成多 Agent 波次开发计划，输出 .dev/Plans/<module>/ 下的 plan.1.md、inbox/<lane>.md 与 inbox/prompts.md。适用于 Tauri v2 + React 项目的功能移植（新开 <module>-core crate、加侧栏入口、接入 WingHarness）。当用户给出源项目路径或仓库地址，并说「移植」「迁移」「port」「生成计划」「多 agent 计划」「开波次」「多个窗口并行写代码」时使用。
---

# 移植计划 · 多 Agent 波次

把一个源项目变成一套可执行的并行施工图：一份计划 + 每个执行轨一份工作单 + 原有 A0/A1 执行提示词 + 每个施工波次结束后的协调者提示词。用户仍按原方式手动开启各轨；协调者只负责处理上一波各轨留下的「待协调」，把当前工作区推进到可以开启下一波的状态，不负责派发执行 Agent。

## 交付物

```
.dev/Plans/<module>/                   # 相对仓库根
├── plan.1.md          # 计划本体（frp / md-editor 那套骨架）
└── inbox/
    ├── A0.md          # 协调者基线工作单（必须存在）
    ├── B1.md …        # 后端轨，每个窗口一份
    ├── F1.md …        # 前端轨，每个窗口一份
    ├── A1.md          # 收尾轨：联调、补测、文档
    └── prompts.md     # A0/A1 执行提示词 + 每个施工波次结束后的协调者提示词
```

- `<module>` 用 kebab-case，与已有目录一致：`frp`、`md-editor`、`svn`。
- 目录已存在时递增编号写 `plan.2.md`，**不覆盖**旧计划。
- `.dev/` 不入 Git；计划文档开头写明这一点。

## 路径约定

生成的所有计划、工作单、提示词里，路径按**是否在仓库内**分两类：

| 路径 | 写法 | 例子 |
|------|------|------|
| 仓库内的一切（源码、文档、`.dev/` 下的计划与参考工程缓存） | **相对仓库根**，不带盘符、不带 `..` 前缀 | `src/main.tsx`、`.dev/Plans/frp/plan.1.md`、`.dev/Projects/md-editor/src/App.tsx` |
| 仓库外的路径（用户给的源项目绝对路径、外仓样板计划） | 绝对路径，带盘符 | `M:\MaBangProjectsWorkflowsResource\Plans\frp\` |

- 提示词里的「工作目录」写「仓库根（WingHarness 仓库根目录）」，不写盘符；命令一律相对仓库根执行，不出现 `cd M:\...` 或 `git -C M:\...`。
- git URL 源项目 clone 到 `.dev/Projects/<name>`，此后一律用这个相对路径引用，不写回绝对路径。
- 源项目本来就在仓库外（用户给的是 `D:\...` 之类）时保留绝对路径：窗口不在本仓工作树内，相对路径无意义。
- 除 `.dev/` 这类例外，**不要**给仓库内路径加 `M:\WingHarness\` 前缀——换机器、换工作树、换盘符都会失效。

## 何时用 / 何时不用

- **用**：源项目 → WingHarness 的功能移植；一次规划 ≥2 个可并行窗口。
- **先用 `porting-decisions`**：交付形态、范围、数据、许可还没定的时候。它产出 `decisions.md`，本技能直接引用，避免重复提问。
- **不用**：单文件小改动；单人顺序执行的计划（那用 `writing-dev-plans`）。

## 输入

| 输入 | 必需 | 处理 |
|------|------|------|
| 源项目位置 | 是 | 绝对路径 → 只读校验存在（仓库内则改写成相对仓库根的路径）；git URL / `owner/repo` → clone 到 `.dev/Projects/<name>`（已存在则直接用，不重拉），之后一律用相对路径引用 |
| 决策文件 | 否（强烈建议） | `.dev/Plans/<module>/decisions.md`，由 `porting-decisions` 产出。**先读它**：已答问题不再问，结论直接落 §0 / §10 |
| 模块名 | 否 | 从源项目名推断，写进 §0「计划默认」 |
| 范围 / 不做项 | 否 | 缺就按源项目能力裁剪，全部写进 §1.2 与 §0 |
| 目标分支 | 否 | 默认 `feature/<module>`，从 `main` 切出 |

**源项目只读**：不修改、不构建、不在其中创建文件。

## 工作流

### 0. 先读决策文件（如果给了）

`decisions.md` 存在时，它优先于提问：

| 决策文件里的 | 落到 |
|--------------|------|
| §3 决策记录（已定 Q） | §0 表格，来源写「用户确认」；§10 补对应 Dn |
| §4 默认假设 | §0 表格，来源写「计划默认」 |
| §1 已核实的事实 | §2 的复核起点——**仍要实测一次**，数字以你的实测为准 |
| §2 冲突清单 | §1.2 / §3 / §4 的处理结论 |
| §5 开放问题 | §13 开工前检查清单 |

已答的问题不得重复问。只有决策文件没覆盖、且会影响范围或形态的新问题才进入下一步。

### 1. 先问清楚（最多 4 问，一次问完）

只有用户没说清的才问，问完把答案写进 plan §0 的「已确认的决定」表：

- **交付形态**：侧栏单页 / 侧栏页 + 独立窗口 / 多窗口
- **范围边界**：源项目哪些模块要做、哪些明确不做
- **存储与安全**：数据落 `config::dir()/<module>/` 还是复用现有存储；凭据是否明文
- **参考实现取舍**：源项目里哪套依赖/框架换成本仓的（如 CodeMirror 5 → 6、CSS → Tailwind）

用户已在提示里说清的不重复问；推断出的决定标「计划默认」，不伪装成「用户确认」。

### 2. 核实现状（禁止凭空写）

先读 [project-facts.md](project-facts.md) 拿到本仓的挂载点与硬约束，然后逐项**实测**：

| 要核对的 | 记什么 |
|----------|--------|
| 源项目结构 | 目录树、每个待移植文件的行数、`LICENSE`、外部依赖、命令数 |
| 目标仓现有 crate | `src-tauri/Cargo.toml` 的 `members`，避免重名 |
| 路由与侧栏 | `src/lib/app-routes.ts`、`src/lib/sidebar-config.ts`、`src/main.tsx` |
| i18n | `src/i18n/index.ts` 的命名空间注册方式；en/zh 键是否成对 |
| 命令注册 | `src-tauri/src/invoke.rs`、`build.rs`、`capabilities/default.json` |
| 可复用资产 | 渲染器、编辑器、虚拟列表、格式化函数、现有 hooks |
| 文档与许可 | `docs/features/`、`docs/UPSTREAM_PROJECTS.md`、`THIRD_PARTY_NOTICES.md` |

- 每个「可直接移植 / 需改写 / 丢弃」的判断都要落到 `路径:行号`。
- 参考文档与实测冲突时**以实测为准**，并写「参考说 X，实测 Y」。
- 行数用 `(Get-Content <file>).Count`、目录规模用 `Get-ChildItem -Recurse -File | Measure-Object`。

### 3. 切轨道

固定命名：**A0 协调者 + B\* 后端 + F\* 前端 + W\* 波次收尾协调者 + A1 收尾**。A0/A1 仍是实际施工轨；W\* 只处理上一波的「待协调」，不派发、不实现执行轨业务。

| 轨 | 职责 | 并行性 |
|----|------|--------|
| A0 | 分支、crate 骨架、挂载点、命令桩、DTO 契约、路由 + 页面壳、i18n 骨架、各轨 inbox | 串行，必须第一个完成 |
| B1…Bn | `<module>-core` 内的互斥模块 | 同波次并行 |
| F1…Fn | 页面 / 组件 / hooks | 同波次并行 |
| W\* | 波次收尾协调者 | 读取上一波各轨 `## 待协调`，修改共享文件或协调契约，把工作区推进到可以开启下一波的程度 | 每个施工波次结束后运行，串行 |

硬规则：

1. **每个波次最多 3 个窗口**；文件集可证明两两不相交且无人碰共享文件时才允许 4 个。
2. **文件集两两不相交**；每轨文件之和 = 本次全部改动文件，没有孤儿文件。
3. **共享文件只归 A0 与波次收尾协调者**：`src-tauri/Cargo.toml`、`build.rs`、`invoke.rs`、`capabilities/default.json`、`src/main.tsx`、`app-routes.ts`、`sidebar-config.ts`、`src/commands/index.ts`、i18n 入口、页面壳、`<module>-core` 的 `lib.rs / error.rs / paths.rs / models.rs / commands.rs`。W*-C 只能为处理上一波待协调而修改这些共享文件。
4. A0 必须冻结：命令名与参数、DTO 字段、错误码、事件名与 payload、公开函数签名、前端 wrapper 签名。后续轨只依赖桩，不等彼此。
5. 各轨需要新增字段/命令/文案时，写进自己 inbox 末尾的 `## 待协调`，由对应的 W*-C 处理；确需延后时由 W*-C 明确记录后交 A1。

### 4. 写 `plan.1.md`

套用 [plan-template.md](plan-template.md)，章节顺序不改。必须包含：

- §0 已确认的决定（带「来源」列）
- §1.2 明确不做、§1.3 硬约束
- §2 参考实现核验结论（逐文件：行数 / 处理）
- §4 文件映射与工作量（逐文件行数 + 人日，末尾汇总）
- §6 命令与事件面（命令表、事件表、错误码）
- §9 阶段与排期 + 里程碑
- §10 决策记录 `D1…Dn`
- §11 多 Agent 方案（波次、文件所有权、共享协议、派发顺序、提交规范、分支约束、提交点）
- §12 风险与规避
- §13 开工前检查清单
- 附录 A 命令 ACL 名对照、附录 B i18n 键结构、附录 C 验收命令、附录 D 上游归属

### 5. 写 `inbox/<lane>.md`

套用 [lane-template.md](lane-template.md)。一份文件就是该窗口的完整工作单，打开就能开工。

### 6. 写 `inbox/prompts.md`

套用 [prompts-template.md](prompts-template.md)。保留 A0、各 B/F 执行轨和 A1 的原有执行提示词；在每个施工波次的执行轨提示词之后，增加一个该波次结束后的协调者提示词。协调者提示词只处理上一波各轨工作单中的 `## 待协调`，不负责派发执行 Agent，不替代任何执行轨。

每段执行轨提示词必须含原有 12 项。每段波次协调者提示词必须说明：上一波已完成的前置条件、需要读取的各轨工作单、待协调项处理顺序、可修改的共享文件范围、不得越界实现业务逻辑、验收命令、工作区达到可开启下一波的判定、阻塞时停止报告，以及完成后的回报格式。

### 7. 回报

只汇报：写了哪些文件、波次表、每条轨的提交点、假设与待用户拍板项。不要复述整份计划。

## 跨生成物的硬规则

- **正文中文**；代码、标识符、路径、命令名、字段名一律英文。
- 仓库内路径写**相对仓库根的路径**（`src/main.tsx`、`.dev/Plans/frp/plan.1.md`），不带盘符；仓库外的源项目才写绝对 Windows 路径。详见上文「路径约定」。
- 数字给实测值；估不准的写「待核实」，不要写成结论。
- 提交消息：`<type>(<scope>): <中文摘要>`，type/scope 英文，摘要 ≤ 50 字，正文中文每条以 `- ` 开头、与前文空一行。type 只允许 `feat/fix/docs/style/refactor/perf/test/build/ci/chore/revert`。
- 只 `git add <明确路径>`；禁止 `git add -A` / `git add .` / `--no-verify` / `amend` / `force push`。
- 分支：协调者开工前从 `main` 建 `feature/<module>` 并切换；此后**任何轨**不得 checkout/switch/reset/stash/clean/rebase/merge/pull/push。
- 所有窗口共用同一工作树与 `target/`；同时只跑一个 cargo 构建，不并发 `pnpm tauri dev`。
- 许可：本仓 AGPL-3.0-only。AGPL / GPL-3.0 / MIT / BSD / ISC / Apache-2.0 / MPL / LGPL 可移植；无许可证与被准入表拒绝的许可证**不可**。移植文件保留署名头，整子系统加 `UPSTREAM.md`，同一次改动更新 `THIRD_PARTY_NOTICES.md` 与 `docs/UPSTREAM_PROJECTS.md`。

## 质量自检

- [ ] §0 每条决定都标了「用户确认」或「计划默认」。
- [ ] §2 的每个判断都有源仓路径；行数是实测的。
- [ ] 各轨文件集两两不相交，且并集 = 全部改动文件。
- [ ] 每个波次 ≤ 3 个窗口（4 个时写明了原因）。
- [ ] A0 冻结的签名足够让 B/F 轨在 A0 完成后立即并行。
- [ ] 每个施工波次都有对应的收尾协调者提示词，且明确“处理完上一波待协调后，工作区达到可以开启下一波”的完成条件。
- [ ] 协调者提示词不包含派发执行 Agent 的职责；A0、B/F、A1 的原有执行提示词仍保留。
- [ ] 明确列出了「不做」和「开工前检查」。

## 参考

- [plan-template.md](plan-template.md) —— `plan.1.md` 骨架
- [lane-template.md](lane-template.md) —— `inbox/<lane>.md` 骨架
- [prompts-template.md](prompts-template.md) —— `inbox/prompts.md` 骨架
- [project-facts.md](project-facts.md) —— WingHarness 的挂载点、硬约束、门禁命令与坑
- 前置技能：`porting-decisions` —— 方案未定时先产出 `.dev/Plans/<module>/decisions.md`
- 后续执行：`porting-wave-runner` —— 按波次并行委派执行轨，全部完成后自动委派波次协调者
- 全链执行：`porting-super-runner` —— 把 W0→A1 的多波串成一条委派链，一条命令跑完
- 样板计划（仓库外，故写绝对路径）：`M:\MaBangProjectsWorkflowsResource\Plans\frp\`、`M:\MaBangProjectsWorkflowsResource\Plans\md-editor\`
