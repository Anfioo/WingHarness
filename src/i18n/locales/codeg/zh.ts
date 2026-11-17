const codeg = {
  tabs: {
    chat: "对话",
    settings: "设置",
  },
  page: {
    loading: "正在加载 Codeg…",
    starting: "正在启动 Codeg 服务…",
    stopped: "Codeg 服务未运行",
    failed: "Codeg 服务启动失败",
    hint: "在「设置 → Codeg（开发）」里检查路径、端口与数据目录。",
    start: "启动服务",
    stop: "停止服务",
    restart: "重启服务",
    reload: "重新加载页面",
    devtools: "打开页面调试器",
    openFailed: "无法打开 Codeg：{{message}}",
    openLinkFailed: "无法打开链接：{{message}}",
    languageFailed: "无法设置 Codeg 语言：{{message}}",
  },
  settings: {
    title: "Codeg（开发）",
    description:
      "让 Codeg 与本应用一起运行，并作为独立 webview 嵌进来：codeg-server 由本应用启动与托管，Codeg 页面的外观与语言跟随本应用。仅用于开发模式。",
    server: "服务",
    serverHint:
      "应用在回环地址上启动 codeg-server，并在应用退出时停止它。改过路径或端口后需要重新启动才生效。",
    start: "启动",
    stop: "停止",
    restart: "重启",
    ready: "已就绪",
    starting: "启动中",
    failed: "失败",
    stopped: "未启动",
    paths: "路径",
    pathsHint: "Codeg 在这台机器上的位置。",
    repoPath: "Codeg 仓库路径",
    staticDir: "静态站点目录",
    staticDirHint: "服务对外提供的是这份 Next.js 导出产物；改过 Codeg 后需要重新构建。",
    serverPath: "codeg-server 可执行文件",
    serverPathHint:
      "用 cargo build --no-default-features --features server-bin --bin codeg-server 构建。",
    port: "端口",
    dataDir: "数据目录",
    dataDirHint: "留空则使用单独启动的 Codeg 也默认使用的目录，两边的数据共用一个库。",
    restartHint: "改过路径或端口后，重启服务即可生效。",
    token: "访问令牌",
    tokenHint:
      "首次使用时自动生成并持久化，之后固定不变。嵌入的页面用它直接登录，所以不会出现登录页。",
    copy: "复制",
    tokenCopied: "令牌已复制",
    log: "服务输出",
    logEmpty: "暂无输出。",
  },
};

export default codeg;
