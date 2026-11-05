import { invokeCommand } from "../../base";
import type {
  AppId,
  CcsCodexSwitches,
  CcsSettings,
  FetchedModel,
  ImportedProvider,
  ImportSource,
  Provider,
  SwitchResult,
  ToolVersion,
} from "./types";

// ============================================================================
// 应用管理
// ============================================================================

/** 并发检测全部 AI CLI 的本地版本。 */
export function getToolVersions(): Promise<ToolVersion[]> {
  return invokeCommand("ccs_get_tool_versions", {});
}

/** 获取当前可见的应用 ID 列表。 */
export function getVisibleApps(): Promise<string[]> {
  return invokeCommand("ccs_get_visible_apps", {});
}

/** 把本机已有的 CLI 配置导入为一条供应商并设为当前。 */
export function importLiveConfig(app: AppId): Promise<boolean> {
  return invokeCommand("ccs_import_live_config", { app });
}

/** 预览可导入的供应商（来源：live / ccswitch / json）。 */
export function importPreview(
  app: AppId,
  source: ImportSource,
  dbPath?: string
): Promise<ImportedProvider[]> {
  return invokeCommand("ccs_import_preview", { app, source, dbPath });
}

/** 保存勾选的导入条目（按 id 覆盖或新增）。 */
export function importSave(app: AppId, providers: ImportedProvider[]): Promise<number> {
  return invokeCommand("ccs_import_save", { app, providers });
}

/** 弹出文件选择对话框，返回所选文件路径。 */
export function pickImportFile(kind: "db" | "json"): Promise<string | null> {
  return invokeCommand("ccs_pick_import_file", { kind });
}

/** 获取某供应商配置的可用模型列表。 */
export function fetchModels(app: AppId, provider: Provider): Promise<FetchedModel[]> {
  return invokeCommand("ccs_fetch_models", { app, provider });
}

/** 计算编辑器视图与基准：视图=live 套上该供应商的投影（显示用），基准=live 去关键字段
 * （保存算增量用）。 */
export function editorBase(
  app: AppId,
  provider?: Provider | null
): Promise<{ view: unknown; baseline: unknown }> {
  return invokeCommand("ccs_editor_base", { app, provider: provider ?? null });
}

/** 由编辑器内容算出应存进供应商的最小配置（去掉与基准相同的部分）。 */
export function editorDelta(app: AppId, edited: unknown, base: unknown): Promise<unknown> {
  return invokeCommand("ccs_editor_delta", { app, edited, base });
}

/** 设置某应用是否可见（自动保证至少一个可见）。 */
export function setAppVisible(app: AppId, visible: boolean): Promise<boolean> {
  return invokeCommand("ccs_set_app_visible", { app, visible });
}

// ============================================================================
// 应用配置（设置页）
// ============================================================================

export function getSettings(): Promise<CcsSettings> {
  return invokeCommand("ccs_get_settings", {});
}

export function saveSettings(settings: CcsSettings): Promise<boolean> {
  return invokeCommand("ccs_save_settings", { newSettings: settings });
}

export function getConfigDir(app: AppId): Promise<string | null> {
  return invokeCommand("ccs_get_config_dir", { app });
}

export function setConfigDir(app: AppId, dir: string | null): Promise<boolean> {
  return invokeCommand("ccs_set_config_dir", { app, dir });
}

/** 弹出系统目录选择对话框，起始位置为该应用当前的配置目录。 */
export function browseDirectory(app: AppId): Promise<string | null> {
  return invokeCommand("ccs_browse_directory", { app });
}

/** 获取各应用实际生效的配置目录。 */
export function getResolvedDirs(): Promise<Record<string, string>> {
  return invokeCommand("ccs_get_resolved_dirs", {});
}

// ============================================================================
// 供应商管理
// ============================================================================

export function getProviders(app: AppId): Promise<Provider[]> {
  return invokeCommand("ccs_get_providers", { app });
}

export function getCurrentProvider(app: AppId): Promise<string | null> {
  return invokeCommand("ccs_get_current_provider", { app });
}

export function addProvider(app: AppId, provider: Provider): Promise<string> {
  return invokeCommand("ccs_add_provider", { app, provider });
}

export function updateProvider(
  app: AppId,
  originalId: string,
  provider: Provider
): Promise<boolean> {
  return invokeCommand("ccs_update_provider", { app, originalId, provider });
}

export function deleteProvider(app: AppId, id: string): Promise<boolean> {
  return invokeCommand("ccs_delete_provider", { app, id });
}

export function duplicateProvider(app: AppId, id: string): Promise<string> {
  return invokeCommand("ccs_duplicate_provider", { app, id });
}

export function switchProvider(app: AppId, id: string): Promise<SwitchResult> {
  return invokeCommand("ccs_switch_provider", { app, id });
}

export function reorderProviders(app: AppId, orderedIds: string[]): Promise<boolean> {
  return invokeCommand("ccs_update_sort_order", { app, orderedIds });
}

// ============================================================================
// Claude Code 安装/集成开关
// ============================================================================

/** 查询 Claude onboarding / 插件集成状态。 */
export function getClaudeSwitches(): Promise<Record<string, boolean>> {
  return invokeCommand("ccs_get_claude_switches", {});
}

/** 设置是否跳过 Claude Code 初次安装确认。 */
export function setSkipOnboarding(skip: boolean): Promise<boolean> {
  return invokeCommand("ccs_set_skip_onboarding", { skip });
}

/** 设置是否启用 Claude 插件集成。 */
export function setPluginIntegration(enable: boolean): Promise<boolean> {
  return invokeCommand("ccs_set_plugin_integration", { enable });
}

// ============================================================================
// Codex 安装/集成开关
// ============================================================================

/** 查询 Codex 专属开关状态（会话压缩 + 会话目录占用）。 */
export function getCodexSwitches(): Promise<CcsCodexSwitches> {
  return invokeCommand("ccs_get_codex_switches", {});
}

/** 设置 Codex 历史会话压缩；返回写入后的状态。 */
export function setCodexSessionCompression(enabled: boolean): Promise<boolean> {
  return invokeCommand("ccs_set_codex_session_compression", { enabled });
}
