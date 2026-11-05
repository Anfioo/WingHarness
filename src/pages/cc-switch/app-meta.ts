import type { AppId } from "@/commands/services/ccs/types";

/// 应用在界面上的展示信息。
///
/// 图标不在这里：各应用用的是官方品牌图标，统一由 `<AppGlyph app={...} />` 渲染。
export interface AppDisplay {
  /// 完整名称。
  name: string;
  /// 主题色（Tailwind 类名，用于图标底色与 currentColor 型图标着色）。
  color: string;
  /// 简短描述。
  description: string;
}

/// 各应用的展示元数据，顺序即应用 Tab / 列表的展示顺序。
export const APP_DISPLAY: Record<AppId, AppDisplay> = {
  claude: {
    name: "Claude Code",
    color: "bg-orange-500/10 text-orange-500",
    description: "Anthropic 官方 AI 编程 CLI",
  },
  codex: {
    name: "Codex",
    color: "bg-emerald-500/10 text-emerald-500",
    description: "OpenAI Codex CLI",
  },
  gemini: {
    name: "Gemini CLI",
    color: "bg-blue-500/10 text-blue-500",
    description: "Google Gemini AI 编程 CLI",
  },
  grokbuild: {
    name: "Grok Build",
    color: "bg-slate-500/10 text-slate-500",
    description: "xAI Grok Build CLI",
  },
  opencode: {
    name: "OpenCode",
    color: "bg-violet-500/10 text-violet-500",
    description: "开源 AI 编程工具",
  },
  openclaw: {
    name: "OpenClaw",
    color: "bg-amber-500/10 text-amber-500",
    description: "OpenClaw AI CLI",
  },
  hermes: {
    name: "Hermes",
    color: "bg-cyan-500/10 text-cyan-500",
    description: "Hermes AI CLI",
  },
  pi: {
    name: "Pi",
    color: "bg-pink-500/10 text-pink-500",
    description: "Pi AI CLI",
  },
  mcode: {
    name: "MiniMax Code",
    color: "bg-red-500/10 text-red-500",
    description: "MiniMax AI 编程 CLI",
  },
};

/// 全部应用 ID，按展示顺序排列。
export const ALL_APP_IDS = Object.keys(APP_DISPLAY) as AppId[];
