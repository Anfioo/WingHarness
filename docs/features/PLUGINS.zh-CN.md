# 插件

> English version: [PLUGINS.md](./PLUGINS.md)

插件就是一个普通的 **Scoop 应用**，根目录带一份 `plugin.json`。安装、更新、卸载这条生命周期由 Scoop 从桶里完成；应用补上 Scoop 没有意见的那部分：设置页读清单，按清单渲染配置，再跑脚本。

应用本身不认识任何具体插件——**装新插件不需要改前端、也不需要改 Rust**，只要桶里多一份清单。

## 1. 包结构与桶

应用就是 zip 里面的内容，`plugin.json` 在根目录：

```
hello-plugin.zip
├── plugin.json
├── run.cmd
└── （其余文件随意）
```

`scoop install hello-plugin` 会把它解到 `<scoop>/apps/hello-plugin/<版本>/`，并让 `<scoop>/apps/hello-plugin/current` 指向那一层。应用只看 `current`，所以如果压缩包外面还套了一层目录，就在桶清单里用 `extract_dir` 指出来。

桶清单**只用 Scoop 的标准字段**——插件自己的元数据留在包内，由应用去读：

```json
{
  "version": "1.0.0",
  "description": "Hello plugin: prints the values its config files hold.",
  "homepage": "https://github.com/you/scoop-bucket",
  "url": "https://github.com/you/scoop-bucket/releases/download/hello-plugin-1.0.0/hello-plugin-1.0.0.zip",
  "hash": "sha256:…"
}
```

[`examples/bucket/`](../../examples/bucket/) 里有两份可直接改的清单。复制一份到你桶里其他清单旁边，把 `url` 指到 release 的 zip，`hash` 用 `scoop hash <文件>` 填（或者像别的应用一样交给 `scoop checkver` / `autoupdate` 维护）。

这两份清单还演示了插件清单在标准字段之外通常要的那一样东西：包里的配置文件是**模板**，`pre_install` 在首次安装时把它们复制到 `$persist_dir`，这样插件第一次运行就能在应用会去找的地方读到配置（第 6 节）。少了它，文件会留在 `current` 里——那个目录下次更新就被替换，配置窗口也不会去读它。

```json
"pre_install": [
  "New-Item -ItemType Directory -Force -Path $persist_dir | Out-Null",
  "$files = @('.env', 'cfg.json')",
  "foreach ($name in $files) {",
  "  $source = Join-Path $dir $name;",
  "  $target = Join-Path $persist_dir $name;",
  "  if ((Test-Path $source) -and -not (Test-Path $target)) { Copy-Item $source $target }",
  "}"
]
```

## 2. plugin.json

```jsonc
{
  "name": "示例插件",           // 显示名，留空则用应用名
  "version": "1.0.0",          // 可选，显示在名字旁边的徽章里
  "description": "一句话说明",   // 可选
  "entry": "run.cmd",          // 必填。启动插件用的脚本，相对插件根目录且必须落在插件目录内
  "stopScript": "stop.cmd",    // 可选。停止插件用的脚本，见第 5a 节
  "ui": "http://127.0.0.1:{PORT}/", // 可选。插件自己提供的页面地址，见第 4 节
  "configFiles": [ /* 配置源，见下 */ ]
}
```

> 注意上面是 **jsonc** 写法，加注释只是为了讲解；真正写 `plugin.json` 时不能带注释。

这里没有 `id`。**插件的身份就是它的 Scoop 应用名**，它同时是目录名，也是应用记录启用状态时用的键，所以两者不可能对不上。旧版本留下的、仍带 `id` 的 `plugin.json` 照常能读——那个键会被忽略，不算错误。

`ui` 是插件自己提供的页面地址。里面的 `{key}` 表示某个配置键的当前值，所以「端口是一项配置」的插件也能指向自己的页面。只接受 `http://` 与 `https://`。不写 `ui` 很正常：这个插件就是没有自己的页面。见第 4 节。

### 配置文件

插件把配置**当成真实文件**来带，并在 `configFiles` 里声明它们。每一项是一个**配置源**：磁盘上的一个文件，对应配置窗口里的一块。

| 字段 | 含义 |
| --- | --- |
| `type` | `env`、`json` 或 `yaml`——由哪个适配器读写这个文件 |
| `path` | 相对**持久化目录** `<scoop>/persist/<app>`，不是插件目录，见第 6 节。安全检查与 `entry` 相同，`..` 和绝对路径都走不出去 |
| `absolute` | 可选。`true` 表示 `path` 按原样使用，用于插件放在自己数据之外的文件（应用不会创建它） |
| `startmust` | 布尔。`true` 表示文件缺失时拒绝运行 |
| `fields` | 应用可编辑的键，按声明顺序排列 |

`fields[]` 与原来的 `config` 字段形状完全一致，渲染逻辑没变：

| 字段 | 含义 |
| --- | --- |
| `key` | 必填。**它指什么取决于 `type`**——见下 |
| `label` | 输入框上方的标签；留空则用 `key` |
| `type` | `string`（默认）、`number`、`boolean`、`select` 或 `textarea` |
| `default` | 文件里还没有值时的取值——**插件就是在这里给出默认值** |
| `hint` | 可选，标签下方的小字说明 |
| `options` | 字段的可选值，形如 `{ value, label }` 的对象数组——见下 |
| `trueValue` | 仅用于带 options 的 `boolean`：哪个选项的 `value` 代表「开」 |
| `min` / `max` | 仅用于 `number` |

渲染方式：`string` → 单行输入框，`number` → 数字输入框，`boolean` → 开关按钮，`select` → 下拉框，`textarea` → 多行输入框。

#### `options` 与 `trueValue`——选项字段

`options` 把字段的可选值固定成一个对象数组，每个对象一个 `value`（文件里存的）与一个 `label`（界面上显示的，留空则退回 `value`）：

```json
"options": [
  { "value": "blue", "label": "蓝" },
  { "value": "green", "label": "绿" }
]
```

只允许用在 `select` 和 `boolean` 上；用在别的类型上会被静默忽略，所以带着它的清单会被拒绝。不在列表里的值保存时会被拒绝。

**`select`——N 选一的下拉框。** 这就是 `options` 一直以来的含义；条目数量不限。不带 `options` 的 `select` 就是自由文本输入框。

**`boolean`——两态开关。** 带 options 时，它必须**正好两个**（多一个会被拒绝：两态开关没有地方渲染第三种），并且必须有一个 **`trueValue`** 指出哪个代表「开」——它的值必须与某个选项一致，缺了它，带 options 的 boolean 就是错误。按钮显示当前状态的 `label`，处于 `trueValue` 时按钮填充，写回文件的是那个选项的 `value`；所以一个把状态写成 `1`/`0` 的文件会原样保留 `1`/`0`，而不是被换成翻译过的 bool。

```json
{
  "key": "SYSTEM_PROXY", "type": "boolean", "default": "1", "trueValue": "1",
  "options": [ { "value": "1", "label": "开启" }, { "value": "0", "label": "关闭" } ]
}
```

其他类型一律禁止 `trueValue`（在那里没有意义，写上去就是值得抓出来的笔误）。**不带** `options` 的 `boolean` 就是普通的开关按钮，在 json/yaml 里存真正的布尔值（`.env` 里存 `true`/`false`）。

选项字段没写 `default` 时：`boolean` 落到**不是** `trueValue` 的那个状态（开关总得是其中一种），而 `select` 视为未设置，显示下拉框的占位符。

**`key` 的寻址方式：**

- `env`——**扁平键**。`WEB_PORT` 匹配 `WEB_PORT=` 那一行；名字里的点是字面意义的点，不是路径。
- `json` / `yaml`——**点路径**，`a.b.c`。纯数字的一段是数组下标：`schedule.checkin_hours.0` 是第一个元素。

`configFiles` 里 `fields` 为空数组是合法的，只是没有什么可编辑的。完全没有 `configFiles` 的插件没有配置项，它的页面（如果有）照常工作。

#### 一份完整清单

把所有键放进一块，复制之后删掉不需要的即可。下面声明了一个 `env` 文件和一个 `json` 文件，覆盖五种字段类型、一个 `select`，以及一个 `boolean` 开关：

```json
{
  "name": "My Plugin",
  "version": "1.0.0",
  "description": "One line shown on the settings card.",
  "entry": "run.cmd",
  "stopScript": "stop.cmd",
  "ui": "http://127.0.0.1:{MY_PORT}/",
  "configFiles": [
    {
      "type": "env",
      "path": ".env",
      "startmust": true,
      "fields": [
        { "key": "MY_HOST", "label": "Listen address", "type": "string", "default": "127.0.0.1" },
        { "key": "MY_PORT", "label": "Port", "type": "number", "default": 8080, "min": 1024, "max": 65535 },
        { "key": "MY_THEME", "label": "Color scheme", "type": "select", "default": "auto",
          "options": [ { "value": "auto", "label": "Auto" },
                       { "value": "light", "label": "Light" },
                       { "value": "dark", "label": "Dark" } ] },
        { "key": "MY_PROXY", "label": "System proxy", "type": "boolean", "default": "0",
          "trueValue": "1",
          "options": [ { "value": "1", "label": "On" }, { "value": "0", "label": "Off" } ] }
      ]
    },
    {
      "type": "json",
      "path": "cfg.json",
      "fields": [
        { "key": "app.accent", "label": "Accent", "type": "select", "default": "blue",
          "options": [{ "value": "blue", "label": "Blue" }, { "value": "green", "label": "Green" }] },
        { "key": "app.note", "label": "Note", "type": "textarea", "default": "" },
        { "key": "app.retries", "label": "Retries", "type": "number", "default": 3 },
        { "key": "features.enabled", "label": "Enable feature", "type": "boolean", "default": true },
        { "key": "features.weights.0", "label": "First weight", "type": "number", "default": 100 }
      ]
    }
  ]
}
```

同样的内容、带完整注释、旁边还有能跑的脚本，就在 [`examples/plugin-showcase/`](../../examples/plugin-showcase/)。

## 3. 安装、更新、卸载、运行

设置页驱动 Scoop，而不重新实现它。

1. **安装**——点 **Install plugin**，填应用名。这个应用必须来自你已经在 **Scoop** 页添加过的桶。应用会执行 `scoop install <app>`，把 Scoop 的输出实时显示在面板里，插件装好后是**停用**状态。
2. **启用**——在 设置 → 插件 里，把「已停用」按钮点成「已启用」。
3. **配置**——点卡片上的「配置」，打开配置窗口（第 4a 节）。
4. **运行**——点插件的「运行」，或点顶部的「运行全部」按顺序跑所有已启用的插件。输出实时进入下面的面板。
5. **更新**——卡片上的 **更新** 按钮执行 `scoop update <app>`，输出同样进面板。
6. **卸载**——垃圾桶图标执行 `scoop uninstall <app>`。插件的**配置会保留**：它们在持久化目录里，Scoop 卸载时不动它（第 6 节）。

为什么填应用名而不是拖一个文件：拖 zip 安装意味着这一整步得由应用自己负责——解压、判断落在哪、再记一笔。这些事 Scoop 对机器上每个应用都已经做了，所以插件不过是「带了 `plugin.json` 的那个应用」。

其余控件：「打开插件目录」在资源管理器里打开 `<scoop>/apps`，卡片上的目录图标打开该插件的 `current` 目录，文件图标打开它的运行日志（第 5b 节）。

清单读不出来的插件也会列出来，原因写在卡片上，所以失败是看得见的，而不是插件悄悄消失。

**旧 zip 安装器留下的副本**同样会列出，标着「由旧版 zip 安装器安装」。它们不会被迁移——Scoop 从没装过它们，`scoop update` 和 `scoop uninstall` 都会失败。先从桶里装好应用，再点旧卡片的垃圾桶图标删掉残留目录。

## 4. 插件页面

插件如果自己提供网页，可以用 `ui` 声明，应用会把这个页面嵌进侧栏的**插件**区——不用浏览器，也不用切窗口。

对每个已启用且声明了 `ui` 的插件，页面会：

- **每个插件一个标签页。** 只有已启用且声明了 `ui` 的插件才有标签页，打开时选中第一个。没有 `ui` 的插件一个页都不占，所以一批纯脚本插件不会把界面堆满。
- **不会自己启动。** 打开标签页不会启动任何东西：按 **Start**，面板会等到那个地址有人应答之后再显示页面。启动插件服务器、占住它的端口，是用户自己的决定，不是看一眼标签页的副作用。
- **「在运行」意味着页面能应答**，而不是「应用启动过它」。一个由本应用之外启动的实例（上一次运行留下的，或者手动起的）在应用看来同样是运行中，面板会显示它实时页面，而不是声称它已停止。所以关掉再打开应用，也不会让正在运行的插件看起来像停了：不需要记住任何东西，直接问地址就行。同理，页面还活着的时候不会按 Start，也就不会起第二份去撞已经占用的端口。
- **打开之后页面一直活着。** 切换标签页不会重新加载，页面上的东西都留着。
- **启动和停止是同一个按钮。** 插件没起来时工具栏显示 **Start**，起来之后显示 **Stop**；再按一次就停止插件——有 `stopScript` 就执行它，否则杀掉应用启动的进程树（见第 5a 节）。关闭应用会停掉它启动过的所有插件，不会有插件服务器继续占着端口。
- **两处读的是同一份真相。** 设置卡片的「运行 / 停止」与面板的「Start / Stop」都来自同一个可达性检查，所以在一处启动，另一处就显示运行中；在那里停止，这边也会跟着变。设置卡片上的「运行」把插件输出实时放进下面的面板；一个提供页面的插件会一直输出到它退出为止，所以**这段输出不决定**卡片是否繁忙。别的卡片上的插件启动、退出，都不会把这个卡片锁住。

如果 `{key}` 没有被任何配置字段填上，插件就是没有页面，而不是得到一个坏地址；它在设置页的卡片会说清楚缺的是哪个键。

页面用**原生 webview** 显示，不是 `<iframe>`。这不是偏好问题——这是唯一可行的做法。几乎所有真实的 Web 应用都会发 `X-Frame-Options: DENY` 和 CSP 的 `frame-ancestors 'none'` 来防点击劫持（参考插件就是这样），浏览器根本不会在框里渲染这种页面。iframe 还是跨源的，应用永远读不到它的地址，也没有地址栏和前进后退。

所以带 `ui` 的插件会拿到一个自己的 webview，上方是一条小浏览器栏：**后退 / 前进 / 刷新 / 可编辑的地址栏 / 用系统浏览器打开**，另外在开发构建里还有**开发者工具**按钮。地址栏跟着页面走——包括前端路由的路径变化，所以在 SPA 里也一直是对的。

浏览器的检查器是唯一能看进这个页面的窗口：页面是原生视图，它的 cookie、local storage、session storage、IndexedDB 只有通过浏览器运行时的 *Application* 面板才看得到。所以那个按钮在 release 构建里默认不在，除非打包时带 `BUILD_DEV=1`（`scripts/build.ps1 -DevBuild`），也就是打开 `devtools` 特性。

两个值得知道的后果：

- 页面是画在应用上面的一层操作系统级视图。它所在的标签页没被选中时会被隐藏，离开插件页时会被关闭，所以它不会留在别的界面上。
- 插件页面加载什么仍然是它自己的事——但地址栏只接受插件自己源上的地址，应用也一样。插件没法借它摸到应用本身。

### 4a. 配置窗口

卡片本身不放字段。它的**配置**按钮打开一个独立窗口，**每个配置源一块**，各自显示 `type`、`path`（相对持久化目录）、`startmust` 时的「启动必需」徽章，以及一个交给系统打开的「打开文件」按钮。

- 改一个字段就**直接写进那个文件**。应用里什么都不缓存：文件就是真相，所以在文本编辑器里改的东西下次打开就能看到，两边永远不会不一致。
- 只动声明过的键。在 `.env` 里，注释行、空行、其他键、行尾的 ` # 注释` 以及文件自己的换行风格都逐字节保留。
- 还不存在的文件显示「文件尚未落盘」；保存任一字段会**创建**它，其他键用声明的默认值。插件首次启动才生成自己的 `.env` 时，在那之前照样有可编辑的设置，就是靠这个。
- 保存是自动的，停止输入一小会后触发，失败会弹提示。超出 `min`/`max` 的值、不在 `select` 列表里的值、解析不了的数字都会被拒绝并报告——文件不动。
- `json` 和 `yaml` 是整份重写，所以原文件里特殊的格式（缩进，以及 **yaml 里的注释**）不会保留。JSON 本来没有注释，`.env` 则全部保留。

## 5. 脚本怎么拿到配置

**什么都不注入。** 应用只设三个变量：

| 变量 | 值 |
| --- | --- |
| `PLUGIN_ID` | 插件的 id——也就是它的 Scoop 应用名 |
| `PLUGIN_DIR` | 插件在磁盘上的 `current` 目录 |
| `PLUGIN_PERSIST` | 插件的持久化目录 `<scoop>/persist/<app>` |

其余全是脚本自己从 `%PLUGIN_PERSIST%` 读的文件。那就是配置窗口编辑的同一个文件，所以用户看到的就是脚本拿到的——没有合并步骤，没有 `.runtime/config.json`，也没有 `PLUGIN_<KEY>` 这类变量。

要避开的坑是只读 `%PLUGIN_DIR%`：那个目录下次 `scoop update` 会被整份替换，用户写进去的东西就没了。Scoop 会留下的是持久化目录。

```bat
@echo off
rem A .cmd script has no env/JSON/yaml parser, so it reads what it needs.
rem `chcp 65001` is not optional: cmd reads the file in the console code page
rem (GBK on a Chinese Windows) while the config window writes UTF-8, and a
rem non-ASCII comment would otherwise swallow the newline after it and glue the
rem next key onto the comment. `eol=#` skips the comments.
chcp 65001 >nul
for /f "usebackq eol=# tokens=1,* delims==" %%a in ("%PLUGIN_PERSIST%\.env") do (
  if /i "%%a"=="GREETING" set "GREETING=%%b"
)
echo Greeting is %GREETING%
```

想要更丰富的读取方式，脚本可以自己解析 `cfg.json`（Python 的 `json`、PowerShell 的 `ConvertFrom-Json`、`jq`……）。应用不规定插件怎么读自己的文件——那是插件自己的事。

工作目录是插件的 `current` 目录，所以脚本里指向自身资源的相对路径直接可用。stdin 接的是空设备，脚本不会卡在等待输入上。退出码显示在设置页；非零会在「运行全部」的汇总里算作失败，但**不会中断后面的插件**。

运行之前，每个 `startmust: true` 的源都必须在**持久化目录**里存在。缺一个就拒绝运行，错误里带着文件名：这是插件在告诉用户，它需要一个用户还没创建的文件。`startmust: false` 的源不管——首次启动时生成自己的配置是正常做法，不是错误。

### 5a. 启动与停止

各处都是同一个启动/停止按钮，清单里把两半都点明了：`entry` 启动插件，`stopScript` 停止它。

**插件声明了 `stopScript`，停止就完全交给它。** 应用执行它，别的什么都不做。它和 `entry` 一样，以插件的 `current` 目录为工作目录运行，带 `PLUGIN_ID` / `PLUGIN_DIR` / `PLUGIN_PERSIST`，输出进同一份运行日志。它有 60 秒；超时还在跑的会被杀掉，停止操作报告为失败。

有停止脚本时，应用**故意不**再顺手杀进程树。那个脚本是插件自己的收尾——它知道要结束什么，包括应用根本看不到的守护进程——在背后再叠一套粗糙的机制，只会把收尾砍断。

**没有 `stopScript` 时，应用杀掉自己启动的那棵进程树。** 这已经是结束这类插件的全部手段，也覆盖了「脚本把所有东西都放在自己进程里」这个常见情形。

不论哪种，界面上最终显示的是页面还能不能应答（第 4 节）：没停干净的会继续显示为运行中，而不会被报告成成功。

这两半对 `workbuddy-manager` 这种包是必须的：它的 `start-all.cmd` 除了面板还会拉起一个上游守护进程。`entry` 是 `start-all.cmd`，`stopScript` 是 `stop-all.cmd`，后者按端口找到面板，再把上游停掉。

**停止脚本在应用没有启动过这个插件时也会执行。** 既然「运行中」由地址是否应答决定，Stop 就必须能结束一个进程表完全不知道的实例——而声明过的停止脚本是唯一能做到的东西。这正是「某个旧副本还占着 7864 端口」的情形：按 Stop，脚本把它结束掉，至于脚本自己怎么找（参考插件按端口找面板——那是插件的选择，不是应用做的）。没声明停止脚本的插件，只有在应用启动过它的时候才停得掉；否则 Stop 会报告什么都没做。

写一个在应用里调用也能正常工作的停止脚本：

- **不要等待输入。** stdin 是空设备，所以结尾带 `pause` 的脚本（手写包里常见）会立刻返回而不是挂住。保持这样——因为自身逻辑阻塞的脚本会在 60 秒时被杀。
- 成功退出 `0`。非零退出会被当作停止脚本失败报告给用户。
- 不要试图停止*本应用*，并且必须能被重复执行：如果脚本抢先把活干完了，应用再去杀自己的子进程也无害。

`更新` 和 `卸载` 都会先停掉插件，因为 Scoop 马上要替换或删除它正在用的文件。

关闭应用会按 Stop 按钮同样的方式停掉每个运行中的插件——有停止脚本就用它，否则杀进程树——预算缩短到 10 秒，免得退出时把插件的守护进程留下。因为应用马上要退出了，那里的失败只记进日志，不弹提示。

### 5b. 运行日志

每次运行都会写进一份持久日志，与输出面板分开——面板在窗口里，关掉应用就没了。日志把脚本输出的每一行连同来源流一起记下，前后还有标记：

```
2026-09-29 18:20:31 === start run.cmd ===
2026-09-29 18:20:31 [stdout] [plugin-showcase] created generated.yml on first boot
2026-09-29 18:20:31 [stdout] [plugin-showcase] serving   : http://127.0.0.1:8123/
2026-09-29 18:20:39 [stdout] [plugin-showcase] stopped.
2026-09-29 18:21:02 === stopped ===
```

它是纯文本，任何编辑器都能读，终端里也行，应用没装也没跑都能看。文件在应用配置目录的 `logs/plugins/` 下（见第 6 节），一个插件一份，按 id 命名，4 MB 轮转，保留五份归档（`<id>.log`、`<id>.1.log`……）。

设置页每张卡片有**打开运行日志**按钮（文件图标），在文件夹里选中该文件；插件页工具栏上也有同样的按钮。文件按需创建，所以这个按钮总能打开点什么。

## 6. 文件位置

三个目录，各自归各自的主人：

```
<scoop>/apps/<app>/<版本>/     插件自己的文件，Scoop 解开在这里
<scoop>/apps/<app>/current/    指向已安装版本的 junction，更新时被替换
<scoop>/persist/<app>/         插件的配置——更新和卸载都会保留
```

`current` 是应用运行、也是读取 `plugin.json` 的目录。它活不过一次更新，所以**用户编辑的配置文件放在持久化目录里**：`configFiles[].path` 按 `<scoop>/persist/<app>` 解析，`PLUGIN_PERSIST` 把脚本指到同一个地方。`absolute` 的源是例外——它按原样使用，属于那个路径真正的所有者。

Scoop 自己的 `scoop uninstall` 会保留持久化目录，所以重装同一个应用，用户的配置就回来了。应用不需要记住它们，也就没有会不一致的副本。

在应用配置目录（`%APPDATA%\com.anfioo.mabangprojectsworkflows\`）里，与 `config.json` 并列：

```
plugins.json       每个已安装插件的启用状态
logs/plugins/      每个插件一份运行日志，见第 5b 节
plugins/           旧 zip 安装器留下的目录，删掉之前会一直列出
```

`plugins.json` **只记每个插件开没开**。它不存配置值，也不存安装记录：装了什么就是 `scoop list` 会说的那些，所以在 Scoop 里卸载掉，卡片自然就没了。

## 7. 安全

**插件脚本是以你的身份运行的任意代码，没有沙箱。** 它能读写你的文件、访问网络、执行任何命令。因此：

- 插件装好后是**停用**状态；启用之前不会执行任何东西。
- 只从你信任的桶安装。桶清单也是代码：Scoop 会执行它的 `install` / `post_install` 步骤，`url` / `hash` 决定解什么包。
- 插件是纯文本——启用之前，先读一遍已安装目录里的 `plugin.json` 和 `run.cmd`。
- 配置窗口只会写**声明过的** `configFiles` 路径，每个都按持久化目录解析并检查；写入的也只是清单声明的键。唯一的出口是插件自己声明的 `absolute` 源。

插件页面（第 4 节）仍然是有任意网页内容的，只是改用真正的 webview 渲染，而不是带沙箱的 frame。它被限制在自己的源里——页面和地址栏都摸不到应用自己的地址——应用的命令也够不着。但插件提供的页面，可靠程度就等于插件本身。

## 8. 示例

两个都在本仓库的 [`examples/`](../../examples/) 下，各自带 `plugin.json`、脚本和配置文件，桶清单在 [`examples/bucket/`](../../examples/bucket/) 里。

### 全示例：`examples/plugin-showcase/`

**完整**参考：一份清单把所有能力都用上。写自己的插件时从头读一遍。

- **三种格式**——`env`，加上 `json` 与 `yaml`。
- **五种字段类型**——`string`、`number`（带 `min`/`max`）、`boolean`、`select` 和 `textarea`。
- **下拉框与开关**——一个三选一的 `select`，一个带 `options` + `trueValue` 的 `boolean`（两个状态写成 `1`/`0`），旁边放一个普通的开关 `boolean`，两者差别一眼可见。
- **点路径与数组下标**——`app.name`、`features.weights.0`。
- **`startmust` 的两种取值**——三个必带文件，一个（`generated.yml`）由脚本首次启动时生成。
- **带占位符的 `ui`**——`http://{SHOWCASE_HOST}:{SHOWCASE_PORT}/`。

它的页面把每个文件都渲染回来，所以在配置窗口里改完，刷新就能看到。页面由 `server.ps1`（PowerShell 5.1，无依赖）提供，它读的是配置窗口写的同一批文件，位置是持久化目录。

### 最小示例：`examples/hello-plugin/`

[`examples/hello-plugin/`](../../examples/hello-plugin/) 是一个能跑的最小插件。它声明两个源——一个 `.env` 放标量设置，一个 `cfg.json` 放一段自由文本——然后把读到的内容打印出来。

试其中一个的步骤：

1. 把它的桶清单复制到 Scoop 页上已添加的桶里，`url` 指到该目录打成的 zip（`plugin.json` 必须在 zip 根目录）——或者直接从本地源安装。
2. 在插件页点 **Install plugin**，填应用名。
3. 点「配置」改字段。看 `<scoop>/persist/<app>` 里的文件跟着变——注释都还在。
4. 点「运行」（或打开插件的标签页），看脚本读回了什么。

两个脚本在 `PLUGIN_PERSIST` 没设时会退回自己所在的目录，所以脱离应用手动跑也能用。

## 9. 常见问题

**「…is installed, but it is not a plugin: …」**
应用装上了，但它的 `current` 目录根下没有可读的 `plugin.json`。要么 zip 外面多套了一层目录（在桶清单里设 `extract_dir`），要么清单本身无效——后半句话会说是哪种。

**「'xxx' is already installed.」**
这个应用已经在了。点卡片上的**更新**；要从头重装，先卸载。

**「scoop install xxx exited with code 1.」**
Scoop 自己的消息就在输出面板里紧挨着上面一行——通常是应用名不存在（没有桶提供它，或桶列表过期了：去 Scoop 页刷新），也可能是下载失败或 hash 不匹配。

**「scoop … stopped responding and was killed.」**
Scoop 五分钟没有输出。某个环节在等永远不会来的输入，或者卡住的下载；在终端里跑一次就能看到停在哪。

**卡片说清单读不出来**
`plugin.json` 缺失、不是合法 JSON、`entry` 是绝对路径或含 `..`，或者某个 `configFiles` 的 `path` 如此。括号里是具体原因。修好应用，发一个新版本，再更新。

**「declares options, but its type is 'xxx'」**
`options` 被放在了类型不是 `boolean` 或 `select` 的字段上。要么把选项挪到 `select` 上，要么去掉 `options` 按 `type` 渲染。

**「is a boolean with options, so it must set trueValue…」/「trueValue '…' is not one of its option values」**
带 `options` 的 `boolean` 需要一个 `trueValue` 指出哪个选项代表「开」。补上它，并确认它的值和某个选项一致。带 options 却没有 `trueValue` 的 boolean 会被拒绝，`trueValue` 与任何选项都对不上也一样。

**「declares trueValue, but only a boolean with options uses it」**
`trueValue` 被放在了 `select`、没有 options 的普通 `boolean`，或者非选项字段上。它只在带 `options` 的 `boolean` 上有意义；别处删掉。

**什么都没发生，或者立刻失败**
看输出面板。「Entry script not found」表示 `entry` 路径不对。脚本里加一句 `echo %PLUGIN_DIR%` 可以确认工作目录。

**「Missing config: xxx does not exist」**
声明了 `startmust: true` 的源在**持久化目录**里没有文件。在配置窗口保存它的任一字段就会创建，或者插件本来就打算自己生成的话，把 `startmust` 设成 `false`。

**更新之后设置没了**
插件读写配置时用的是 `%PLUGIN_DIR%` 而不是 `%PLUGIN_PERSIST%`。`current` 每次更新都会被替换，能活下来的是持久化目录。

**停止时报告「Stop script not found: …」**
`stopScript` 指的文件不在应用里。插件照样会被停下（无论如何都会杀进程树），但请修正路径或者去掉这个键。

**停止时报告「Stop script '…' timed out」**
脚本跑了超过 60 秒。它被杀掉了，进程树也跟着被杀。通常是脚本在等永远不会来的输入（见第 5a 节），或者在等一个不肯退出的进程。

**停止时报告「Stop script '…' exited with code N」**
脚本跑了并且失败了。它自己的输出就在日志里紧挨着错误的上方，原因一般在那儿。

**卡片显示「Installed by the old zip installer」**
这份副本早于迁移到 Scoop 的版本，没法通过 Scoop 更新或卸载。先从桶里装好应用，再点旧卡片的垃圾桶图标删掉残留目录。

**卸载后留下一个目录**
`<scoop>/persist/<app>` 是故意保留的：里面是用户的配置，重装同一个应用就能找回来。想彻底清干净，手动删除该目录。

**插件在插件页没有标签页**
只有**已启用**且清单声明了 `ui` 的插件才有标签页。两个都检查一下；如果地址里带 `{key}` 而没有任何字段填它，设置页卡片会说明。

**插件页一直在等一个永远不应答的页面**
脚本起来了，但声明的地址上没人在听——通常是插件没能绑定端口，或者服务器只打印 URL 并不真的提供服务。在设置里点该插件的「运行」，看脚本自己的输出，原因写在那里。

**配置窗口显示的是旧值**
关掉再打开。窗口只在打开时读一次文件；之后在别的编辑器里的修改，下次打开时才生效。

**yaml 文件丢了注释**
这一版就是这样。yaml 适配器会整份重新序列化，而保留注释需要一个大得多的解析器。注释要紧的话，就放在 `.env` 里（逐字节保留），或者放在配置窗口不碰的文件里。

**输出乱码**
控制台代码页默认是 GBK。在脚本开头加一句 `chcp 65001 >nul` 切到 UTF-8。

**`.env` 里中文注释后面的键在 `.cmd` 输出里不见了**
同一个根因：cmd 按 GBK 代码页读文件，而配置窗口写的是 UTF-8，于是非 ASCII 的注释行解出来的字节会吃掉后面的换行，把下一个键粘到注释上——而 `eol=#` 又把这行跳过。在 `for /f` 之前加 `chcp 65001 >nul` 即可。见第 5 节的代码片段。

**`tauri dev` 下正常，打包后闪一个黑窗口**
插件脚本和应用其他 shell 走同一条「不创建控制台窗口」的路径，不该闪。如果闪了，检查脚本自己是不是 `start` 了另一个控制台程序。
