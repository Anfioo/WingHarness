import { useCallback, useEffect, useState, type ReactNode } from "react";
import { FolderOpen, Loader2, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import {
  ccsBrowseDirectory,
  ccsGetClaudeSwitches,
  ccsGetCodexSwitches,
  ccsGetResolvedDirs,
  ccsGetSettings,
  ccsSetAppVisible,
  ccsSetCodexSessionCompression,
  ccsSetConfigDir,
  ccsSetPluginIntegration,
  ccsSetSkipOnboarding,
} from "@/commands";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { HelpTip } from "@/components/ui/help-tip";
import { AppGlyph } from "@/components/icons/app-glyph";
import { ALL_APP_IDS, APP_DISPLAY } from "@/pages/cc-switch/app-meta";
import type { AppId, CcsCodexSwitches, ToolVersion } from "@/commands/services/ccs/types";
import { cn } from "@/lib/utils";
import { loadToolVersions } from "./ccs-version-cache";

/// 一行开关：名称 + 可选「?」说明 + 右侧开关。
function SwitchRow({
  label,
  help,
  description,
  checked,
  disabled,
  onCheckedChange,
}: {
  label: string;
  help: { title: string; body: ReactNode };
  description?: ReactNode;
  checked: boolean;
  disabled?: boolean;
  onCheckedChange?: (value: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-2.5">
      <div className="min-w-0">
        <div className="flex items-center gap-1">
          <span className="text-sm font-medium">{label}</span>
          <HelpTip title={help.title}>{help.body}</HelpTip>
        </div>
        {description && <p className="text-muted-foreground mt-0.5 text-xs">{description}</p>}
      </div>
      <Switch
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
        aria-label={label}
      />
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

/// 默认在「供应商」页签展示的应用（与后端 app_type 的 default_visible 一致）。
const DEFAULT_VISIBLE_APPS: AppId[] = ["claude", "codex", "gemini", "grokbuild", "opencode"];

/// 版本文案与配色：已安装显示 vX.Y.Z，装了但取不到版本 / 未安装各给一句。
function versionLabel(v: ToolVersion | undefined): { text: string; className: string } | null {
  if (!v) return null;
  if (v.version != null) {
    return { text: `v${v.version}`, className: "text-emerald-600 dark:text-emerald-400" };
  }
  if (v.installedButBroken) return { text: "无法获取版本", className: "text-warning" };
  return { text: "未安装", className: "text-muted-foreground" };
}

export function CcsAppConfigSection() {
  const [claudeSwitches, setClaudeSwitches] = useState<Record<string, boolean>>({});
  const [codexSwitches, setCodexSwitches] = useState<CcsCodexSwitches | null>(null);
  const [resolved, setResolved] = useState<Record<string, string>>({});
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [visibleApps, setVisibleApps] = useState<Record<string, boolean>>({});
  const [versions, setVersions] = useState<Record<string, ToolVersion>>({});
  const [versionsLoading, setVersionsLoading] = useState(true);
  const [loading, setLoading] = useState(true);
  const [busyApp, setBusyApp] = useState<string | null>(null);
  const [togglingApp, setTogglingApp] = useState<string | null>(null);
  const [compressionBusy, setCompressionBusy] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [claude, codex, dirs, settings] = await Promise.all([
        ccsGetClaudeSwitches(),
        ccsGetCodexSwitches(),
        ccsGetResolvedDirs(),
        ccsGetSettings(),
      ]);
      setClaudeSwitches(claude);
      setCodexSwitches(codex);
      setResolved(dirs);
      setOverrides(settings.configDirs ?? {});
      setVisibleApps(settings.visibleApps ?? {});
    } catch (error) {
      toast.error(String(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 版本检测单独走缓存：一次「打开设置」只检测一次，切分块回来不再重来。
  // 详情见 ./ccs-version-cache。
  useEffect(() => {
    let alive = true;
    void loadToolVersions()
      .then((toolVersions) => {
        if (!alive) return;
        const map: Record<string, ToolVersion> = {};
        for (const v of toolVersions) map[v.name] = v;
        setVersions(map);
      })
      .catch((error) => {
        if (alive) toast.error(String(error));
      })
      .finally(() => {
        if (alive) setVersionsLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const handleBrowse = async (app: AppId) => {
    setBusyApp(app);
    try {
      const picked = await ccsBrowseDirectory(app);
      if (picked) {
        await ccsSetConfigDir(app, picked);
        toast.success("配置目录已更新");
        await refresh();
      }
    } catch (error) {
      toast.error(String(error));
    } finally {
      setBusyApp(null);
    }
  };

  const handleReset = async (app: AppId) => {
    setBusyApp(app);
    try {
      await ccsSetConfigDir(app, null);
      toast.success("已重置为默认目录");
      await refresh();
    } catch (error) {
      toast.error(String(error));
    } finally {
      setBusyApp(null);
    }
  };

  /// 应用是否在「供应商」页签展示（未显式设置时用默认可见性）。
  const isVisible = (app: AppId): boolean => visibleApps[app] ?? DEFAULT_VISIBLE_APPS.includes(app);

  const handleToggleVisible = async (app: AppId, next: boolean) => {
    setTogglingApp(app);
    // 乐观更新。
    setVisibleApps((prev) => ({ ...prev, [app]: next }));
    try {
      await ccsSetAppVisible(app, next);
      const s = await ccsGetSettings();
      setVisibleApps(s.visibleApps ?? {});
      toast.success(next ? "已开启该应用" : "已关闭该应用");
    } catch (error) {
      toast.error(String(error));
      await refresh();
    } finally {
      setTogglingApp(null);
    }
  };

  const toggleClaudeSwitch = async (key: string, next: boolean) => {
    // 乐观更新。
    setClaudeSwitches((prev) => ({ ...prev, [key]: next }));
    try {
      if (key === "skipClaudeOnboarding") {
        await ccsSetSkipOnboarding(next);
      } else if (key === "enableClaudePluginIntegration") {
        await ccsSetPluginIntegration(next);
      }
      toast.success("已保存");
    } catch (error) {
      toast.error(String(error));
      await refresh();
    }
  };

  const toggleSessionCompression = async (next: boolean) => {
    setCompressionBusy(true);
    setCodexSwitches((prev) => (prev ? { ...prev, sessionCompression: next } : prev));
    try {
      const applied = await ccsSetCodexSessionCompression(next);
      setCodexSwitches((prev) => (prev ? { ...prev, sessionCompression: applied } : prev));
      toast.success("已保存");
      // 会话目录占用可能随开关变化，重新拉一次。
      await refresh();
    } catch (error) {
      toast.error(String(error));
      await refresh();
    } finally {
      setCompressionBusy(false);
    }
  };

  /// 目录行：路径只读展示 + 覆盖时显示重置 + 浏览。
  const directoryRow = (app: AppId) => {
    const display = APP_DISPLAY[app];
    const overridden = !!overrides[app];
    return (
      <div className="flex items-center gap-3 py-2.5">
        <span className="w-28 shrink-0 text-sm">{display.name}</span>
        <span className="text-muted-foreground min-w-0 flex-1 truncate font-mono text-xs">
          {resolved[app] ?? "—"}
        </span>
        {overridden && (
          <Button
            size="sm"
            variant="ghost"
            className="h-8 px-2 text-xs"
            disabled={busyApp === app}
            onClick={() => handleReset(app)}
          >
            <RotateCcw className="size-3.5" />
            重置
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          className="h-8 px-2 text-xs"
          disabled={busyApp === app}
          onClick={() => handleBrowse(app)}
        >
          <FolderOpen className="size-3.5" />
          浏览
        </Button>
      </div>
    );
  };

  /// 应用分块：图标 + 名称 + 版本 + 显示开关，卡片内放该应用专属开关与配置目录。
  const appBlock = (app: AppId, switches?: ReactNode) => {
    const display = APP_DISPLAY[app];
    const version = versionLabel(versions[app]);
    return (
      <div key={app} className="space-y-2">
        <div className="flex items-center gap-2">
          <span className={cn("flex size-6 items-center justify-center rounded-md", display.color)}>
            <AppGlyph app={app} className="size-3.5" />
          </span>
          <h3 className="text-sm font-medium">{display.name}</h3>
          {versionsLoading ? (
            <Loader2
              className="text-muted-foreground size-3 animate-spin"
              aria-label="正在检测版本"
            />
          ) : (
            version && (
              <span className={cn("font-mono text-xs", version.className)}>{version.text}</span>
            )
          )}
          <Switch
            className="ml-auto"
            checked={isVisible(app)}
            disabled={loading || togglingApp === app}
            onCheckedChange={(checked) => void handleToggleVisible(app, checked)}
            aria-label={`在供应商页展示 ${display.name}`}
          />
        </div>
        <div className="divide-border divide-y rounded-lg border px-3">
          {switches}
          {directoryRow(app)}
        </div>
      </div>
    );
  };

  const claudeSwitchesNode = (
    <>
      <SwitchRow
        label="应用到 Claude Code 插件"
        help={{
          title: "应用到 Claude Code 插件",
          body: "开启后 VS Code Claude Code 插件的供应商将随本软件切换。原理是在 Claude 配置目录的 config.json 写入 primaryApiKey。",
        }}
        checked={!!claudeSwitches.enableClaudePluginIntegration}
        disabled={loading}
        onCheckedChange={(v) => toggleClaudeSwitch("enableClaudePluginIntegration", v)}
      />
      <SwitchRow
        label="跳过 Claude Code 初次安装确认"
        help={{
          title: "跳过 Claude Code 初次安装确认",
          body: "Claude Code 第一次启动时会先走一遍引导流程，要求选主题并登录 Anthropic 账号。如果你用的是第三方供应商，不需要登录官方账号，开启后就能跳过这一步直接使用。原理是在 ~/.claude.json 里写入 hasCompletedOnboarding: true；关闭时删除该字段，下次启动会重新出现引导。",
        }}
        checked={!!claudeSwitches.skipClaudeOnboarding}
        disabled={loading}
        onCheckedChange={(v) => toggleClaudeSwitch("skipClaudeOnboarding", v)}
      />
    </>
  );

  const codexSwitchesNode = (
    <>
      <SwitchRow
        label="非接管切换时保留官方登录"
        help={{
          title: "非接管切换时保留官方登录",
          body: "切换第三方供应商时不覆盖 Codex 官方登录（~/.codex/auth.json 只保留 ChatGPT 登录，第三方 Key 写进 config.toml 的路由表）。本软件始终如此，无需配置。",
        }}
        description="始终开启：第三方 Key 不写入 auth.json，官方登录不被覆盖"
        checked
        disabled
      />
      <SwitchRow
        label="压缩 Codex 历史会话"
        help={{
          title: "压缩 Codex 历史会话",
          body: "打开后 Codex 每次启动时会在后台把 7 天以上没动过的会话文件压缩保存，明显减少占用的磁盘空间；在这些会话上继续对话时 Codex 会自动解压。这是 Codex 还在开发中的功能，需要较新版本的 Codex，重启 Codex 后生效。关闭后不再压缩，已压缩的会话保持原样。原理是写入 config.toml 的 [features] local_thread_store_compression。",
        }}
        description={
          codexSwitches ? `会话目录当前占用 ${formatBytes(codexSwitches.sessionsBytes)}` : undefined
        }
        checked={!!codexSwitches?.sessionCompression}
        disabled={loading || compressionBusy}
        onCheckedChange={(v) => void toggleSessionCompression(v)}
      />
    </>
  );

  return (
    <div className="space-y-5">
      <div>
        <h2 className="mb-1 text-lg font-semibold">应用配置</h2>
        <p className="text-muted-foreground text-sm">
          管理各 AI 编程 CLI 的显示开关与配置目录，以及 Claude Code / Codex 的应用专属选项。
          标题右侧的开关控制该应用是否出现在「CC Switch - 供应商」页签中。
        </p>
      </div>

      <div className="space-y-4">
        {ALL_APP_IDS.map((app) =>
          appBlock(
            app,
            app === "claude" ? claudeSwitchesNode : app === "codex" ? codexSwitchesNode : undefined
          )
        )}
      </div>

      <p className="text-muted-foreground text-xs">
        提示：至少需要保留一个应用开启，否则「供应商」页签将没有可切换的应用。
      </p>
    </div>
  );
}
