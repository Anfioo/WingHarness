import { ccsGetToolVersions } from "@/commands";
import type { ToolVersion } from "@/commands/services/ccs/types";

/**
 * 应用版本检测的前端缓存。
 *
 * 版本检测要逐个去跑各 CLI 的 `--version`，是这一步里最慢的请求，而版本号在一次
 * 「打开设置」期间不会变，没必要每次进分块、每次刷新都重来。于是：
 *
 * - 检测结果缓存在模块作用域（前端内存），同一窗口内切到别的设置分块再回来直接命中；
 * - 设置窗口关闭时 webview 被销毁，模块状态随之消失，也就是「标志归位」，
 *   下次打开设置自然重新检测（这期间用户可能装了或卸了某个 CLI）；
 * - 另外挂一个 `pagehide` 兜底，万一以后改成「只隐藏不销毁」，标志也能归位。
 *
 * 并发的重复调用共享同一个在途请求（React StrictMode 下开发时会挂载两次），
 * 所以一次打开最多只检测一次。
 */
let cached: ToolVersion[] | null = null;
let inFlight: Promise<ToolVersion[]> | null = null;

/** 读取版本；未缓存时发起检测（并发调用共享同一请求）。 */
export function loadToolVersions(): Promise<ToolVersion[]> {
  if (cached) return Promise.resolve(cached);
  if (!inFlight) {
    inFlight = ccsGetToolVersions()
      .then((list) => {
        cached = list;
        return list;
      })
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}

/** 让缓存失效，下次 [`loadToolVersions`] 重新检测。 */
export function clearToolVersions(): void {
  cached = null;
}

window.addEventListener("pagehide", clearToolVersions);
