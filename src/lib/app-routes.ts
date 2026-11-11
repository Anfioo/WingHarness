import {
  Blocks,
  Bot,
  Building2,
  Database,
  FolderGit2,
  FolderSync,
  FileSearch,
  FileText,
  GitBranch,
  GitFork,
  History,
  NotebookPen,
  Network,
  Download,
  Package,
  Plug,
  Send,
  Server,
  Sparkles,
  SquareTerminal,
  Wrench,
  Zap,
} from "lucide-react";
import type { ComponentType, CSSProperties } from "react";
import { CcSwitchLogo } from "@/components/icons/cc-switch-logo";

export type AppRouteGroup =
  | "workspace"
  | "ecosystem"
  | "plugins"
  | "agents"
  | "servers"
  | "frp"
  | "mdEditor"
  | "ports"
  | "moin";

/**
 * 侧栏 / 页头用的图标。大多是 lucide 图标，但 CC Switch 用它自己的品牌 logo
 * （自带配色，不是单色描边），自定义 SVG 图标则是一张图片；所以只要求
 * 「能收 className 和 style」这一条共同点——lucide 用 `currentColor` 描边，
 * 因此 `style.color` 就能改它们的颜色。
 */
export type AppRouteIcon = ComponentType<{ className?: string; style?: CSSProperties }>;

export type AppRouteId =
  | "gitRepo"
  | "svnWorkspace"
  | "apiClient"
  | "database"
  | "systools"
  | "servers"
  | "frp"
  | "privateRegistry"
  | "localTerminal"
  | "clash"
  | "plugins"
  | "ccSwitch"
  | "mcpHub"
  | "aiConfig"
  | "claudeChat"
  | "claudeHistory"
  | "claudeWorkflow"
  | "notes"
  | "filePreview"
  | "project"
  | "mdEditor"
  | "ports"
  | "moin";

export type AppRoute = {
  id: AppRouteId;
  group: AppRouteGroup;
  path: string;
  title: string;
  navLabel: string;
  description: string;
  icon: AppRouteIcon;
  scope: string;
  items: string[];
};

export const appRoutes: AppRoute[] = [
  {
    id: "project",
    group: "agents",
    path: "/",
    title: "项目",
    navLabel: "项目",
    description:
      "打开本地项目：选择页列出打开与最近的项目，每个项目在自己的窗口里打开，重复打开只会聚焦已开的那个窗口。窗口里目录按需逐层加载，文件可直接查看与修改并写回磁盘。",
    icon: FolderGit2,
    scope: "侧边栏页面 + 一窗口一项目",
    items: ["打开 / 最近项目", "按需加载文件树", "标签页编辑器", "可拖拽面板"],
  },
  {
    id: "svnWorkspace",
    group: "workspace",
    path: "/svn-workspace",
    title: "SVN 工作副本",
    navLabel: "SVN 工作副本",
    description:
      "打开本地 SVN 工作副本：工作区状态筛选、按文件或目录部分提交、更新、检出、历史与 Diff、逐行 Blame，以及本地贮藏（含未跟踪文件）。这一页是侧边栏页面，列出打开与最近的工作副本；每个工作副本在自己的窗口里打开，重复打开只会聚焦已开的那个窗口。它直接调用本机的 svn 命令行。",
    icon: FolderSync,
    scope: "侧边栏页面 + 一窗口一工作副本",
    items: ["打开 / 检出工作副本", "工作区状态与部分提交", "历史、Diff 与 Blame", "本地贮藏"],
  },
  {
    id: "gitRepo",
    group: "workspace",
    path: "/git-repo",
    title: "Git 仓库",
    navLabel: "Git 仓库",
    description:
      "打开本地 Git 仓库：分支、提交图、工作区、Diff 与冲突解决。这一页是侧边栏页面，列出打开与最近的仓库；每个仓库在自己的窗口里打开，重复打开只会聚焦已开的那个窗口。",
    icon: GitBranch,
    scope: "侧边栏页面 + 一窗口一仓库",
    items: ["打开 / 克隆仓库", "分支与提交图", "工作区与 Diff", "冲突解决"],
  },
  {
    id: "apiClient",
    group: "workspace",
    path: "/api-client",
    title: "API 客户端",
    navLabel: "API 客户端",
    description:
      "导入 OpenAPI / Swagger 规范或从一个空工作区起步，在集合树、请求编辑器与响应查看三栏里收发 REST 请求。这一页是侧边栏页面，列出与最近使用的工作区；每个工作区在自己的窗口里打开，重复打开只会聚焦已开的那个窗口。",
    icon: Send,
    scope: "侧边栏页面 + 一窗口一工作区",
    items: ["导入 OpenAPI / Swagger", "集合与请求树", "请求编辑与发送", "响应查看"],
  },
  {
    id: "database",
    group: "workspace",
    path: "/database",
    title: "数据库",
    navLabel: "数据库",
    description:
      "管理数据库数据源：SQLite、PostgreSQL、MySQL、SQL Server、ClickHouse 与 Oracle。这一页是侧边栏页面，列出数据源并试连；每个数据源在自己的窗口里打开 SQL 控制台、对象树与结果表格，重复打开只会聚焦已开的那个窗口。",
    icon: Database,
    scope: "侧边栏页面 + 一窗口一数据源",
    items: ["数据源管理", "对象树", "SQL 控制台", "结果表格"],
  },
  {
    id: "systools",
    group: "workspace",
    path: "/systools",
    title: "系统工具",
    navLabel: "系统工具",
    description:
      "把 Windows 上常见的系统清理与维护集中到一页：启动项、卸载与残留、系统优化、磁盘分析、重复文件与大文件。每个页签独立扫描，扫描状态在切换页签时保留；也可以单独在新窗口打开，重复打开只会聚焦已开的那个窗口。",
    icon: Wrench,
    scope: "Windows 系统工具 / 六个页签",
    items: ["启动项", "卸载与残留", "系统优化", "磁盘分析", "重复文件", "大文件"],
  },
  {
    id: "ports",
    group: "ports",
    path: "/ports",
    title: "端口",
    navLabel: "端口",
    description: "查看本机监听的 TCP 端口，定位并结束占用端口的进程。",
    icon: Plug,
    scope: "本机",
    items: ["监听端口", "固定端口", "结束进程"],
  },
  {
    id: "servers",
    group: "servers",
    path: "/servers",
    title: "服务器管理",
    navLabel: "服务器管理",
    description:
      "管理 SSH 服务器档案：在唯一的服务器管理窗口里为每台服务器打开一个标签，标签内提供交互式终端与 XFTP 双栏文件管理。凭据存进系统凭据管理器，私钥只记录路径，首次连接需要确认主机密钥指纹。",
    icon: Server,
    scope: "SSH 终端 / XFTP 双栏",
    items: ["服务器档案", "交互式终端", "本地 / 远程双栏文件管理", "传输队列"],
  },
  {
    id: "frp",
    group: "frp",
    path: "/frp",
    title: "FRP 控制台",
    navLabel: "FRP 控制台",
    description:
      "管理 frpc 服务器档案、隧道与运行时：每个档案一个进程，生成并校验 frpc.toml，实时回显连接状态、延迟与日志。只需选择本机已有的 frpc，不需要联网下载。",
    icon: Network,
    scope: "frpc 进程 / 隧道",
    items: ["概览", "服务器", "隧道", "日志", "运行时"],
  },
  {
    id: "privateRegistry",
    group: "ecosystem",
    path: "/private-registry",
    title: "私有源仓库",
    navLabel: "私有源仓库",
    description: "管理组织内部源、认证信息和环境包索引。",
    icon: Building2,
    scope: "界面已做 / 逻辑待实现",
    items: ["仓库地址", "认证配置", "包索引同步"],
  },
  {
    id: "localTerminal",
    group: "ecosystem",
    path: "/local-terminal",
    title: "终端",
    navLabel: "终端",
    description: "在应用内打开一个本地命令行（Windows cmd），直接执行交互式命令。",
    icon: SquareTerminal,
    scope: "本地 PTY / cmd.exe",
    items: ["本地命令行", "交互式输入", "实时输出"],
  },
  {
    id: "clash",
    group: "ecosystem",
    path: "/clash",
    title: "Clash 规则引擎",
    navLabel: "Clash 规则引擎",
    description:
      "用 Prism 把源配置和若干规则补丁编译成 mihomo 实际加载的配置：左侧管理 .prism.yaml 补丁，右侧编辑源配置，预览或应用后写入 run/config.yaml；应用时若核心在运行会通过 external-controller 热重载。核心二进制由用户自己放进数据目录的 clash 文件夹。",
    icon: Zap,
    scope: "Prism 编译 / mihomo 核心",
    items: ["源配置与规则补丁", "预览与执行明细", "应用与热重载", "核心启动与校验"],
  },
  {
    id: "plugins",
    group: "plugins",
    path: "/plugins",
    title: "插件面板",
    navLabel: "插件",
    description:
      "把插件自己打开的页面直接嵌进应用，每个声明的 ui 地址对应一个页签。打开页面时会自动启动尚未运行的插件，无需切到浏览器。",
    icon: Package,
    scope: "插件页面 / 应用内嵌",
    items: ["插件页签", "打开时自动启动", "刷新与停止"],
  },
  {
    id: "mcpHub",
    group: "agents",
    path: "/mcp-hub",
    title: "MCP Hub",
    navLabel: "MCP Hub",
    description: "把本地/远程 MCP server 聚合成一个端点，统一开关、日志与 token。",
    icon: Blocks,
    scope: "Agent / MCP 网关",
    items: ["Server 管理", "工具开关", "调用日志", "Token"],
  },
  {
    id: "ccSwitch",
    group: "agents",
    path: "/cc-switch",
    title: "CC Switch",
    navLabel: "CC Switch",
    description:
      "管理 Claude Code、Codex、Gemini、OpenCode 等 AI 编程 CLI 的供应商，一键切换路由并写入对应配置文件。应用开关与版本检测在「设置 - 应用配置」里。",
    icon: CcSwitchLogo,
    scope: "Agent / 供应商切换",
    items: ["供应商管理", "一键切换", "配置文件写入"],
  },
  {
    id: "aiConfig",
    group: "agents",
    path: "/ai-config",
    title: "AI 配置同步",
    navLabel: "AI 配置同步",
    description:
      "用一个 git 仓库作为唯一的配置数据源（store），把 skills / rules / commands / subagents 与 MCP 定义翻译成各 AI 编码工具各自需要的格式。查看每个 agent 的同步漂移状态、预览并应用写入，或把 agent 本地已有内容导入 store。",
    icon: Sparkles,
    scope: "Store / Skill 同步",
    items: ["Agent 漂移看板", "差异预览与应用", "条目管理", "Push / Pull"],
  },
  {
    id: "claudeChat",
    group: "agents",
    path: "/claude-chat",
    title: "Claude 对话",
    navLabel: "Claude 对话",
    description:
      "直接和本机安装的 Claude Code CLI 对话：消息以流式逐字返回，多条消息之间保留上下文，工作目录取最近打开的项目。",
    icon: Bot,
    scope: "Agent / 本地 Claude CLI",
    items: ["流式对话", "多轮上下文", "模型选择"],
  },
  {
    id: "claudeHistory",
    group: "agents",
    path: "/claude-history",
    title: "Claude 历史",
    navLabel: "Claude 历史",
    description:
      "把 Claude Code 存在本机 .claude/projects 里的会话读出来按项目浏览：消息逐条展开成节点，中间的工具调用可以省略；整段会话能克隆成新会话，也能在某条回复处分支出一条新对话。只读浏览，不发起对话。",
    icon: History,
    scope: "Agent / 本地会话历史",
    items: ["按项目浏览", "节点视图", "克隆会话", "回复处分支"],
  },
  {
    id: "claudeWorkflow",
    group: "agents",
    path: "/claude-workflow",
    title: "Claude 工作流",
    navLabel: "Claude 工作流",
    description:
      "把一段会话和从它派生出来的那些画成一张关系图：左栏按项目列出有派生关系的会话，选中后画布上每轮对话是一个节点（我的提问 + Claude 在那一轮的最后一条回复）。分叉出的会话与来源共用分叉点之前的节点，克隆则是单独一条线，克隆下再分叉就挂在克隆那条线上。这里只画关系，关系存在数据目录里，消息本身仍从本机的会话文件读取。",
    icon: GitFork,
    scope: "Agent / 会话分叉关系",
    items: ["按项目选会话", "画布浏览", "分叉合并", "克隆独立成线"],
  },
  {
    id: "notes",
    group: "agents",
    path: "/notes",
    title: "笔记",
    navLabel: "笔记",
    description:
      "把每条会议、任务或想法记成一个 Markdown 文件，左侧文件树、标签页编辑器与可拖拽面板构成的完整编辑体验，内容直接落盘到数据目录的 notes 文件夹。",
    icon: NotebookPen,
    scope: "本地 Markdown 笔记",
    items: ["文件树", "标签页编辑器", "可拖拽面板"],
  },
  {
    id: "filePreview",
    group: "agents",
    path: "/file-preview",
    title: "文件预览",
    navLabel: "文件预览",
    description:
      "只读预览所选项目里的文件：Word、Excel、PPT、PDF、图片、压缩包、音视频与常见文本格式都在这里解析，左侧文件树按需展开，内容不写回磁盘。项目在页面顶部选择。",
    icon: FileSearch,
    scope: "所选项目 / 只读预览",
    items: ["按需加载文件树", "Office / PDF / 图片", "压缩包与音视频"],
  },
  {
    id: "mdEditor",
    group: "mdEditor",
    path: "/md-editor",
    title: "Markdown 编辑器",
    navLabel: "Markdown 编辑器",
    description:
      "打开与编辑本地 Markdown 文档：多标签页、可筛选层级的大纲，阅读 / 源码 / 分屏三种视图，以及导出 HTML、长图与 PDF。文档本身留在原位置，设置、最近文件与会话收在数据目录的 md-editor 文件夹里。",
    icon: FileText,
    scope: "文档 / 预览 / 导出",
    items: ["标签页", "大纲", "阅读", "源码", "分屏", "导出"],
  },
  {
    id: "moin",
    group: "moin",
    path: "/moin",
    title: "下载",
    navLabel: "下载",
    description: "管理 HTTP/HTTPS 下载队列、进度与下载设置。",
    icon: Download,
    scope: "HTTP/HTTPS 下载 / 队列 / 分类",
    items: ["多连接分段下载", "队列与续传", "分类规则", "浏览器扩展"],
  },
];

export const workspaceRoutes = appRoutes.filter((route) => route.group === "workspace");
export const ecosystemRoutes = appRoutes.filter((route) => route.group === "ecosystem");
export const pluginRoutes = appRoutes.filter((route) => route.group === "plugins");
export const agentRoutes = appRoutes.filter((route) => route.group === "agents");

export function getAppRoute(id: AppRouteId) {
  return appRoutes.find((route) => route.id === id) ?? appRoutes[0];
}

export function getAppRouteByPath(pathname: string) {
  return appRoutes.find((route) => route.path === pathname) ?? appRoutes[0];
}
