# 数据库工具

**数据库**页面管理数据源，每个数据源在自己的窗口里打开。窗口是一个带页签的工作区：
每个查询文件一个页签，从对象树打开的每个表一个页签；下次打开窗口时页签集合会恢复。
引擎是 [`src-tauri/db-core`](../../src-tauri/db-core)，移植自
[openidea](https://github.com/l0ng-ai/openidea) 的 `crates/ide-db`
（Apache-2.0）；[`db-core/UPSTREAM.md`](../../src-tauri/db-core/UPSTREAM.md)
记录了保留了什么、没有保留什么。

## 窗口与路由

| 路由 | 渲染内容 |
| --- | --- |
| `/database` | 选择页：数据源列表、添加 / 编辑 / 复制 / 删除、测试连接 |
| `/database-window?source=<id>` | 数据源窗口（label `database-<hash>`）：连接栏、对象树、页签栏与活动页签 |

窗口 label 只允许字母数字和 `-`、`/`、`:`、`_`，所以 id 是被哈希进去的：
`database-` 加 16 位十六进制的 FNV-1a 摘要（`src/lib/window-label.ts` 的
`hashedWindowLabel`）。重复打开同一个数据源只会聚焦已开的那个窗口，不会叠出第二个。
id 本身走查询串，因为 `main.tsx` 只按 `pathname` 路由，查询串由窗口页面自己读。

## 数据源

一个数据源是一台服务器或一个 SQLite 文件。保存的字段就是
`db-core/src/source.rs` 定义的那些：

| 字段 | 含义 |
| --- | --- |
| `driver` | `sqlite`、`postgres`、`mysql`、`sqlServer`、`clickhouse`、`oracle` |
| `file` | SQLite 数据库文件；相对路径按项目根目录解析 |
| `host` / `port` / `database` / `user` | 服务器连接 |
| `urlOnly` / `url` | 用一个 URL 代替上面的字段（接受 `jdbc:`） |
| `ssl` | `disable`、`prefer`（默认）、`require`、`verifyCa`、`verifyFull` |
| `savePassword` | 是否允许使用已保存的密码 |
| `readOnly` | 拒绝查询以外的语句 |
| `global` | 存在全局而不是当前项目下 |
| `options.transaction` | `auto`，或 `manual`（由控制台显式提交） |
| `color`、`comment`、`vendor`、`properties`、`introspection` | 展示与高级设置 |

**作用范围。** 数据源要么是全局的（`global`），要么属于当前打开的项目。项目数据源
需要项目根目录（`config.json` 的 `workspace.root`）；没有打开项目时，对话框的开关
停在全局，引擎也会以 `invalid` 拒绝项目数据源。同一个 id 的项目数据源优先于全局的。

**密码不进数据源文件，也不进 DTO。** 密码只通过 `db_set_password` 传递：内存里留一份
会话副本，需要时再写一份已保存副本。列表只报告 `hasSavedPassword`，没有任何命令能把
密码读回来。

**供应商预设。** 驱动下拉框上面还有一层供应商列表（`vendors.ts`）：PostgreSQL、
MySQL，以及它们周围协议兼容的服务器（Aurora、CockroachDB、MariaDB、Neon、Supabase、
TimescaleDB、TiDB 等）。预设只填驱动、端口、SSL 要求和 URL 协议，不会改主机、数据库、
用户名，也不会改表单是否用 URL 连接——字段下方的提示也是这么写的。

表单底部的**高级**区默认收起，放连接超时、SSL 模式和默认 Schema。保存时会丢掉空值，
所以数据源不会长出一条空的 `properties`。

## 存储

所有东西都在同一个目录 `<data dir>/db` 下，所以移动数据目录就移动了整个功能：

```
<data dir>/db/
├── data-sources.toml                        # 全局数据源
├── projects/<slug>-<hash>/data-sources.toml # 每个项目根目录一个
├── secrets.json                             # 已保存的密码，明文
├── history.json                             # 查询历史，按数据源 id
├── query/<源名> <n>.sql                     # 查询文件，纯 UTF-8
├── windows.json                             # 每个窗口的页签
└── settings.json                            # 行数上限
```

`secrets.json` **没有**加密，也不在系统钥匙串里——这是相对上游的有意分歧，对话框的
勾选框也这么写。`<slug>-<hash>` 目录名让路径 slug 相同的项目互不覆盖
（`c:\work\app` 和 `d:\work\app` 是两个目录）。

**查询文件**和数据源同名、按第一个空闲序号创建：`local 1.sql`、`local 2.sql`。
文件名必须非空、以 `.sql` 结尾、不超过 120 个字符、不含路径分隔符或控制字符，
也不能是 `.` 或 `..`；否则是 `invalid`。窗口在用户停止输入 800 ms 后写回文件；
关闭页签会把文件留在磁盘上。`db_query_delete` 可以删除一个文件，但当前窗口没有为它
提供按钮——查询文件是用户自己的文档。

**`windows.json`** 保存每个数据源窗口的页签集合和活动页签。页签键是
`query:<文件>` 和 `table:<target>\0<schema>\0<table>`；存下的 `active` 如果不对应
任何页签就重置为 `null`。保存一个窗口只替换该数据源的条目，其他数据源原样保留；
读改写在同一进程内串行化。

**`settings.json`** 保存控制台行数上限和表数据页大小。两者都在写入时钳制：
`consoleRows` ∈ [100, 50000]，`tablePageSize` ∈ [100, 5000]；越界是 `invalid`。
读取时越界值回落默认值（500），而不是让窗口失败。

**每个 JSON 都是原子写**：先写 `<file>.tmp`，再 `write`、`sync_all`、`rename`。
解析失败的文件会被复制成 `<file>.bak-<unix 秒>` 并换回默认值，同时在日志里记一条
警告；版本号不认识时同样处理，不做猜测。不是合法 UTF-8 的查询文件报 `not-found`，
文件本身不动。

## 连接

`db_connect` 为数据源 id 建立连接池并缓存在 `DbManager` 里；对已打开的数据源再调
`db_connect` 是廉价的空操作，所以窗口每次挂载都可以调。连接池由 `db_disconnect`、
删除或编辑数据源、以及退出应用（`DbState::shutdown`）关闭。

引擎目前能连 PostgreSQL、MySQL/MariaDB 和 SQLite。**SQL Server、ClickHouse 与
Oracle 可以保存但不能连接**：`Pool::connect` 会给出明确的错误，移植它们是后续阶段。

连接目标要么是 `<数据源 id>`（它配置的数据库），要么是 `<数据源 id>:<数据库>`；
id 里不会出现 `:`。

对象树上方的连接栏显示连接状态、手动事务开关和提交 / 回滚按钮。已保存的密码不够用时
会弹密码对话框；取消对话框则窗口保持未连接。

## 窗口的页签

页签栏里有两种页签：

- **查询页签**——查询目录里的一个文件，标题就是文件名，随用户编辑写回。
- **表页签**——某个连接目标上的一张表，标题是 `schema.table`。

双击表会把它打开成页签；重复双击同一张表只切换过去；另一个 PostgreSQL 数据库里的表
会得到自己的页签，因为页签键包含连接目标。`Ctrl`+双击不打开数据页签，而是把该表的
`SELECT` 插入活动查询页签。

页签可以用 `×`、鼠标中键或右键菜单关闭；右键菜单还有**关闭其他**、**全部关闭**和
**重新打开**。最近关闭的 20 个页签会被记住，**重新打开**恢复最近的一个。一个页签都
没有时，右栏是空工作区：**新建查询**和**打开查询**。

页签集合、活动页签和每个查询页签的文件内容都落在 `windows.json`；变化后 300 ms 写入。
恢复窗口时重新读文件，所以编辑器显示的是最新正文；存过之后文件已消失的页签会被跳过。

## 查询页签

- **运行**（`Ctrl+Enter`）执行光标处语句，有选区时执行选区；**全部运行**
  （`Ctrl+Shift+Enter`）执行整个编辑器。`db_statements` 按驱动的引号规则切分——
  字符串、注释或 PostgreSQL `$$` 体里的 `;` 不会结束语句——而且它和编辑器都用
  UTF-16 偏移，所以光标或选区与编辑器看到的位置一一对应。两条语句之间的光标默认算
  前一条，除非中间隔着空行。
- **参数**——语句里有 `?`、`$1`、`:name` 或 `@name` 占位符时，页签先问值，替换后
  再发送。按钮上显示还差几个值。
- **一批语句就是一次 `db_execute` 调用。** 语句按顺序执行，引擎**在第一个失败处
  停下**：之前跑完的保留结果，之后的完全不跑，错误落在该条语句自己的
  `StatementOutcome` 里而不是让整次调用被拒绝，所以整批仍然会返回。取消是例外——
  整次调用以 `cancelled` 失败。
- **结果页签。** 返回列的语句生成 `Result N` 页签（自动选中最后一个成功结果）；
  不返回列的语句（DML、DDL）只出现在 **Output**，带影响行数。失败语句在那里标红。
  结果页签最多保留 12 个，超出后丢弃最旧的重跑结果。
- **SQL 智能**在 `src/pages/database/sql/`：表、列、别名、CTE、join、函数、关键字
  与类型的补全，无法解析名称的诊断，补全项的文档，以及格式化（`Ctrl+Alt+L`，
  有选区时格式化选区）。模型来自每个连接一次的 `db_completion`，与表编辑器的过滤框
  共用。
- **行数**——工具栏的行数选择限定一个结果最多保留多少行；值存在 `settings.json`，
  对所有查询页签生效。
- **取消**停止正在跑的批次。取消是协作式的：`db_execute` 在前端选定的请求 id 下注册
  一个 `CancellationToken`，`db_cancel` 触发它，引擎用 `tokio::select!`（服务器支持
  时再加 `pg_cancel_backend` / `KILL QUERY`；SQLite 直接丢弃连接）。应用没有宿主的
  请求注册表，所以这张 id 表放在 `DbState`。
- **手动事务**把数据源的连接切进事务（`db_set_manual_commit`）；**提交**和
  **回滚**结束它（`db_finish_transaction`）。退出手动模式会回滚未提交的内容，
  断开连接同理。
- **历史**按时间倒序列出该数据源执行过的语句（保留 500 条）。对话框可以搜索、预览、
  把一条粘回编辑器，以及单条删除或全部清空（`db_remove_history`）。

## 执行计划

**解释**（`Alt+Enter`）对光标处语句调用 `db_explain`，在结果页签旁边打开 **Plan**
页签。引擎按驱动各自的语法加前缀——SQLite 是 `EXPLAIN QUERY PLAN`，PostgreSQL 是
`EXPLAIN (FORMAT JSON)`，MySQL 是 `EXPLAIN FORMAT=JSON`——再把各家的答案归一成
同一组 `PlanNode`：id、父节点、深度、算子、详情和节点的 `properties`。

页签按服务器返回的顺序渲染节点，用 `depth` 缩进；选中节点后右侧显示它的属性，
**Explain Again** 会重发一次语句。服务器拒绝的语句以服务器错误失败；不支持的驱动
（SQL Server、ClickHouse、Oracle）返回 `invalid`。

## 结果表格

`result-grid.tsx` 是一个虚拟化表格（28 px 行高），查询结果和表数据共用：拖动列宽、
方向键与 Shift 选区、`Ctrl+C` 复制 TSV、`Ctrl+Shift+C` 复制 CSV、双击看完整单元格，
`NULL` 用灰色斜体显示。点表头排序；每列的过滤框从表格拿到的值里选。

`data-view.tsx` 在表格上方加上 IDEA 的搜索栏——大小写、整词、正则开关，以及行过滤
——旁边是侧栏，把选区显示成 **Record**（字段 / 值）、**Value**（单个单元格）或
**Aggregates**（选区里数值列的计数、求和、平均、最小、最大）。`Ctrl+F` 打开搜索栏，
`Ctrl+F12` 按名称跳到某一列。

在查询结果里搜索和排序是本地的，因为结果没有可重新查询的服务器分页。表编辑器里同样
的动作会设置 `SortKey` 或 `WHERE` 片段并重新取页，所以作用于整张表。

结果页是语句的一个窗口，不是它的副本：分页器显示 `first-last of total`，总数未知时
显示 `+`，并提供 **COUNT** 去问服务器；**重跑**按当前页大小重新执行语句并回到第一页。
**导出**通过系统保存对话框和既有的 `save_text_file` 写 CSV、TSV、JSON、SQL 或
Markdown——没有 `db_export_file`。

## 表数据

表页签显示 `db_table_page` 的一页，查询用 `LIMIT limit + 1`：多出来的那一行决定
`hasMore`，不需要 `COUNT(*)`。

它的工具栏放着页大小（100、500、1000 或 5000，每个数据源记住）、回车生效的 `WHERE`
过滤、回车解析并发送的 `ORDER BY`（解析失败标红且不发送）、导入与导出、表格的搜索栏
与侧栏，以及草稿动作（加行、删除与还原行、**提交**、**撤销**）。状态行显示可见范围、
有多少行待提交，以及只读时的原因。

**编辑需要主键。** 没有主键时——无键表或视图——表格只读且工具栏说明原因；后端对这类
表的 update / delete 也会以 `invalid` 拒绝，即使请求绕过了界面。编辑器会标记改过的
单元格、新增行和删除行；**提交**先显示这批会改动多少行。

**一次提交就是一个事务。** 前端把 `DbRowEdit[]`（`update` / `insert` / `delete`）
发给 `db_apply_edits`；引擎生成 DML 并跑在自己的 `Pool::transaction` 里——绝不放进
控制台的手动事务，所以一次提交不会和用户尚未提交的工作混成半成品。每条 `update` 和
`delete` 必须正好改一行（MySQL 的「0 行」表示「未变化」，不算失败）。任何失败都会回滚
整批并保留草稿，让用户改完再提交。

**导入**读取通过系统打开对话框选中的 CSV、TSV、`;` 或 `|` 分隔文件。分隔符由前几行
猜测且可以改；对话框把文件表头名映射到表的列（忽略大小写，只匹配同名），空值可以当作
`NULL` 或空字符串，写之前先预览前几行。确认后把文件转成 `DbRowEdit` 插入，交给
`db_apply_edits` 的同一个事务，所以一行有问题就整批回滚。

## 对象树

窗口左栏浏览数据源里的对象：

```
databases（PostgreSQL）→ schemas → ┬ tables
                                   ├ views
                                   ├ materialized views
                                   ├ routines
                                   └ sequences
                                        ↓ 一张表
                                      columns / primary keys / foreign keys /
                                      indexes / triggers
```

每一层都在第一次展开时加载——`db_databases`、`db_schemas`、`db_tables`、
`db_table_details`、`db_schema_objects`。一张表的五组元数据来自一次
`db_table_details`，每组标签右侧显示计数；空组不渲染。列在属于主键时显示
`type · PK`，外键显示 `columns → ref_table(ref_columns)`。刷新只重读已加载的层级，
并保留展开的节点；某一层失败时在树里就地显示错误。表的提示说明双击打开、
`Ctrl`+双击插入 `SELECT`。窗口只有一个控制台连接，所以另一个 PostgreSQL 数据库里的
表不能插入——树会把这一点指出来。Schemas 页签的名称模式（`*`、`?`）和对象过滤在
前端应用，目录查询本身保持不过滤。

`options.singleDatabase` 关闭的 PostgreSQL 数据源先列服务器的数据库，再列每个数据库
的 schema；其他驱动直接列 schema（MySQL 里 schema 就是数据库）。SQLite 的 schema
列表是 `main` 加上 attached 的数据库，因为它的目录在每个文件里。

`db_databases` 只对 PostgreSQL 有效，其他驱动返回 `invalid`。例程与序列是附加项：
拒绝这些目录的服务器仍然会列出表。

对象树上方的工具栏是 IDEA 的七个动作：**新建**（查询、已有查询文件或表）、
**属性**、**刷新**、**断开**、**跳到控制台**、**编辑数据**和 **DDL**。依赖选中的
动作在选中的节点是表或视图之前保持禁用；**新建**下拉与树的右键菜单用同一个
`newMenu()`，**打开查询…**与空工作区用同一个选择器。

## 对象管理

右键节点会打开由 `tree-menu.ts` 构建的菜单，按 IDEA 的七组排列：New、Copy/Paste、
Quick Documentation、Navigation、SQL Scripts、Import/Export、Object Actions。
不适用的项返回**禁用**而不是消失，菜单形状因此稳定：视图不能 truncate 或改表，
SQLite 不能重命名视图，依此类推。原因写在该项自己的提示里。

每一项都是**先预览再执行**。SQL 来自 `object-sql.ts` 里的纯函数，`sql-preview.tsx`
把它显示出来，用户确认之前什么也不发——预览也可以把语句送进控制台而不执行。确认后走
普通的 `db_execute`，所以没有一套需要同步维护的独立 DDL 命令，执行完树会刷新。

- **新建表 / 重命名 / 删除 / 清空 / 改表**——生成带选项的语句（删除时的 `IF EXISTS`、
  PostgreSQL 的 `CASCADE`、清空时的 `RESTART IDENTITY`）。改表对话框用
  `table-editor-model.ts` 的草稿模型编辑列；SQLite 只允许重命名、加列和删列，
  对话框会说明。
- **导入数据**——表页签自己的导入对话框，从树里打开。
- **显示 DDL**——表和视图用 `db_ddl`，例程、触发器和序列用 `db_object_ddl`。
  两者都只读：SQLite 返回存下的文本，MySQL 跑 `SHOW CREATE`，PostgreSQL 从目录
  拼出语句；读不到定义是 `not-found`，绝不返回半条语句。
- **快速文档**——同一份 DDL 的弹窗，不离开树。
- **SQL 脚本**（全选、前 10 行、insert、update、delete）把生成的语句插入活动查询
  页签，不执行。

## 命令

| 组 | 命令 |
| --- | --- |
| 数据源 | `db_sources`、`db_save_sources`、`db_set_password`、`db_test` |
| 连接 | `db_connect`、`db_disconnect`、`db_connected` |
| 事务 | `db_set_manual_commit`、`db_finish_transaction` |
| 内省 | `db_databases`、`db_schemas`、`db_tables`、`db_table_details`、`db_schema_objects` |
| 查询 | `db_execute`、`db_statements`、`db_cancel`、`db_explain` |
| 查询文件 | `db_queries`、`db_query_read`、`db_query_write`、`db_query_delete` |
| 窗口状态 | `db_window_tabs`、`db_save_window_tabs`、`db_settings`、`db_save_settings` |
| 表数据 | `db_table_page`、`db_apply_edits` |
| 定义 | `db_ddl`、`db_object_ddl` |
| 补全 | `db_completion` |
| 历史 | `db_history`、`db_remove_history` |

一共三十三条。`db_execute` 接收 `SqlStatement[]`、返回 `StatementOutcome[]`；
`db_explain` 接收一条语句、返回 `PlanNode[]`。工作区阶段新增的九条是
`db_queries`、`db_query_read`、`db_query_write`、`db_query_delete`、
`db_window_tabs`、`db_save_window_tabs`、`db_settings`、`db_save_settings` 和
`db_explain`；读写文件的命令之所以是新的，是因为上游的工作台自己管文件，而且没有
任何命令接触密码。

每条命令都登记在
[`src-tauri/CLAUDE.md`](../../src-tauri/CLAUDE.md) 描述的四个列表里，每个数据库窗口
（`database-*`）都与 `main` 一起出现在 `capabilities/default.json`。处理列表与
`build.rs` 自己的 `COMMANDS` 不一致时，构建会失败。

## 错误

被拒绝的命令返回 `DbError { code, message }`；前端按 `code` 分支（`not-found`、
`invalid`、`auth-failed`、`unreachable`、`cancelled`、`protocol`、`internal`）。
`message` 是英文，且**绝不能包含密码**——`parse_url` 和连接错误的写法都遵循这条规则，
列表里显示的 URL 也先做了掩码。查询文件的错误只带文件名、不引用正文，因为脚本里可能
有字面量凭据。

## 尚未移植

- 图表视图（`ChartView.tsx` 与 `resultView.ts` 的图表序列）——不在范围内，
  不是占位。
- SSH 隧道——有意不做，不是占位：没有 `DbSsh` 设置、没有 SSH 页签、没有
  `db_set_ssh_secret` / `db_trust_ssh_host` 命令。
- Oracle 与 ClickHouse 驱动；SQL Server 同样——三者都能保存，但 `Pool::connect`
  会拒绝。

## 排查

| 现象 | 可能原因 |
| --- | --- |
| 连接时 `auth-failed` | 没有已保存密码也没输入；窗口会追问 |
| `invalid: Project data sources need an open project` | 数据源是项目级，但 `workspace.root` 为空 |
| “not allowed by ACL” | 命令没写进 `build.rs` 或 `capabilities/default.json` |
| 用过之后列表仍显示未连接 | `connected` 在列表加载时读取；用刷新 |
| SQL Server / ClickHouse / Oracle 报 `unreachable` | 这些驱动只保存、尚未实现 |
| 编辑数据源后又要重输密码 | 改动数据源会丢弃会话密码，这是设计 |
| 表页签只读 | 表没有主键，或者是视图；update / delete 需要主键定位行 |
| 另一个 PostgreSQL 数据库的表插不进控制台 | 窗口只有一个连接；请把它打开成页签 |
| 粘贴的脚本只跑了一部分 | 语句按顺序执行并在第一个失败处停下；失败的那条在 Output 标红 |
| 窗口恢复后页签变少 | 存下的查询文件或表已不存在，该页签被跳过 |
| 切到另一个窗口再回来查询页签是空的 | 恢复时会重读文件；正文在最后一次按键后 800 ms 写回 |
| 保存设置时报 `invalid` | 行数上限不在 [100, 50000]，或页大小不在 [100, 5000] |
