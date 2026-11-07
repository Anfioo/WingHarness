# 数据库工具

**数据库**页面管理数据源，每个数据源在自己的窗口里打开。窗口是一个带页签的工作区：
一个 SQL 控制台，加上从对象树打开的每个表的数据页签。引擎是
[`src-tauri/db-core`](../../src-tauri/db-core)，移植自
[openidea](https://github.com/l0ng-ai/openidea) 的 `crates/ide-db`
（Apache-2.0）；[`db-core/UPSTREAM.md`](../../src-tauri/db-core/UPSTREAM.md)
记录了保留了什么、没有保留什么。

## 窗口与路由

| 路由 | 渲染内容 |
| --- | --- |
| `/database` | 选择页：数据源列表、添加 / 编辑 / 复制 / 删除、测试连接 |
| `/database-window?source=<id>` | 数据源窗口（label `database-<hash>`）：页签栏（控制台 + 表页签）、对象树、编辑器、结果表格、历史 |

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

## 存储

所有东西都在同一个目录 `<data dir>/db` 下，所以移动数据目录就移动了整个功能：

```
<data dir>/db/
├── data-sources.toml                        # 全局数据源
├── projects/<slug>-<hash>/data-sources.toml # 每个项目根目录一个
├── secrets.json                             # 已保存的密码，明文
└── history.json                             # 查询历史，按数据源 id
```

`secrets.json` **没有加密**，也没有放进系统凭据管理器——这是相对上游的有意差异，
对话框里的复选框也这么写。`<slug>-<hash>` 的目录名让 slug 相同的两个项目不会撞在
一起（`c:\work\app` 与 `d:\work\app` 是两个目录）。

## 连接

`db_connect` 为数据源 id 建立连接池并缓存在 `DbManager` 里；对已打开的数据库源再调用
一次是廉价的空操作，所以窗口每次挂载都可以直接调用。连接池由 `db_disconnect`、删除或
编辑数据源、以及应用退出（`DbState::shutdown`）关闭。

引擎目前能连 PostgreSQL、MySQL/MariaDB 和 SQLite。**SQL Server、ClickHouse 与 Oracle
可以保存但连不上**：`Pool::connect` 会以明确的错误拒绝，移植它们属于后续阶段。

连接目标是 `<数据源 id>`（配置里的那个数据库）或 `<数据源 id>:<数据库>`；id 里不会
出现 `:`。

## 窗口的页签

控制台是第一个页签，没有关闭按钮。双击表会把它以 `schema.table` 的形式打开成第二个
页签；再次双击同一个表只会切到已存在的页签，而另一个 PostgreSQL 数据库里的表会单独占
一个页签，因为页签的键包含连接目标。关闭当前页签会回到控制台。页签保存在 React 状态里
（`window-tabs.tsx`），不做持久化：关掉窗口就没了。

## 控制台

- **执行**（`Ctrl+Enter`）运行光标所在的语句，有选区时运行选区；**全部执行**
  （`Ctrl+Shift+Enter`）运行整个编辑器。`db_statements` 按驱动的引号规则切分文本——
  字符串、注释或 PostgreSQL `$$` 块里的 `;` 不会结束语句——它和编辑器都使用 UTF-16
  偏移，所以光标或选区能精确对回编辑器里的内容。两条语句之间的光标算在上一条上，除非
  中间隔了一个空行。
- **一次批量就是一次 `db_execute` 调用。** 语句按顺序执行，引擎**在第一个失败处停下**：
  之前执行过的保留结果，之后的完全不跑，错误落在该语句自己的 `StatementOutcome` 里而不是
  让整个调用失败，所以批量仍然会返回。取消是例外——整个调用以 `cancelled` 失败。
- **结果是按语句分的。** 返回列的语句各得一个 `Result N` 页签（默认选中最后一个成功的）；
  不返回列的语句（DML、DDL）只出现在 **Output** 里，带受影响行数。失败的语句在 Output
  里标红。
- **SQL 智能提示**在 `src/pages/database/sql/`：表、列、别名、CTE、连接、函数、关键字和
  类型的补全；对模型解析不出的名字报诊断；补全项带文档；格式化（`Ctrl+Alt+L`，有选区时
  只格式化选区）。模型每个连接由 `db_completion` 取一次，表编辑器的过滤框共用它。
- **取消**停止正在运行的批量。取消是协作式的：`db_execute` 用一个
  前端选定的请求 id 注册 `CancellationToken`，`db_cancel` 触发它，引擎用
  `tokio::select!` 配合服务器的 `pg_cancel_backend` / `KILL QUERY`（SQLite 则是丢弃
  连接）。本应用没有宿主级请求注册表，所以这张 id 表放在 `DbState` 里。
- **手动提交**把该数据源的连接切进事务（`db_set_manual_commit`）；**提交**与**回滚**
  结束它（`db_finish_transaction`）。退出手动模式会回滚未提交的内容，断开连接也一样。
- **历史**按时间倒序列出该数据源执行过的语句（保留 500 条）。点一条会放回编辑器；
  可以单条移除，也可以全部清空（`db_remove_history`）。

## 结果表格

`result-grid.tsx` 是查询结果和表数据共用的一块虚拟滚动表格（行高 28 px）：拖动列宽、
方向键与 Shift 选择、`Ctrl+C` 复制选区为 TSV、`Ctrl+Shift+C` 复制为 CSV、双击看完整
单元格，`NULL` 显示为灰色斜体。点表头排序；每列的过滤器从收到的值里挑。

在查询结果里这两个操作都是本地的，因为结果没有服务端分页可重查。在表编辑器里同样的操作
会设置 `SortKey` 或 `WHERE` 片段并重新取页，所以作用于整张表。

结果按 100、500 或 1000 行分页，还有更多行时区间显示为 `1-500 of 501+`。**导出**支持
CSV、TSV、JSON、SQL、Markdown 五种格式，走系统保存对话框和已有的 `save_text_file`
命令——没有 `db_export_file`。

## 表数据

一个表页签显示 `db_table_page` 的一页，用 `LIMIT limit + 1` 取：多出来的那一行决定
`hasMore`，不需要 `COUNT(*)`。

**编辑需要主键。** 没有主键时——无键的表，或视图——表格只读，工具栏会说明原因；即使有请求
绕过界面，后端也会以 `invalid` 拒绝这类表上的更新和删除。编辑器会标出改动过的单元格、
新增行与删除行；**提交**会先说明这批会改动多少行。

**一次提交就是一个事务。** 前端把 `DbRowEdit[]`（`update` / `insert` / `delete`）发给
`db_apply_edits`；引擎拼出 DML，并在自己的 `Pool::transaction` 里执行——绝不在控制台的
手动提交事务里，所以一次提交不会和用户尚未提交的工作半途混在一起。每个 `update` 和
`delete` 必须恰好改动一行（MySQL 的“0 行”表示“没变”，不算失败）。任何失败都会回滚整批
并保留草稿，用户可以改完再提交。

## 对象树

窗口左侧的面板浏览该数据源的对象：

```
数据库（PostgreSQL）→ schema → ┬ 表
                               ├ 视图
                               ├ 物化视图
                               ├ 例程
                               └ 序列
                                    ↓ 表
                                  列
```

每一层在第一次展开时才加载——`db_databases`、`db_schemas`、`db_tables`、
`db_table_details`、`db_schema_objects`。刷新会重读已经加载过的层级，并保留展开状态；
某一层失败时会在原处显示错误。双击表会把它打开成页签，提示文字也这么写；
`Ctrl`+双击则把它的 `SELECT` 追加到控制台。窗口只有一个控制台连接，因此另一个
PostgreSQL 数据库里的表无法被插入——对象树会给出提示。
Schemas 页签的名称模式（`*`、`?`）与对象过滤器在前端生效，因此目录查询本身不做过滤。

关闭 `options.singleDatabase` 的 PostgreSQL 数据源先列出服务器的数据库，再在每个数据库
下列出 schema；其他驱动直接列出 schema（对 MySQL 来说 schema 就是数据库）。SQLite 的
schema 列表是 `main` 加上附加数据库，因为它的目录就在每个文件里。

`db_databases` 只支持 PostgreSQL，其他驱动返回 `invalid`。例程与序列属于附加项：
服务器拒绝这些目录时，表仍然照常列出。

## 对象管理

右键节点弹出由 `tree-menu.ts` 构建的菜单。不适用的项返回的是**禁用**状态而不是直接不显示，
菜单的形状因此保持稳定：视图不能截断或修改，SQLite 不能重命名视图，等等。原因写在该项
的提示里。

每一项都是**先预览后执行**。SQL 来自 `object-sql.ts` 里的纯函数，`sql-preview.tsx`
把它显示出来，用户确认前什么都不发送——预览也可以把语句送进控制台而不是直接执行。确认后
走普通的 `db_execute`，所以没有另一套 DDL 命令需要同步维护，执行完对象树会刷新。

- **新建表 / 重命名 / 删除 / 截断 / 修改表**——生成对应语句及其选项（删除的 `IF EXISTS`、
  PostgreSQL 的 `CASCADE`、截断的 `RESTART IDENTITY`）。修改对话框通过
  `table-editor-model.ts` 的草稿模型编辑列；SQLite 只允许重命名、加列和删列，对话框里
  会说明。
- **查看 DDL**——表或视图用 `db_ddl`，例程、触发器或序列用 `db_object_ddl`。两者都只读：
  SQLite 返回存储的原文，MySQL 执行 `SHOW CREATE`，PostgreSQL 从目录里拼装；读不到定义时
  返回 `not-found`，绝不会返回半条语句。
- **SQL 脚本**（查询全部、查询前 10 行、插入、更新、删除）只把生成的语句放进控制台，不执行。

## 命令

| 分组 | 命令 |
| --- | --- |
| 数据源 | `db_sources`、`db_save_sources`、`db_set_password`、`db_test` |
| 连接 | `db_connect`、`db_disconnect`、`db_connected` |
| 事务 | `db_set_manual_commit`、`db_finish_transaction` |
| 内省 | `db_databases`、`db_schemas`、`db_tables`、`db_table_details`、`db_schema_objects` |
| 查询 | `db_execute`、`db_statements`、`db_cancel` |
| 表数据 | `db_table_page`、`db_apply_edits` |
| 定义 | `db_ddl`、`db_object_ddl` |
| 补全 | `db_completion` |
| 历史 | `db_history`、`db_remove_history` |

`db_execute` 接收 `SqlStatement[]`，返回 `StatementOutcome[]`；在原先 18 条命令之上新增的
六条是 `db_statements`、`db_table_page`、`db_apply_edits`、`db_ddl`、`db_object_ddl` 和
`db_completion`。

每条命令都登记在 [`src-tauri/CLAUDE.md`](../../src-tauri/CLAUDE.md) 描述的四个清单里，
`capabilities/default.json` 的窗口列表也在 `main` 之外加了 `database-*`。

`db_cancel`、`db_sources`、`db_connected`、`db_statements`、`db_table_page`、
`db_apply_edits`、`db_ddl`、`db_object_ddl` 和 `db_completion` 是新增的：上游的宿主注册表
与按工作台分列的列表在这里没有对应物，上游的分页、编辑与 DDL 走的是它自己的命令面，而不是
这一套。

## 错误

被拒绝的命令返回 `DbError { code, message }`；前端按 `code` 分支（`not-found`、
`invalid`、`auth-failed`、`unreachable`、`cancelled`、`protocol`、`internal`）。
`message` 是英文，且**绝不能包含密码**——`parse_url` 与连接错误都按这条规则写，
列表里显示的 URL 也会先打码。

## 尚未移植

- 查询计划（`db_explain`）与图表视图——不在范围内，不是空壳。
- 行导入（CSV 导入及其对话框）和 `db_export_file`：导出走应用已有的
  `save_text_file`。
- SQL Server、ClickHouse 与 Oracle 的连接。
- SSH 隧道——刻意不做，不是空壳：没有 `DbSsh` 设置，没有 SSH 页签，也没有
  `db_set_ssh_secret` / `db_trust_ssh_host`。

## 排查

| 现象 | 多半是 |
| --- | --- |
| 连接时报 `auth-failed` | 没有已保存的密码，也没输入；窗口会就地要密码 |
| `invalid: Project data sources need an open project` | 数据源是项目级的，但 `workspace.root` 为空 |
| “not allowed by ACL” | 命令没进 `build.rs` 或 `capabilities/default.json` |
| 用过之后列表仍显示未连接 | `connected` 是列表加载时读的；点刷新 |
| SQL Server / ClickHouse / Oracle 报 `unreachable` | 这几个驱动只能保存，尚未实现 |
| 编辑数据源后又要了一遍密码 | 按设计，改动数据源会丢掉它的会话密码 |
| 表页签是只读的 | 表没有主键，或者它是视图；更新和删除需要主键来定位行 |
| 另一个 PostgreSQL 数据库里的表插不进控制台 | 窗口只有一个连接；改成打开页签 |
| 粘贴的脚本只执行了一部分 | 语句按顺序执行并在第一个失败处停止；失败的那条在 Output 里标出 |
