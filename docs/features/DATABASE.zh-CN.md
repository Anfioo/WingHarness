# 数据库工具

**数据库**页面管理数据源，每个数据源在自己的窗口里打开，带一个 SQL 控制台。
引擎是 [`src-tauri/db-core`](../../src-tauri/db-core)，移植自
[openidea](https://github.com/l0ng-ai/openidea) 的 `crates/ide-db`
（Apache-2.0）；[`db-core/UPSTREAM.md`](../../src-tauri/db-core/UPSTREAM.md)
记录了保留了什么、没有保留什么。

## 窗口与路由

| 路由 | 渲染内容 |
| --- | --- |
| `/database` | 选择页：数据源列表、添加 / 编辑 / 复制 / 删除、测试连接 |
| `/database-window?source=<id>` | 数据源窗口（label `database-<hash>`）：对象树、控制台、结果表格、历史 |

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

## 控制台

- **执行**运行一条语句（`db_execute`），最多取 500 行。还有更多行时界面会提示
  “还有更多行未显示”；分页属于后续阶段。
- **Ctrl+Enter** 执行，运行中的语句可以取消。取消是协作式的：`db_execute` 用一个
  前端选定的请求 id 注册 `CancellationToken`，`db_cancel` 触发它，引擎用
  `tokio::select!` 配合服务器的 `pg_cancel_backend` / `KILL QUERY`（SQLite 则是丢弃
  连接）。本应用没有宿主级请求注册表，所以这张 id 表放在 `DbState` 里。
- **手动提交**把该数据源的连接切进事务（`db_set_manual_commit`）；**提交**与**回滚**
  结束它（`db_finish_transaction`）。退出手动模式会回滚未提交的内容，断开连接也一样。
- **历史**按时间倒序列出该数据源执行过的语句（保留 500 条）。点一条会放回编辑器；
  可以单条移除，也可以全部清空（`db_remove_history`）。
- **结果**的表头显示列名与列类型；汇总行给出总耗时，必要时再给出服务器返回首行的耗时。

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
某一层失败时会在原处显示错误。双击表会把它的 `SELECT` 追加到控制台。窗口只有一个
控制台连接，因此另一个 PostgreSQL 数据库里的表不会被插入——对象树会给出提示。
Schemas 页签的名称模式（`*`、`?`）与对象过滤器在前端生效，因此目录查询本身不做过滤。

关闭 `options.singleDatabase` 的 PostgreSQL 数据源先列出服务器的数据库，再在每个数据库
下列出 schema；其他驱动直接列出 schema（对 MySQL 来说 schema 就是数据库）。SQLite 的
schema 列表是 `main` 加上附加数据库，因为它的目录就在每个文件里。

`db_databases` 只支持 PostgreSQL，其他驱动返回 `invalid`。例程与序列属于附加项：
服务器拒绝这些目录时，表仍然照常列出。

## 命令

| 分组 | 命令 |
| --- | --- |
| 数据源 | `db_sources`、`db_save_sources`、`db_set_password`、`db_test` |
| 连接 | `db_connect`、`db_disconnect`、`db_connected` |
| 事务 | `db_set_manual_commit`、`db_finish_transaction` |
| 内省 | `db_databases`、`db_schemas`、`db_tables`、`db_table_details`、`db_schema_objects` |
| 查询 | `db_execute`、`db_cancel` |
| 历史 | `db_history`、`db_remove_history` |

每条命令都登记在 [`src-tauri/CLAUDE.md`](../../src-tauri/CLAUDE.md) 描述的四个清单里，
`capabilities/default.json` 的窗口列表也在 `main` 之外加了 `database-*`。

`db_cancel`、`db_sources`、`db_connected` 是新增的：上游的宿主注册表与按工作台分列的
列表在这里没有对应物。

## 错误

被拒绝的命令返回 `DbError { code, message }`；前端按 `code` 分支（`not-found`、
`invalid`、`auth-failed`、`unreachable`、`cancelled`、`protocol`、`internal`）。
`message` 是英文，且**绝不能包含密码**——`parse_url` 与连接错误都按这条规则写，
列表里显示的 URL 也会先打码。

## 尚未移植

- DDL 查看（`db_ddl`、`db_object_ddl`）、`db_explain`、`db_table_page`、
  `db_apply_edits`、`db_export_file`、`db_completion`，以及用它们的界面。
- 表格编辑、对象管理与导出。
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
