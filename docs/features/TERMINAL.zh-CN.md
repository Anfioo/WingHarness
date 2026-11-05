# 终端

**终端**页面是 webview 中的真实伪控制台。它位于侧边栏的「高级生态」分组，
是应用中唯一提供原始 shell 的地方——Git 仓库窗口有自己的终端，用于在差异
旁边运行命令，但本页面是独立的那一个。

终端是一方实现：前端用 xterm，Rust 侧用 `portable-pty`。没有需要署名的
上游项目，也没有安装 shell 集成——拿到的提示符就是 shell 本身打印的那个。

## 工作原理

```
TerminalTab ── invoke ──▶ local_shell_start { cols, rows } ──▶ "local-1"
   xterm onData   ──▶ local_shell_write { sessionId, text }        (UTF-8, not base64)
   xterm onResize ──▶ local_shell_resize { sessionId, cols, rows }

event "local-shell-output" { sessionId, data: base64 } ──▶ xterm.write(bytes)
event "local-shell-exit"   { sessionId, code: number | null }

tab closed / page unmounts ──▶ local_shell_kill { sessionId }
```

- **会话**存在于 Rust 进程中的 `OnceLock<Mutex<HashMap<String, PtySession>>>`。
  Id 由 `AtomicU64` 生成，形如 `local-<n>`，在一次运行内稳定，跨运行无意义。
- **启动**以 xterm 网格报告的尺寸，通过 `NativePtySystem::openpty` 打开
  pty。Windows 上 `portable-pty` 使用 ConPTY。shell 在 Windows 上是
  `COMSPEC` 或 `cmd.exe`，其他平台是 `$SHELL` 或 `/bin/sh`，以**无参数、
  不覆盖工作目录、不修改环境**的方式启动——子进程继承应用进程的一切。
- **输出**由每个会话一个线程以 8 KiB 块读取，每次读取成为一个
  `local-shell-output` 事件，使用标准（无填充）base64。没有合并、没有确认、
  没有背压：打印很多的命令会产生很多事件。短暂的读取错误在 10 ms 后重试；
  只有连续 100 次错误或干净的 EOF 才停止泵。
- **退出**在 `child.wait()` 之后发出，因此 `code` 是真实退出状态。输出可能
  在最后一个 `local-shell-output` 之后、`local-shell-exit` 之前到达；标签页
  把退出视为最终状态。
- **终止**移除会话、杀死子进程并回收。关闭标签页与离开页面都走这条路径，
  因此没有 shell 会活过它的标签页。

## 页面

顶部是标签页，每个标签页一个终端。标签页形如 `tab-<timestamp>-<seq>`，只
存在于内存中。所有窗格保持挂载并隐藏，而不是卸载，因为 xterm 实例无法在
缓冲区完好无损的情况下经受重新挂载——代价是隐藏窗格尺寸为零，xterm 宿主
通过在其 `clientWidth` 或 `clientHeight` 为零时忽略尺寸变化观察来容忍这一点。

启动代计数器防止被取代的挂载启动第二个 shell，这也覆盖了 React 开发模式的
双重挂载。

## 命令与事件

| 命令 | 参数 | 返回 |
| --- | --- | --- |
| `local_shell_start` | `cols`、`rows` | 会话 id |
| `local_shell_write` | `sessionId`、`data`（UTF-8 文本） | — |
| `local_shell_resize` | `sessionId`、`cols`、`rows` | — |
| `local_shell_kill` | `sessionId` | — |
| `local_shell_list_fonts` | — | 已安装的字体族名称 |

| 事件 | 载荷 |
| --- | --- |
| `local-shell-output` | `{ sessionId, data }`，base64 |
| `local-shell-exit` | `{ sessionId, code }`，`code` 未知时为 null |

`local_shell_list_fonts` 通过 `font-kit` 为设置中的字体选择器提供数据，因此
终端与编辑器提供相同的字体列表。

## 偏好

终端偏好是一个 `localStorage` 键 `local-terminal-prefs`，在「设置 → 终端」
中编辑：

| 键 | 默认值 |
| --- | --- |
| `fontFamily` | `Consolas` |
| `fontSize` | 14 |
| `tabStopWidth` | 4 |
| `autoWrap` | 开 |
| `highlightCurrentLine` | 开 |

它们放在 `localStorage` 而不是数据目录是有意为之：它们是视图状态而非功能
数据；页面响应跨窗口的 `storage` 事件，因此设置中的修改无需重新加载即可
生效。自动换行通过发送 xterm 的 DECAWM 序列实现，因此关闭了换行的 shell
不会被覆盖。

## 主题

终端没有自己的调色板。`terminalThemeFromTokens()` 读取应用的 CSS 自定义
属性（`--card`、`--foreground`、`--primary`、`--muted-foreground`、
`--accent`、`--destructive`、`--success`、`--info`，以及图颜色）并据此构建
xterm 主题，接受 `hsl` 三元组、`oklch` 和 hex。`<html>` 类上的
`MutationObserver` 会重新推导主题，因此切换明/暗会立即为打开的终端重新
着色。存在硬编码回退，用于 token 无法解析的情况。

## 限制

- **什么都不持久化。** 标签页、回滚、布局与运行中的 shell 随页面消亡。没有
  会话恢复。
- **Windows 上只有 `cmd.exe`。** 没有 PowerShell、没有 WSL、没有配置文件、
  没有工作目录选择、没有 shell 参数。
- **没有流控。** 大量输出会淹没事件总线，而不是被限流；回滚是 xterm 的
  5 000 行，这限制了内存，但不限制事件速率。
- **没有最大标签数**，也没有分割窗格。
- stdout 与 stderr 被 pty 合并，因此终端无法区分二者——真实控制台也是如此。

## 将本模块接入其他应用

1. 将 `portable-pty`、`base64` 与 `font-kit` 加入 `src-tauri/Cargo.toml`。
2. 通过 `invoke.rs`、`build.rs` 与 `capabilities/default.json` 注册五个
   `local_shell_*` 命令。
3. 前端需要 `src/components/terminal/xterm-host.tsx`（`@xterm/xterm` +
   `@xterm/addon-fit`）、`src/lib/terminal/theme.ts` 以及页面本身。
4. Windows 不需要额外依赖——ConPTY 随系统提供——但应用不得以早于
   10 1809 的 Windows 版本为目标构建。

## 常见问题

| 现象 | 可能原因 |
| --- | --- |
| 标签页空白，没有提示符 | `local_shell_start` 失败，或 `COMSPEC` 中的 shell 不存在 |
| 有输出但按键无反应 | 写调用中的会话 id 不再对应活动会话 |
| 文本显示为乱码 | shell 写出了非 UTF-8 代码页（`chcp 65001` 可修复） |
| 命令运行时窗口卡死 | 命令正在打印数兆字节——没有限流 |
| 关闭标签页后留下孤儿进程 | 子进程忽略了终止，或在 `local_shell_kill` 执行前应用被结束 |
| 字体列表为空 | `font-kit` 未找到系统字体；选择器回退到 `Consolas` |
| 主题切换后颜色不对 | 主题 token 是不受支持的颜色形式，使用了回退调色板 |
