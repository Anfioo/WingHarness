# 托盘菜单

**托盘菜单**tab 决定系统托盘的二级菜单里出现哪些软件：也就是托盘弹窗里**应用**那一行打开的列表。Scoop 会为每个带快捷方式的已装应用在开始菜单里建一个快捷方式，而快捷方式本身已经带着目标、参数、工作目录和图标——所以这个 tab 直接列出这些快捷方式，在托盘里点一下就交给 shell 打开。

它属于 Scoop 页（`/scoop?tab=tray`），Scoop 安装完成后才出现，因为它整理的就是 Scoop 的开始菜单目录。托盘弹窗本身是一个独立的无边框窗口（`tray-menu`），见 [src-tauri/CLAUDE.md](../../src-tauri/CLAUDE.md)。

只做 Windows。托盘弹窗、它的二级面板和这个 tab 都是托盘在 Windows 上的形态；macOS 与 Linux 保留原生菜单，不带应用列表。

## 托盘弹窗

弹窗的行与高度计算在 `src-tauri/src/plugins/tray_popup.rs`，内容在 `src/windows/tray-menu/index.tsx`。两处必须一起改，因为窗口尺寸是算出来的，不是量出来的：

| 部分 | 高度 |
| --- | --- |
| 每个菜单项 | `32px`（`h-8`） |
| 上下内边距 | 上 `4px` + 下 `4px`（`p-1`） |
| 退出前的分隔线 | `9px`（`my-1 h-px`） |
| 菜单项数量 | `tray_popup.rs` 里的 `MENU_ITEM_COUNT` |

显示窗口 / 设置 / 空格预览 / 打开文件 / **应用** / Clash / FRP / **后台持续监听** / 退出，一共九项，所以收起状态的弹窗高度是 305px。加一行只需要改这个常量、`h-[305px]` 这个类，别的都不用动。后台持续监听这一行切换任务管理器的 `backgroundMonitoring` 设置，见 [TASK_MANAGER.zh-CN.md](./TASK_MANAGER.zh-CN.md#托盘行)。

二级面板（Clash、FRP，以及应用这个二级菜单）把窗口换成 340 × 460，并让它往侧面长：默认在菜单栏左侧，图标贴着屏幕左边缘时翻到右侧。`tray_menu_set_expanded` 负责这次改尺寸，并回报它最后站在哪一侧。

## 应用列表

`commands/tray_apps.rs` 读 `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Scoop Apps\*.lnk`，
以及往下的一层子目录——Scoop 会给有多个快捷方式的应用建一个同名文件夹（`7-Zip\7-Zip File Manager.lnk`）：

- **id** 是文件名主干，比较时转小写，存放时保持原样
- **显示名**是把主干里的 `_` 换成空格——Scoop 给显示名带空格的应用起的快捷方式文件名就是这样
- **路径**就是那个 `.lnk`，不解析它

启动用的就是 `open_path`，每个窗口都已经有的 shell 打开命令：`cmd /C start "" "<路径>"`。快捷方式自带工作目录和参数，所以应用启动起来跟从开始菜单点完全一样。没有单独的启动通道，也没有引入 `lnk` 依赖。

没有开始菜单快捷方式的已装应用（多为命令行工具，Scoop 给的是 shim）不会出现在列表里——托盘菜单没有可显示的东西去启动它。tab 会说明这一点，并写出它读的是哪个目录，所以列表为空时不会显得莫名其妙。

图标来自 `sp_file_icon`（由 shell 读出这个 `.lnk` 的图标），走 `src/lib/space-preview/bridge.ts` 里的 `systemFileIcon`。没有图标的快捷方式退化成按 id 生成颜色的首字母方块，保证每行都对齐。

## 挑选与排序

三份 id 列表，都在 `<数据目录>/tray.json`：

```json
{ "pinned": ["Everything"], "hidden": ["7zip"], "order": ["Everything", "Notepad++", "7zip"] }
```

- **置顶**的应用画在分隔线以上；**隐藏**的应用不出现在菜单里，但仍留在设置列表里
- **order** 是用户拖动出来的菜单顺序；两个分区内部都按它排。不在 `order` 里的 id 排在已排好的之后，按显示名排序，所以新装的应用落在分区末尾，不会打乱已有顺序
- 拖动一行即可调整顺序；列表是 dnd-kit sortable，拖动时其它行会让出位置，直接显示它会落在哪里。拖过分隔线会把被拖的应用置顶或取消置顶，这也正是那条分隔线的含义。置顶按钮是把它直接放到最前的快捷方式。搜索框有内容时不能拖动，因为筛选后的顺序不是保存的顺序
- `tray_apps_save` 整体替换这三份列表并做归一化（去空白、去重、保持顺序）；目录里已经不存在的 id 会保留，这样卸载再装回来的应用还在用户原来放的位置

托盘每次弹出都重新读这个文件，所以一次改动不需要通知托盘：没有要重启的东西，也没有要重建的东西。设置 tab 每次开关或拖动就保存，写失败时把之前的列表放回去。

## 文件

| 路径 | 职责 |
| --- | --- |
| `src-tauri/src/commands/tray_apps.rs` | 快捷方式扫描、排序、`tray.json`，以及两个命令 |
| `src-tauri/src/plugins/tray_popup.rs` | 弹窗几何、定位、失焦关闭 |
| `src/windows/tray-menu/index.tsx` | 菜单行与二级面板的挂接 |
| `src/windows/tray-menu/apps-panel.tsx` | 应用二级面板 |
| `src/pages/scoop/index.tsx` | 宿主页：tab、`?tab=` 深链与选中 tab 的事件 |
| `src/components/scoop/tray-panel.tsx` | Scoop 的 tab：列表、拖动排序、置顶、隐藏、预览 |
| `src/hooks/use-tray-apps-page.ts` | tab 状态、乐观保存、筛选 |
| `src/components/tray-apps/` | 共用的应用图标、应用行与菜单预览 |
| `src/commands/services/tray/` | 托盘命令的类型化封装与 DTO |
| `src/lib/scoop-tabs.ts` | tab 名称，以及选中 tab 的事件 |

## 命令

| 命令 | 用途 |
| --- | --- |
| `tray_apps_list` | 按菜单顺序排好的应用、三份列表，以及它们读自哪个目录 |
| `tray_apps_save` | 替换置顶、隐藏与顺序三份列表 |

这个 tab 可以从托盘本身进入：二级面板里的**编辑托盘菜单…**会先收起弹窗，再显示主窗口，并发出定址到 `main` 的 `app:navigate`（`/scoop?tab=tray`），路由把它当成一次普通导航。随后还会发出 `scoop-select-tab`，因为导航到当前已经所在的 URL 按设计是空操作——没有这个事件，点过别的 tab 再回来时仍会停在那个 tab。主窗口关闭时是隐藏而不是销毁，所以它的路由还在，能收到这两条消息。
