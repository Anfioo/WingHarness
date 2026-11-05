# API 客户端

「API 客户端」页面是一个类 Postman 的 REST 客户端：导入 OpenAPI 3.x 或
Swagger 2.0 文档——或从空工作区开始——然后浏览请求树、编辑请求并发送。它位于
侧边栏「工作台」分组下，与仓库类页面一样，由一个选择页加每个工作区一个窗口
组成。

这种拆分是有意为之：解析、变量解析与 UI 状态由 TypeScript 负责
（[`src/lib/api-core`](../../src/lib/api-core)），文件与套接字由 Rust 负责
（[`src-tauri/api-core`](../../src-tauri/api-core)）。前端从不持有连接，引擎也
从不决定请求的含义。

## 窗口与路由

| 路由 | 渲染内容 |
| --- | --- |
| `/api-client` | 选择页：工作区、最近列表、新建工作区、导入 |
| `/api-client-window?id=…` | 单个工作区，无边框，1280 × 800（最小 1024 × 640） |

窗口标签为 `api-ws-` 加上工作区 id 的 FNV-1a 64 位哈希；再次打开同一 id 会
显示已有窗口。`api-ws-*` 前缀必须列在
[`capabilities/default.json`](../../src-tauri/capabilities/default.json) 中。

工作区窗口分三栏：左侧是集合树，中间是请求编辑器（URL 栏、方法，以及
params / headers / body / auth 标签），右侧是响应查看器（状态、耗时、大小、
响应头、正文、原始 JSON）。树的布局是每个工作区各自的 UI 状态，保存在
`localStorage` 的 `api-client-layout:<id>` 键下——而不是数据目录里。

## 发送请求

```
RequestPane → store.send()
  → resolveRequest(draft, environment)        src/lib/api-core/resolve-request.ts
       substitute {{vars}} and {{$dynamic}} in URL, params, headers, body, auth
       join a relative URL to the environment's baseUrl
  → api_send_request { requestId, request }
       cancel::register(requestId)
       send::send(request, token)             reqwest
  → HttpResponse { status, headers, bodyText | bodyBase64, sizeBytes, durationMs }
```

当 URL 报告问题（`empty`、`invalid`、`missingBase`、`baseInvalid`、
`unresolved`），或任何字段中仍含有未解析的 `{{variable}}` 时，store 会在发出
任何网络请求之前拒绝发送。正因如此，填了一半的环境得到的是一处行内错误，
而不是服务器返回的 404。

## 导入规范

```
file or URL → api_read_text_file | api_fetch_spec_url     (8 MiB cap, 30 s timeout)
  → parseOpenApiDocument(text)                            src/lib/api-core/openapi.ts
  → preview: folders, requests, warnings
  → api_import_apply(id, result, { namePrefix, baseUrl })
  → create or update the workspace, then open its window
```

解析器的行为：

| 输入 | 结果 |
| --- | --- |
| `openapi: "3.x"` | 一个集合，每个首个 tag 一个文件夹，每个 operation 一个请求 |
| `swagger: "2.0"` | 同上，基址取 `schemes[0]` + `host` + `basePath` |
| 3.1 文档 | 按 3.0 解析，并给出一条警告 |
| 无 tag 的 operation | 收进名为 `Default` 的文件夹 |
| `get put post delete options head patch` | 导入——`trace` 不导入 |
| 本地 `#/` `$ref` | 解析，带循环保护 |
| 外部或 URL 形式的 `$ref` | 跳过，并给出一条警告 |
| `allOf` | 展平 |
| `requestBody.content` | 优先 JSON，其次 form-urlencoded，再次 multipart，最后 raw |
| `http` bearer/basic、header 中的 `apiKey` | 映射到请求的 auth |
| query 或 cookie 中的 `apiKey`、OAuth、callbacks、webhooks | 给出警告并留空 |

URL 默认使用 `{{baseUrl}}/path`，路径参数改写为 `{{param}}`，因此切换一次
环境即可让所有导入的请求改指新地址。关闭 `useBaseUrlVariable` 选项时，改为
把规范自带的 server URL 写死进去。

## 命令

| 分组 | 命令 |
| --- | --- |
| 工作区 | `api_workspaces_list`、`api_workspace_create`、`api_workspace_rename`、`api_workspace_delete`、`api_workspace_load`、`api_workspace_save` |
| 导入 | `api_read_text_file`、`api_fetch_spec_url`、`api_import_apply` |
| 发送 | `api_send_request`、`api_cancel_request` |
| 其他 | `api_app_version` |

集合、请求与环境没有各自的命令：它们是 `WorkspaceTree` 的字段，由
`api_workspace_save` 整体写入。保存是手动的，并且需要 `expectedRevision`；
过期的 revision 会以 `conflict` 码被拒绝，而不是覆盖先保存的那个窗口。

错误序列化为 `{ code, message }`，`code` 取值为 `http`、`io`、`not_found`、
`json`、`url`、`conflict`、`cancelled` 或 `other`。

## 数据布局

```
<data dir>/.api-client/
├── workspaces.json      # 索引，形如 { id, name, … }
└── <id>.json            # 一个 WorkspaceTree：collections、environments、revision
```

工作区 id 最多 64 个字符，取自 `[A-Za-z0-9_-]`；名称会被清洗（100 个字符，
不含 Windows 非法字符、不含保留设备名、结尾无点或空格）。两个文件都通过
`*.json.<nanos>.json.tmp` + rename 写入，因此崩溃不会留下写了一半的工作区。

规范上限为 **8 MiB**（`api-core/src/commands.rs` 中的 `MAX_TEXT_BYTES`），
本地文件（按元数据）与 URL（按 `Content-Length` 和实际读到的字节）都会强制
检查。抓取在 30 秒后放弃。

## 传输规则

引擎使用 `reqwest`，启用 rustls、gzip/brotli/deflate 与 multipart。

| 规则 | 取值 |
| --- | --- |
| 协议 | 仅 `http` 与 `https` |
| 超时 | 默认 30 000 ms，可按请求覆盖 |
| 重定向 | 最多跟随 10 次；关闭 `followRedirects` 时不跟随 |
| TLS | 系统根证书——自签名证书会失败，且没有不安全开关 |
| 代理 / 自定义 CA | 不支持 |
| 响应正文 | 流式读取；上限 32 MiB，超出后 `truncated: true` |
| 文本或二进制 | 由 `Content-Type` 决定；缺失或非文本即视为二进制 |
| 二进制正文 | 以 `bodyBase64` 返回 |
| 取消 | 每个请求 id 一个 `watch` token，与连接及每个 chunk 赛跑 |

正则正文、表单行与 multipart 行都走与 URL 相同的变量替换。multipart 行可以
指向磁盘上的文件；引擎在阻塞线程中读取它，因此大文件上传不会阻塞异步运行时。

## 限制

- **没有请求历史、没有 cookie、没有凭据保险库。** 认证值以明文存放在工作区
  JSON 中——请把数据目录视为敏感数据。
- **活动环境只存在内存中。** 重新加载窗口会回退到第一个环境。
- **没有流式 UI。** 响应在完成时才渲染，而不是边到达边渲染。
- **保存是手动的**，且先保存的窗口胜出；`api_import_apply` 不传期望的
  revision，因此一次导入可能在已打开窗口之下抬高 revision，该窗口随后无法
  保存，直到重新加载。
- 显示编码与线上编码可能不同：URL 栏使用 `encodeURIComponent`（空格变为
  `%20`），而 `reqwest` 把表单中的空格编码为 `+`。

## 将本模块接入其他应用

1. 把 `api-core` 加入 `src-tauri/Cargo.toml`，并从 `invoke.rs` 暴露其命令。
2. 把所有 `api_*` 命令加入 `build.rs` 的 `COMMANDS` 并授予 `allow-api-*`；
   把 `api-ws-*` 加入 capability 的窗口列表。
3. 在 setup 中设置 `api_core::store::CONFIG_DIR`。
4. 拷贝 `src/lib/api-core`、`src/features/api-client`、`src/pages/api-client`
   与 `src/lib/api-windows.ts`。
5. YAML 规范在运行时需要 `yaml`；除此之外没有其他动态导入。

## 常见问题

| 现象 | 可能原因 |
| --- | --- |
| 任何 `api_*` 调用报 "not allowed by ACL" | `build.rs` 或 `capabilities/default.json` 中缺失 |
| `conflict`："changed elsewhere; reload it and try again" | 另一个窗口先保存了——revision 已过期 |
| 发送在任何网络请求之前就被拦下 | 有未解析的 `{{var}}`，或 URL 有问题，例如缺少 `baseUrl` |
| "unsupported URL scheme" | 残留的 `{{baseUrl}}` 或非 HTTP URL |
| 请求立刻以证书错误失败 | 自签名或不受信任的 TLS；没有绕过方式 |
| 正文显示二进制提示 | 响应没有文本 `Content-Type` |
| `sizeBytes` 停在 32 MiB 并带截断标记 | 触发了正文上限 |
| "the document is N bytes; the limit is 8 MiB" | 规范文件过大 |
| "the api client data directory has not been initialised" | setup 时从未设置 `CONFIG_DIR` |
| 导入预览为空 | 没有受支持的 operation，或所有 `$ref` 都是外部的——警告会说明是哪一种 |
| 取消没有反应 | 发送已经结束，或请求 id 不匹配 |
