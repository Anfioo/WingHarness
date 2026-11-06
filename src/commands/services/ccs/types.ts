/// 支持的 AI 编程 CLI 应用标识。
export type AppId =
  | "claude"
  | "codex"
  | "gemini"
  | "grokbuild"
  | "opencode"
  | "openclaw"
  | "hermes"
  | "pi"
  | "mcode";

/// 配置文件格式。
export type ConfigFormat = "json" | "toml" | "yaml" | "env";

/// 供应商元数据。
export interface ProviderMeta {
  providerType?: string;
  apiKeyField?: string;
}

/// 供应商。
export interface Provider {
  id: string;
  name: string;
  /** 供应商完整配置（结构随应用不同）。 */
  settingsConfig: Record<string, unknown>;
  websiteUrl?: string;
  category?: string;
  createdAt?: number;
  sortIndex?: number;
  notes?: string;
  meta?: ProviderMeta;
  icon?: string;
  iconColor?: string;
}

/// 导入来源。
export type ImportSource = "live" | "ccswitch" | "json";

/// 获取到的模型。
export interface FetchedModel {
  id: string;
  ownedBy: string | null;
}

/// 可导入的供应商条目（含相对当前应用的状态）。
export interface ImportedProvider extends Provider {
  /// `new`（该应用尚无此 id）或 `update`（已存在，导入即覆盖）。
  status: "new" | "update";
}

/// CC Switch 应用级设置（存储在 config.json 的 `ccs` 字段）。
///
/// 只放需要本软件自己记住的东西。Claude / Codex 的应用专属开关不在这里 ——
/// 它们直接读写 CLI 自己的配置文件，状态以那边为准。
export interface CcsSettings {
  visibleApps: Record<string, boolean>;
  configDirs: Record<string, string>;
  /** 切换供应商时是否同步官方 cc-switch 数据库的「当前」标记。 */
  syncCcSwitchDb: boolean;
  /** 进入供应商页时是否采用官方 cc-switch 的当前选择。 */
  syncFromCcSwitch: boolean;
}

/// 官方 cc-switch 数据库的探测结果。
export interface CcsSwitchDb {
  path: string;
  exists: boolean;
}

/// Codex 专属开关状态。
export interface CcsCodexSwitches {
  /** 是否开启历史会话压缩（config.toml 的 [features] local_thread_store_compression）。 */
  sessionCompression: boolean;
  /** Codex 会话目录当前占用（字节）。 */
  sessionsBytes: number;
}

/// 单个工具的版本探测结果。
export interface ToolVersion {
  name: AppId;
  version: string | null;
  error: string | null;
  installedButBroken: boolean;
  envType: string;
}

/// 切换供应商的结果（switch 命令使用）。
export interface SwitchResult {
  app: AppId;
  providerId: string;
  providerName: string;
  configFile: string;
}
