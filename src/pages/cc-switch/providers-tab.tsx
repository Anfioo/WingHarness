import { useCallback, useEffect, useState } from "react";
import { Check, Copy, Pencil, Plus, RefreshCw, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";
import {
  ccsDuplicateProvider,
  ccsDeleteProvider,
  ccsGetProviders,
  ccsGetCurrentProvider,
  ccsGetVisibleApps,
  ccsSwitchProvider,
  ccsSyncFromCcSwitch,
} from "@/commands";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { AppId, Provider } from "@/commands/services/ccs/types";
import { AppGlyph } from "@/components/icons/app-glyph";
import { APP_DISPLAY } from "./app-meta";
import { ProviderDialog } from "./provider-dialog";
import { ProviderImportDialog } from "./provider-import-dialog";

export function ProvidersTab() {
  const [visibleApps, setVisibleApps] = useState<AppId[]>([]);
  const [currentApp, setCurrentApp] = useState<AppId | null>(null);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Provider | null>(null);
  const [importOpen, setImportOpen] = useState(false);

  // 首次：加载可见应用，选中第一个。
  useEffect(() => {
    (async () => {
      try {
        const visible = await ccsGetVisibleApps();
        const apps = visible as AppId[];
        setVisibleApps(apps);
        if (apps.length > 0) setCurrentApp(apps[0]);
      } catch (error) {
        toast.error(String(error));
      }
    })();
  }, []);

  const loadProviders = useCallback(async (app: AppId) => {
    setLoading(true);
    try {
      const [list, current] = await Promise.all([ccsGetProviders(app), ccsGetCurrentProvider(app)]);
      setProviders(list);
      setCurrentId(current);
    } catch (error) {
      toast.error(String(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!currentApp) return;
    void (async () => {
      // 进页面（或换应用页签）时先按设置对齐官方 CC Switch 的选择；
      // 开关关闭时后端直接返回 null。
      try {
        const applied = await ccsSyncFromCcSwitch(currentApp);
        if (applied) toast.success(`已按 CC Switch 的选择切换到 ${applied}`);
      } catch (error) {
        toast.error(String(error));
      }
      await loadProviders(currentApp);
    })();
  }, [currentApp, loadProviders]);

  const handleSwitch = async (provider: Provider) => {
    if (!currentApp || provider.id === currentId) return;
    setBusyId(provider.id);
    try {
      await ccsSwitchProvider(currentApp, provider.id);
      setCurrentId(provider.id);
      toast.success(`已切换到 ${provider.name}`);
    } catch (error) {
      toast.error(String(error));
    } finally {
      setBusyId(null);
    }
  };

  const handleCopy = async (provider: Provider) => {
    if (!currentApp) return;
    setBusyId(provider.id);
    try {
      await ccsDuplicateProvider(currentApp, provider.id);
      await loadProviders(currentApp);
      toast.success("已复制供应商");
    } catch (error) {
      toast.error(String(error));
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (provider: Provider) => {
    if (!currentApp) return;
    if (!window.confirm(`确定删除供应商「${provider.name}」吗？`)) return;
    setBusyId(provider.id);
    try {
      await ccsDeleteProvider(currentApp, provider.id);
      await loadProviders(currentApp);
      toast.success("已删除供应商");
    } catch (error) {
      toast.error(String(error));
    } finally {
      setBusyId(null);
    }
  };

  const openAdd = () => {
    setEditing(null);
    setDialogOpen(true);
  };

  const openEdit = (provider: Provider) => {
    setEditing(provider);
    setDialogOpen(true);
  };

  return (
    <div className="space-y-4">
      {/* 应用切换栏（仅可见应用） */}
      <div className="flex flex-wrap items-center gap-2">
        {visibleApps.map((appId) => {
          const display = APP_DISPLAY[appId];
          const active = appId === currentApp;
          return (
            <button
              key={appId}
              onClick={() => setCurrentApp(appId)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm transition-colors",
                active
                  ? "border-primary bg-primary text-primary-foreground"
                  : "bg-card hover:bg-accent"
              )}
            >
              <AppGlyph app={appId} className="size-4" />
              {display.name}
            </button>
          );
        })}
      </div>

      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">
            {currentApp ? APP_DISPLAY[currentApp].name : "供应商"}
          </h2>
          <p className="text-muted-foreground text-sm">
            管理该工具的供应商，点击「切换」将配置写入对应配置文件。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => currentApp && loadProviders(currentApp)}
            disabled={loading}
          >
            <RefreshCw className={cn("size-4", loading && "animate-spin")} />
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setImportOpen(true)}
            disabled={!currentApp}
          >
            <Upload className="size-4" />
            导入
          </Button>
          <Button size="sm" onClick={openAdd} disabled={!currentApp}>
            <Plus className="size-4" />
            新增供应商
          </Button>
        </div>
      </div>

      {/* 供应商卡片列表 */}
      {loading ? (
        <div className="text-muted-foreground py-10 text-center text-sm">加载中…</div>
      ) : providers.length === 0 ? (
        <div className="border-card rounded-xl border border-dashed py-12 text-center">
          <p className="text-muted-foreground text-sm">还没有供应商。</p>
          <div className="mt-3 flex items-center justify-center gap-2">
            <Button size="sm" variant="outline" onClick={() => setImportOpen(true)}>
              <Upload className="size-4" />
              导入配置
            </Button>
            <Button size="sm" onClick={openAdd}>
              <Plus className="size-4" />
              新增供应商
            </Button>
          </div>
        </div>
      ) : (
        // 流式列数：按可用宽度自动排，卡片窄了就换行，不再固定两列。
        <div className="grid grid-cols-[repeat(auto-fill,minmax(16rem,1fr))] gap-3">
          {providers.map((provider) => {
            const active = provider.id === currentId;
            return (
              <div
                key={provider.id}
                className={cn(
                  "bg-card flex flex-col gap-3 rounded-xl border p-4 shadow-sm transition-colors",
                  active && "border-primary ring-primary/20 ring-1"
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">{provider.name}</span>
                      {active && (
                        <Badge className="gap-1" variant="secondary">
                          <Check className="size-3" />
                          使用中
                        </Badge>
                      )}
                    </div>
                    {provider.websiteUrl && (
                      <a
                        href={provider.websiteUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="text-muted-foreground mt-0.5 block truncate text-xs hover:underline"
                      >
                        {provider.websiteUrl}
                      </a>
                    )}
                  </div>
                  {provider.category && (
                    <Badge variant="outline" className="shrink-0 text-xs">
                      {provider.category}
                    </Badge>
                  )}
                </div>

                <div className="mt-auto flex items-center gap-1.5">
                  <Button
                    size="sm"
                    variant={active ? "secondary" : "default"}
                    className="flex-1"
                    disabled={active || busyId === provider.id}
                    onClick={() => handleSwitch(provider)}
                  >
                    {active ? "当前使用" : "切换"}
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    disabled={busyId === provider.id}
                    onClick={() => openEdit(provider)}
                  >
                    <Pencil className="size-4" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    disabled={busyId === provider.id}
                    onClick={() => handleCopy(provider)}
                  >
                    <Copy className="size-4" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="text-destructive hover:text-destructive"
                    disabled={busyId === provider.id}
                    onClick={() => handleDelete(provider)}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {currentApp && dialogOpen && (
        <ProviderDialog
          key={`${currentApp}-${editing?.id ?? "new"}`}
          app={currentApp}
          editing={editing}
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          onSaved={() => loadProviders(currentApp)}
        />
      )}

      {currentApp && importOpen && (
        <ProviderImportDialog
          app={currentApp}
          open={importOpen}
          onOpenChange={setImportOpen}
          onImported={() => loadProviders(currentApp)}
        />
      )}
    </div>
  );
}
