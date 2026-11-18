# 邮件

**邮件**页面（`/one-mail`）是 WingHarness 的本地优先邮件客户端。它出现在侧栏的
**其他**分组里，只有一个工作区：左侧账号栏、中间会话列表、右侧打开的对话。
写信、账号表单、原始邮件与发件箱都是页面内的浮层，不新开窗口。设置位于应用的
设置窗口中的**邮件**分区。

邮件引擎是 Rust workspace crate `src-tauri/one-mail-core`。协议细节只存在于该
crate；页面只调用 `src/commands/services/one-mail/` 包装的 32 条 `one_mail_*`
命令。

> **数据目录中保存着明文邮箱密码。**
> `<data dir>/one-mail/onemail.db` 原样保存每个账号的 IMAP / SMTP 密码或授权码。
> 不要把它复制、备份或同步到你不会放置密码本身的地方。见[安全](#安全)。

## 功能一览

| 区域 | 行为 |
|------|------|
| 账号 | 内置 19 家服务商预设与自定义 IMAP；只支持密码 / 授权码；测试连接、发现文件夹、勾选同步范围；INBOX 始终同步。 |
| 同步 | 页面可见时开始同步，之后按设置的间隔重复，另有「立即同步」；可取消；只拉邮件头，正文按需加载。 |
| 会话 | 按账号与非本人参与者聚合；收发合并；话题按 `References` / `In-Reply-To` 拆分，缺失时回退到规范化主题。 |
| 阅读 | HTML 渲染前净化，远程图片逐封阻断；引用与签名折叠；附件只显示元数据；原始邮件一键查看。 |
| 写信 | 新邮件 / 回复 / 全部回复 / 转发；Markdown 正文生成 HTML + 纯文本两份；本地附件；草稿与可重试的发件箱。 |
| 搜索与筛选 | 未读、星标、今天、昨天、近 7 天筛选；关键词匹配主题、参与者与已缓存的正文。 |
| 设置 | 刷新间隔、正文显示方式、远程图片策略、同步窗口与新邮件通知。 |
| 通知 | 仅在页面可见且开关开启时为新邮件弹出系统通知。 |

## 数据位置

```
<config::dir()>/one-mail/
├── onemail.db        账号、文件夹、邮件、正文、附件、FTS5、发件箱
├── onemail.db-wal
├── onemail.db-shm
└── settings.json     刷新间隔、正文显示、远程图片、通知
```

`onemail.db` 是 WAL 模式、开启外键、`user_version = 1` 的 SQLite。迁移只向前：
更新版本写出的数据库会被原样保留，不会被降级。删除账号只需一条 `DELETE`，
文件夹、邮件、地址、正文、附件与发件箱随之级联；FTS5 行单独删除，因为 SQLite
虚拟表不能带外键。

`settings.json` 通过 `settings.json.tmp` 原子写入。损坏或取值越界的文件会被改名
为 `settings.json.bak-<Unix 秒>`，然后回落到默认值。

任何内容都不写入 `localStorage`。

## 账号与服务商

内置表有 19 家服务商：Gmail、Yahoo Mail、Outlook、网易 163、网易 126、
QQ 邮箱、腾讯企业邮、阿里云邮箱、阿里云企业邮、天翼 189、搜狐邮箱、新浪邮箱、
移动 139、21CN 邮箱、完美邮箱、iCloud Mail、AOL Mail、Yandex Mail 与
Mail.ru。第 20 项是**自定义 IMAP**，主机、端口与加密方式全部手填。126 与 163
是两条独立预设，因为二者主机不同（`imap.126.com` 与 `imap.163.com`）。

本版本只支持密码或应用专用密码。需要专用密码的服务商（Gmail、Outlook、iCloud、
Yahoo、163 等）会在账号表单中提示；OAuth、Gmail API 与 Microsoft Graph 均未实现。

创建账号时会同时建立 `INBOX` 文件夹，并尝试发现服务器上的文件夹。发现失败不会
回滚账号：账号保留，`status = sync_error`，原因已脱敏。`INBOX` 始终同步且不能
关闭，其他文件夹只有勾选后才同步。编辑账号时邮箱与服务商只读，密码留空表示保持
原值。

## 同步

每次同步走同一条状态机：`connecting → folders → headers → saving → done | error`，
通过 `one-mail:sync-progress` 事件上报。全局互斥锁保证同一时间只有一次同步；再次
发起会返回 `busy` 与当前状态。锁只保护运行标志与取消令牌，不跨网络请求持有。

- **全量**扫描以 `SINCE <syncWindowDays> 天前` 搜索，并重新读取已存在的邮件，
  刷新标记与邮件头。
- **增量**扫描以 `UID <lastUid + 1>:*` 搜索，跳过数据库中已存在的 UID。
- 文件夹的 `UIDVALIDITY` 变化会清空该文件夹的本地行并重置游标。
- 单次每个文件夹最多拉取 200 封，按 100 个 UID 一批执行 `UID FETCH`。摘要请求为
  `(UID FLAGS INTERNALDATE RFC822.SIZE BODY.PEEK[HEADER])`；同步期间从不下载正文。
- 某个账号从未同步（`lastSyncAt` 为空）时首次使用**全量**，之后一律**增量**。
  只有增量会发布新邮件事件，因此首次扫描不会一次弹出 200 条通知。
- 取消在批次之间生效，已写入的内容保留。上次完成时间与上次错误由
  `one_mail_sync_status` 返回。

没有 IDLE、常驻轮询与托盘未读数。页面隐藏时定时器停止，已经开始的同步允许完成。

通过 SMTP 发出的邮件以 `status = sent` 写入发件箱。之后同步服务器的已发送文件夹
时，`Message-ID` 已存在于发件箱的行会被跳过，因此会话中只出现一份。

## 会话与话题

会话键是 `<账号 id>:<排序后的非本人地址集合>`。收到的邮件取 `From` / `Sender`，
发出的邮件取 `To` / `Cc`；等于账号自身地址的项会被移除，因此会话只列出对方。
相同的往来人无论邮件头顺序如何都会共享同一个键。只有 `Bcc` 参与者的邮件不会进入
会话列表，只出现在发件箱；没有任何其他参与者的邮件使用按邮件区分的键。

会话内部按话题分组。`References` 与 `In-Reply-To` 会与同一会话中存在的
`Message-ID` 匹配；完全没有引用的邮件按规范化主题（去掉回复 / 转发前缀、统一
大小写，含中文前缀）与同主题的邮件合并。话题按时间正序排列，单次最多加载 500 封；
超出时响应里的 `truncated` 为真，对话区会给出提示。

草稿以及垃圾箱 / 垃圾邮件 / 草稿文件夹不进入会话。会话列表行的头像色由账号
`colorKey` 或对方地址的稳定哈希决定。

## 阅读邮件

打开会话只取摘要。每张消息卡进入视口时才请求正文
（`one_mail_message_body_load`）；后端用 `BODY.PEEK[]` 取原始邮件，解析后在一个
事务中写入纯文本、HTML、附件元数据、参与者与 FTS 行，并在本地标记已读。加载失败
会保留重试按钮，重试请求不会被吞掉。

- **HTML**：所有正文先经 DOMPurify，禁用 `script`、`style`、`link`、`meta`、
  `base`、各种框架、插件、表单、表单控件、SVG、MathML、音视频与 canvas。内联样式
  只保留排版属性。链接仅允许 `http:`、`https:` 与 `mailto:`，并用系统浏览器打开；
  webview 从不导航。
- **远程图片**：远程 `http(s)` 图片被替换为虚线占位并计数；「加载远程图片」只对
  该封邮件放行。设置可以改变默认策略，而单封按钮从不回写设置。`cid:` 图片不会
  下载，直接移除。
- **纯文本**：引用历史与签名折叠在同一个「显示引用」开关后。设置可以让所有邮件以
  纯文本显示。
- **附件**：名称、MIME 类型与解码后大小，来自元数据缓存。收到的附件不会下载，
  本版本也不能保存。
- **原始邮件**：已保存的邮件头与缓存的正文，在对话框中查看。
- **星标与已读**只改本地状态。本版本从不把 `\Seen` 或其他标记写回服务器。

## 写信

写信浮层是 CodeMirror 6 的 Markdown 编辑器，带收件人、抄送与密送字段。地址在
失焦时解析并以 chip 显示；无效地址会阻止发送。

- 发送时用 `marked` 把 Markdown 转成带样式的 HTML 与纯文本，以
  `multipart/alternative` 发出。
- 可以从系统对话框添加本地附件；路径只在发送时读取。转发不能重新附加原附件，
  因为收到的附件只有元数据；按钮禁用并给出说明。
- 回复与全部回复预填发件人 / 公开收件人、`Re: <主题>`、引用正文以及
  `In-Reply-To` / `References` 头。转发预填 `Fwd: <主题>` 与转发块，不带收件人
  与话题头。
- 关闭有改动的浮层会询问**存草稿 / 丢弃 / 取消**。丢弃已经存在的草稿会删除它。
- 发件箱列出草稿、排队中与发送中的行、失败行以及最近的已发送邮件。草稿可继续
  编辑，失败行可重试或删除，已发送只读。只有密送收件人的邮件只出现在这里，并有
  对应标记。
- SMTP 发送成功但写入已发送文件夹失败时，仍记为已发送并返回警告；界面提示
  「已发送，但未能写入已发送文件夹」。

发送状态机为 `draft → sending → sent` 或 `sending → failed`，重试走
`failed → sending`。发件箱行在建立连接之前写入，所以结果一定带真实 id。账号没有
配置 SMTP 或 `smtp_enabled = 0` 时拒绝发送。

## 搜索与筛选

会话列表支持按账号、未读、星标与收件时间范围（今天、昨天、近 7 天）筛选。在当前
账号选择范围内，关键词匹配：

- 主题与摘要；
- 发件人名称、地址以及所有已保存的参与者；
- 正文已经加载过的邮件的纯文本正文。

正文只有打开邮件后才会进入搜索，因为同步不拉取正文。列表每页 50 个会话，滚动到
底部时加载下一页。

crate 另外提供 `one_mail_messages_search`（`MessageSearchPage`）：基于 FTS5
`trigram` 搜索主题、发件人、摘要与正文，对少于 3 个字符的关键词或分词器无法解析的
查询回退到 `LIKE`。它按邮件返回命中字段与摘要片段。当前页面使用会话筛选而不是这条
命令；该命令是未来完整搜索视图的后端入口。

## 设置

设置窗口的**邮件**分区编辑 `settings.json`，每次修改立即保存；写入失败时保留上一份
文档并弹出 toast。

| 设置 | 取值 | 默认 |
|------|------|------|
| `refreshIntervalMinutes` | 1–1440 | 5 |
| `bodyDisplayMode` | `html` / `text` | `html` |
| `remoteImagesPolicy` | `block` / `load` | `block` |
| `syncWindowDays` | 1–3650 | 90 |
| `notifyOnNewMail` | 开 / 关 | 开 |

保存后发出 `one-mail:settings-changed`；页面更新本地设置并重排同步定时器。该分区
同时显示 `one-mail` 数据目录与明文密码警告。

通知通过 `@tauri-apps/plugin-notification` 发送。后端只在增量同步结束时发出
`one-mail:new-mail`（账号标签与新 INBOX 邮件）；页面仅在自身可见且
`notifyOnNewMail` 开启时弹出通知，且通知中不含邮件内容。

## 架构

| Rust 模块 | 职责 |
|-----------|------|
| `lib.rs`、`error.rs`、`models.rs` | 导出、`OneMailError { code, message, detail? }`、全部 DTO |
| `paths.rs`、`store.rs`、`schema.rs` | 数据目录、SQLite 连接池、DDL 与 `user_version` 迁移 |
| `provider.rs`、`account.rs`、`settings.rs` | 服务商表、账号增删改查 / 文件夹勾选 / 连接测试、`settings.json` |
| `transport.rs`、`imap.rs`、`smtp.rs`、`mime.rs` | IMAP 连接与取信、UID 选择与同步、lettre 发送、mailparse |
| `sync.rs`、`conversation.rs`、`search.rs`、`message.rs`、`compose.rs` | 编排与事件、会话聚合、FTS5、正文加载、草稿 / 发件箱 |
| `commands.rs`、`state.rs` | 32 条 Tauri 命令、连接池与同步状态、事件发送 |

前端位于 `src/pages/one-mail/`、`src/components/one-mail/`、
`src/hooks/use-one-mail-{page,settings}.ts`、`src/commands/services/one-mail/` 与
`src/lib/one-mail/`。事件只在页面 hook 中订阅，F 组件从不直接 `invoke`。

命令：`one_mail_providers_list`；账号与文件夹（`accounts_list`、
`account_create/update/remove/test`、`folders_list`、`folders_discover`、
`folders_set_sync`）；会话与邮件（`conversations_list`、`conversation_messages`、
`message_get`、`message_body_load`、`message_set_read/starred`、`message_raw`、
`messages_search`）；同步（`sync_start/cancel/status`）；写信
（`compose_save_draft`、`compose_delete_draft`、`compose_reply_draft`、
`compose_forward_draft`、`compose_send`、`compose_retry`、
`compose_pick_attachments`）；发件箱（`outbox_list/get/delete`）；设置
（`settings_get/set`）。

事件：`one-mail:sync-progress`、`one-mail:new-mail`、`one-mail:mailbox-changed`、
`one-mail:accounts-changed`、`one-mail:outbox-changed`、
`one-mail:settings-changed`。

## 安全

- **明文密码。** `accounts.password` 原样保存在 `onemail.db`；界面输入框掩码，
  保存后只显示占位符。`AccountSummary` 永不携带密码，传输错误只写主机、端口与阶段，
  落库的 `last_error` 会把密码替换成 `***`。不要分享或同步 `one-mail` 数据目录。
- **只有本地状态。** 已读 / 星标、文件夹选择与邮件副本都在本地。在服务器上删除、
  移动或标记已读不在本期范围，因此服务器与本应用可能在下一次同步前不一致。
- **不可信 HTML。** 每次渲染都重新净化，外部资源逐封放行，链接在 webview 之外打开。
- **没有 OAuth。** 只实现密码 / 应用专用密码认证，因此本版本没有可存储或泄露的
  刷新令牌。

## 限制

- 不支持 OAuth、Gmail API 或 Microsoft Graph。
- 不做远端删除、移动、标记回写或 `.eml` 导出。
- 收到的附件只有元数据，转发时不能重新附加。
- 没有常驻轮询、IDLE、托盘未读数或通知点击回跳。
- 单次每个文件夹最多拉取 200 封邮件头，单个话题最多显示 500 封。
- 正文搜索只覆盖已经打开过的邮件。
- 三栏并排且可拖拽宽度，目前没有窄屏自动收拢。
- 服务商的 `notes` / `setupHelpUrl` 是英文技术说明，账号表单不渲染它们，而是使用
  本地化提示。

## 上游

引擎与界面改编自 [OneMail](https://github.com/zhihui-hu/one-mail)
（AGPL-3.0-only，commit `181ccb6`）。WingHarness 整体为 AGPL-3.0-only；每个移植
文件保留归属头，
[`src-tauri/one-mail-core/UPSTREAM.md`](../../src-tauri/one-mail-core/UPSTREAM.md)
记录保留、重写与丢弃的内容。
