# 浏览器下载捕获

**WingHarness — download capture** 是下载页面的配套浏览器扩展。它通过
`127.0.0.1` 把 HTTP/HTTPS 链接、浏览器选择的文件名和请求上下文交给
WingHarness。源码位于 `extension/`，使用纯 JavaScript，无运行时依赖，也不随
桌面安装包分发。

## 捕获路径与行为

扩展通过三种路径投递下载：

1. **链接点击。** 内容脚本在浏览器请求可下载链接之前拦截，从而在快速路径上
   避免浏览器保存对话框。
2. **响应拦截，仅 Firefox。** Firefox MV3 版本可在服务器驱动的附件弹出保存
   对话框之前取消并转发。
3. **浏览器下载兜底。** 对前两条路径遗漏的情况，扩展暂停新建的浏览器下载并
   转发 URL；此时 Chromium 可能已经弹出保存对话框。

每条路径都可携带目标 URL 的 Cookie、Referer 与 User-Agent。启用捕获后，
始终可以右键链接、图片或视频并选择 **Download with WingHarness**。自动捕获
默认关闭。`blob:`、`data:`、流媒体和非 HTTP URL 仍交给浏览器，因为
WingHarness 无法把它们作为普通 HTTP 资源重新获取。

WingHarness 必须已经运行。扩展没有用于拉起应用的自定义 URL scheme 或
deep link。应用不可达时，提示框可以等待你手动启动；拒绝等待则由浏览器继续
下载。

## 配对

1. 启动 WingHarness，打开「下载 → 设置 → 浏览器集成」。
2. 启用浏览器集成，记录端口（默认 `47653`）并复制访问令牌。令牌由应用生成
   并保存，扩展不会自行生成。
3. 点击扩展工具栏图标打开选项页，粘贴令牌并填写相同端口。
4. 点击 **Test connection**，成功时会显示 WingHarness 版本。

修改应用内开关或端口后需要重启应用。重新生成令牌会立即生效并使旧令牌失效，
同时必须把新值复制到扩展选项页。

## 在 Chrome、Edge 或 Brave 中加载

1. 打开 `chrome://extensions`、`edge://extensions` 或 `brave://extensions`。
2. 开启 **Developer mode**。
3. 选择 **Load unpacked**，选中仓库的 `extension/` 目录。其中
   `manifest.json` 是使用 service worker 的 Chromium MV3 清单。

这条路径不需要编译。

## 在 Firefox 中加载

Firefox 使用 background scripts，而不是 Chromium 的 service worker。在
`extension/` 目录运行：

```bash
node build.mjs
```

然后打开 `about:debugging#/runtime/this-firefox`，选择 **Load Temporary
Add-on…**，选中 `dist/firefox/manifest.json`。如果 Firefox 请求主机访问权限，
请允许。临时扩展会在 Firefox 重启后移除，需要重新加载。

同一命令还会生成 `dist/chrome` 和带版本号的 Chrome/Firefox zip 文件。它只负责
打包扩展，不参与应用的 `pnpm build`。

## 权限说明

| 权限                                | 用途                                                   |
| ----------------------------------- | ------------------------------------------------------ |
| `downloads`                         | 检测并暂停浏览器下载，用于兜底捕获。                   |
| `contextMenus`                      | 在支持的页面元素上添加 **Download with WingHarness**。 |
| `cookies` 与主机访问                | 只读取所提交下载 URL 的 Cookie，并连接 `127.0.0.1`。   |
| `notifications`                     | 显示成功与错误反馈。                                   |
| `tabs`                              | 读取来源页 URL，并显示启动应用提示。                   |
| `storage`                           | 把端口、令牌和捕获偏好保存到浏览器的本地扩展存储。     |
| `webRequest` / `webRequestBlocking` | 仅 Firefox：在服务器驱动附件的保存对话框出现前拦截。   |

扩展只运行随包代码，不下载或执行远程代码。

## 隐私与本地数据

扩展没有分析、跟踪、远程服务或开发者端点。提交的 URL、文件名、Cookie、
Referer 和 User-Agent 只发送到用户本机的 `http://127.0.0.1:<port>`，扩展不会
把它们发送给第三方。

令牌和捕获偏好保存在浏览器扩展存储中。提交后，WingHarness 可能把请求头保存到
`<data dir>/moin/downloads.db`，应用自己的 RPC 令牌保存在
`<data dir>/moin/settings.json`。两处都应按敏感数据保护，见
[MOIN.zh-CN.md](./MOIN.zh-CN.md#数据目录与敏感信息)。

## RPC 契约

- `GET /ping` 不需要令牌，返回 `{ "app": "wingharness", "version": "…" }`。
- `POST /add` 需要 `Authorization: Bearer <token>`，JSON 请求体示例为
  `{ "url": "https://…", "headers": { "Cookie": "…", "Referer": "…", "User-Agent": "…" }, "filename": "…" }`。
  成功时返回新建任务，失败时返回非 2xx 与 `{ "error": "…" }`。

连接测试会故意向 `/add` 发送 `{}`：`401` 表示令牌错误；因缺少 URL 而返回
`400` 则证明应用可达且令牌已通过验证。

## 故障排查

| 现象                      | 处理方法                                                                                                                                                                   |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 无法连接 WingHarness      | 启动应用、启用浏览器集成并确保端口一致；修改应用开关或端口后重启。                                                                                                         |
| 测试返回 401              | 从应用复制当前令牌并粘贴到扩展；修改令牌不需要重启应用。                                                                                                                   |
| 端口被占用                | 在应用中选择其他端口并重启，再在扩展中填写相同端口。绑定失败不会使 WingHarness 崩溃。                                                                                      |
| Chromium 仍弹出保存对话框 | 对链接点击启用自动捕获。对服务器驱动的附件，关闭 **Ask where to save each file before downloading**，或接受兜底行为。                                                      |
| 右键没有反应              | 检查扩展捕获开关，并使用 HTTP/HTTPS 直链。浏览器内部、`blob:` 与 `data:` URL 不受支持。                                                                                    |
| 下载页没有任务            | 先检查应用任务列表，再查看扩展后台控制台。Chromium 为 **Inspect views: service worker**，Firefox 在 `about:debugging` 下选择 **Inspect**。扩展日志前缀为 `[wingharness]`。 |
| Firefox 重启后扩展消失    | 这是临时扩展的预期行为，重新加载 `dist/firefox/manifest.json`。                                                                                                            |

## 源码布局

```
extension/
  manifest.json            Chrome/Edge/Brave MV3, service worker
  manifest.firefox.json    Firefox MV3, background scripts
  build.mjs                Build dist/chrome and dist/firefox, then zip them
  icons/                   SVG source and 32/48/128 PNG icons
  src/
    shared.js              Options, RPC client and cookie header
    content.js             Click interception and in-page app-start prompt
    background.js          Menus, capture paths, notifications and retry prompt
    prompt.html/.js        Popup prompt for restricted pages
    options.html/.js/.css  Pairing and capture preferences
```

## 归属

改编自 [moin](https://github.com/exxvius/moin) 0.4.0、提交 `79e7587`（MIT）。
`/ping` 与 `/add` 契约保持兼容。WingHarness 修改了品牌，默认浏览器集成端口为
`47653`，并把 `moin://` 自动拉起替换为明确的启动应用提示。
