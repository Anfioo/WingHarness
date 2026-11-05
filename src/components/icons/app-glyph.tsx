import { cn } from "@/lib/utils";
import type { AppId } from "@/commands/services/ccs/types";
import hermesIcon from "@/assets/app-icons/hermes.png";
import { APP_ICON_SVG } from "./app-icon-svg";

/**
 * 各应用在官方图标集里的名字。
 *
 * 与官方 `AppGlyph` 的 `APP_ICON_NAME` 一致：Codex 用 OpenAI 的标，Grok Build 用
 * grok，MiniMax Code 用 minimax —— 图标跟的是背后的模型厂商，不跟 CLI 自己的名字。
 */
const APP_ICON_NAME: Record<AppId, string> = {
  claude: "claude",
  codex: "openai",
  gemini: "gemini",
  grokbuild: "grok",
  opencode: "opencode",
  openclaw: "openclaw",
  hermes: "hermes",
  pi: "pi",
  mcode: "minimax",
};

/// 只有光栅素材的应用（官方也只给了 PNG）。
const APP_ICON_RASTER: Partial<Record<AppId, string>> = {
  hermes: hermesIcon,
};

/** 不给尺寸时的兜底边长，与侧栏图标同档。 */
const FALLBACK_SIZE = "size-4";

/**
 * 应用品牌图标（Claude Code / Codex / Gemini CLI …）。
 *
 * 素材与配色都取自官方 cc-switch：SVG 以字符串原样注入，`currentColor` 的跟随外层
 * 文字色，品牌固定色的保持原样。内联 SVG 自带 `width/height="1em"`，会被 class 的
 * width/height 覆盖，所以这里让内部 svg 撑满外层盒子，尺寸统一由 `className` 决定。
 *
 * 装饰性元素：名称由旁边的文字给出，图标本身对辅助技术隐藏。
 */
export function AppGlyph({ app, className }: { app: AppId; className?: string }) {
  const raster = APP_ICON_RASTER[app];
  if (raster) {
    return (
      <img
        src={raster}
        alt=""
        aria-hidden="true"
        draggable={false}
        className={cn("shrink-0 object-contain", FALLBACK_SIZE, className)}
      />
    );
  }

  const svg = APP_ICON_SVG[APP_ICON_NAME[app]];
  if (!svg) return null;

  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex shrink-0 items-center justify-center [&>svg]:size-full",
        FALLBACK_SIZE,
        className
      )}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
