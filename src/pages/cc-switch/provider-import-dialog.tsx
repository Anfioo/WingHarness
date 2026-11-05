import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { ccsImportPreview, ccsImportSave, ccsPickImportFile } from "@/commands";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import type { AppId, ImportedProvider, ImportSource } from "@/commands/services/ccs/types";

interface ProviderImportDialogProps {
  app: AppId;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported: () => void;
}

const SOURCES: { id: ImportSource; label: string }[] = [
  { id: "live", label: "本机配置" },
  { id: "ccswitch", label: "cc-switch 数据库" },
  { id: "json", label: "JSON 文件" },
];

export function ProviderImportDialog({
  app,
  open,
  onOpenChange,
  onImported,
}: ProviderImportDialogProps) {
  const [source, setSource] = useState<ImportSource>("live");
  const [providers, setProviders] = useState<ImportedProvider[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(
    async (src: ImportSource, path?: string) => {
      setLoading(true);
      try {
        const list = await ccsImportPreview(app, src, path);
        setProviders(list);
        setSelected(new Set(list.map((p) => p.id)));
      } catch (error) {
        toast.error(String(error));
        setProviders([]);
        setSelected(new Set());
      } finally {
        setLoading(false);
      }
    },
    [app]
  );

  useEffect(() => {
    if (open) {
      setSource("live");
      void load("live");
    }
  }, [open, load]);

  // JSON 文件需要先选文件；cc-switch 数据库默认路径不存在时也可自选。
  const chooseSource = async (src: ImportSource) => {
    setSource(src);
    if (src === "json") {
      const path = await ccsPickImportFile("json");
      if (path) void load("json", path);
      return;
    }
    void load(src);
  };

  const browse = async () => {
    const path = await ccsPickImportFile(source === "json" ? "json" : "db");
    if (path) void load(source, path);
  };

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const allSelected = providers.length > 0 && selected.size === providers.length;
  const toggleAll = () =>
    setSelected(allSelected ? new Set() : new Set(providers.map((p) => p.id)));

  const newCount = providers.filter((p) => p.status === "new").length;
  const updateCount = providers.length - newCount;

  const handleSave = async () => {
    const picked = providers.filter((p) => selected.has(p.id));
    if (picked.length === 0) return;
    setSaving(true);
    try {
      const n = await ccsImportSave(app, picked);
      toast.success(`已导入 ${n} 个供应商`);
      onImported();
      onOpenChange(false);
    } catch (error) {
      toast.error(String(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>导入供应商</DialogTitle>
          <DialogDescription>从以下来源导入供应商。</DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-2">
          {SOURCES.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => void chooseSource(s.id)}
              className={cn(
                "rounded-md border px-3 py-1.5 text-sm transition-colors",
                source === s.id
                  ? "border-primary bg-primary text-primary-foreground"
                  : "bg-card hover:bg-accent"
              )}
            >
              {s.label}
            </button>
          ))}
          {(source === "ccswitch" || source === "json") && (
            <Button type="button" variant="outline" size="sm" onClick={() => void browse()}>
              选择文件…
            </Button>
          )}
        </div>

        {loading ? (
          <div className="text-muted-foreground py-10 text-center text-sm">读取中…</div>
        ) : providers.length === 0 ? (
          <div className="border-card rounded-xl border border-dashed py-10 text-center">
            <p className="text-muted-foreground text-sm">没有可导入的供应商。</p>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="text-muted-foreground flex items-center gap-3 text-xs">
              <span>共 {providers.length} 个</span>
              <span className="text-emerald-600 dark:text-emerald-400">新增 {newCount}</span>
              <span className="text-amber-600 dark:text-amber-400">更新 {updateCount}</span>
            </div>

            <div className="border-card divide-border overflow-hidden rounded-xl border">
              <div className="bg-muted/50 flex items-center gap-3 px-3 py-2 text-xs font-medium">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={toggleAll}
                  className="accent-primary size-4"
                />
                <span className="flex-1">名称</span>
                <span className="w-40 shrink-0 truncate">ID</span>
                <span className="w-16 shrink-0 text-right">状态</span>
              </div>
              <div className="divide-border max-h-[45vh] divide-y overflow-y-auto">
                {providers.map((p) => (
                  <label
                    key={p.id}
                    className="hover:bg-accent/40 flex cursor-pointer items-center gap-3 px-3 py-2"
                  >
                    <input
                      type="checkbox"
                      checked={selected.has(p.id)}
                      onChange={() => toggle(p.id)}
                      className="accent-primary size-4"
                    />
                    <span className="flex-1 truncate text-sm">{p.name}</span>
                    <span className="text-muted-foreground w-40 shrink-0 truncate font-mono text-xs">
                      {p.id}
                    </span>
                    <span className="w-16 shrink-0 text-right">
                      <span
                        className={cn(
                          "rounded-full px-2 py-0.5 text-xs",
                          p.status === "new"
                            ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                            : "bg-amber-500/10 text-amber-600 dark:text-amber-400"
                        )}
                      >
                        {p.status === "new" ? "新增" : "更新"}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            </div>
          </div>
        )}

        <DialogFooter>
          <span className="text-muted-foreground mr-auto self-center text-xs">
            已选 {selected.size} 个
          </span>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            取消
          </Button>
          <Button onClick={handleSave} disabled={saving || selected.size === 0}>
            导入
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
