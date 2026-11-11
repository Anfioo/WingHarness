export default {
  title: "运行时",
  description: "下载并解压 Clash 与 FRP 功能运行所需的可执行文件。官方压缩包由本项目发布。",
  clash: {
    title: "Clash 运行时",
    description: "mihomo 核心及其 Geo 数据。",
  },
  frp: {
    title: "FRP 运行时",
    description: "官方 frpc 可执行文件。其他版本仍可从文件导入。",
  },
  official: "官方",
  status: {
    installed: "已安装",
    missing: "未安装",
    checking: "检查中…",
  },
  version: "版本 {{version}}",
  action: {
    official: "安装官方运行时",
    reinstall: "重新安装官方运行时",
    url: "从 URL 安装",
    archive: "从本地压缩包安装",
    openDir: "打开目录",
    refresh: "刷新",
  },
  hint: {
    archive: "支持 .7z 与 .zip 压缩包。",
  },
  dialog: {
    urlTitle: "从 URL 安装",
    urlDescription: "URL 需返回 .7z 或 .zip 压缩包，且根目录中包含 {{binary}}。",
    urlPlaceholder: "https://example.com/runtime.7z",
    install: "下载并安装",
    cancel: "取消",
  },
  progress: {
    download: "下载中…",
    extract: "解压中…",
    write: "写入文件 {{done}}/{{total}}…",
    bytes: "{{received}} / {{total}}",
  },
  messages: {
    installed: "{{name}}已安装。",
  },
  errors: {
    invalidUrl: "请填写 http(s) 地址。",
    statusFailed: "无法读取运行时状态：{{detail}}",
    installFailed: "安装失败：{{detail}}",
    binaryMissing: "压缩包根目录中没有 {{binary}}。",
  },
  frpHint: "该条目不能删除，只显示官方 frpc 是否存在。",
};
