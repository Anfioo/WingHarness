import { useCallback, useMemo, useState } from "react";
import { AlertTriangle, Loader2, Package, Plus, ScanSearch } from "lucide-react";
import { toast } from "sonner";
import { frpRuntimeDelete, frpRuntimeImport, frpRuntimesDiscover } from "@/commands/services/frp";
import {
  isFrpError,
  type DiscoveredRuntime,
  type RuntimeRecord,
  type RuntimeView,
} from "@/commands/services/frp/types";
import { DiscoveredList } from "@/components/frp/discovered-list";
import { RuntimeInstaller } from "@/components/runtime/runtime-installer";
import { RuntimeCard } from "@/components/frp/runtime-card";
import { RuntimeImportDialog } from "@/components/frp/runtime-import-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { FrpWorkspace } from "@/hooks/use-frp-workspace";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { formatVersion, frpFailureKey } from "@/lib/frp/format";

const ACTIVE_STATES = new Set(["starting", "running", "reconnecting", "stopping"]);

type ScanMode = "quick" | "deep";

export type RuntimeTabProps = {
  workspace: FrpWorkspace;
};

/**
 * The runtime tab: installed frpc records, import via a file picker, and the
 * local discovery scan. Deleting removes the record only; the binary stays.
 */
export function RuntimeTab({ workspace }: RuntimeTabProps) {
  const { t } = useAppTranslation();

  const [importOpen, setImportOpen] = useState(false);
  const [scanMode, setScanMode] = useState<ScanMode | null>(null);
  const [lastScanMode, setLastScanMode] = useState<ScanMode>("quick");
  const [discovered, setDiscovered] = useState<DiscoveredRuntime[] | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [busyRuntimeId, setBusyRuntimeId] = useState<string | null>(null);
  const [importingPath, setImportingPath] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<RuntimeView | null>(null);

  const describe = useCallback(
    (failure: unknown): string => {
      const key = frpFailureKey(failure);
      if (!key) return failure instanceof Error ? failure.message : String(failure);
      const message = isFrpError(failure) ? failure.message.trim() : "";
      return message ? `${t(key)}: ${message}` : t(key);
    },
    [t]
  );

  const runningRuntimeIds = useMemo(() => {
    const ids = new Set<string>();
    for (const snapshot of Object.values(workspace.snapshots)) {
      if (snapshot.runtimeId && ACTIVE_STATES.has(snapshot.state)) ids.add(snapshot.runtimeId);
    }
    return ids;
  }, [workspace.snapshots]);

  const existingPaths = useMemo(
    () => workspace.runtimes.map((runtime) => runtime.path),
    [workspace.runtimes]
  );

  const runScan = async (mode: ScanMode) => {
    setLastScanMode(mode);
    setScanMode(mode);
    setScanError(null);
    try {
      const entries = await frpRuntimesDiscover(mode === "deep");
      setDiscovered(entries);
    } catch (failure) {
      setScanError(describe(failure));
    } finally {
      setScanMode(null);
    }
  };

  const recheck = async (runtime: RuntimeView) => {
    setBusyRuntimeId(runtime.id);
    try {
      const updated = await workspace.runAction(() => frpRuntimeImport(runtime.path));
      await workspace.reload();
      toast.success(t("frp.runtime.rechecked", { version: formatVersion(updated.version) }));
    } catch {
      // `runAction` already wrote the failure to the page-level banner.
    } finally {
      setBusyRuntimeId(null);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    const target = deleteTarget;

    setBusyRuntimeId(target.id);
    try {
      await workspace.runAction(() => frpRuntimeDelete(target.id));
      await workspace.reload();
      setDeleteTarget(null);
      toast.success(t("frp.runtime.deleted"));
    } catch {
      // `runAction` already wrote the failure to the page-level banner.
    } finally {
      setBusyRuntimeId(null);
    }
  };

  const markImported = (record: RuntimeRecord) => {
    setDiscovered((current) =>
      current
        ? current.map((entry) =>
            entry.path.toLowerCase() === record.path.toLowerCase()
              ? { ...entry, alreadyImported: true, runtimeId: record.id }
              : entry
          )
        : current
    );
  };

  const handleImported = (record: RuntimeRecord) => {
    markImported(record);
    void workspace.reload();
    toast.success(t("frp.runtime.imported", { version: formatVersion(record.version) }));
  };

  const importDiscovered = async (entry: DiscoveredRuntime) => {
    setImportingPath(entry.path);
    try {
      const record = await workspace.runAction(() => frpRuntimeImport(entry.path));
      markImported(record);
      await workspace.reload();
      toast.success(t("frp.runtime.imported", { version: formatVersion(record.version) }));
    } catch {
      // `runAction` already wrote the failure to the page-level banner.
    } finally {
      setImportingPath(null);
    }
  };

  const deleteBusy = deleteTarget !== null && busyRuntimeId === deleteTarget.id;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 className="text-sm font-medium">{t("frp.runtime.title")}</h2>
          <p className="text-muted-foreground text-xs">{t("frp.runtime.subtitle")}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => setImportOpen(true)}>
            <Plus />
            {t("frp.runtime.action.import")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={scanMode !== null}
            onClick={() => void runScan("quick")}
          >
            {scanMode === "quick" ? <Loader2 className="animate-spin" /> : <ScanSearch />}
            {t("frp.runtime.action.rescan")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={scanMode !== null}
            onClick={() => void runScan("deep")}
          >
            {scanMode === "deep" ? <Loader2 className="animate-spin" /> : <ScanSearch />}
            {t("frp.runtime.action.deepScan")}
          </Button>
        </div>
      </div>

      <p className="text-muted-foreground text-xs">{t("frp.runtime.scanHint")}</p>

      {/* The official build is a fixed entry: it cannot be deleted, and the
          three install paths always target `frp/frpc.exe`. Other frpc builds
          remain ordinary records below. */}
      <RuntimeInstaller
        kind="frp"
        title={t("runtime.frp.title")}
        description={t("runtime.frp.description")}
        hint={t("runtime.frpHint")}
        official
        onInstalled={() => void workspace.reload()}
      />

      {workspace.runtimes.length === 0 ? (
        <div className="border-border text-muted-foreground flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed p-8 text-center text-sm">
          <Package className="size-8" />
          <p className="text-foreground font-medium">{t("frp.runtime.empty.title")}</p>
          <p className="max-w-md">{t("frp.runtime.empty.description")}</p>
          <Button size="sm" onClick={() => setImportOpen(true)}>
            {t("frp.runtime.action.import")}
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {workspace.runtimes.map((runtime) => (
            <RuntimeCard
              key={runtime.id}
              runtime={runtime}
              running={runningRuntimeIds.has(runtime.id)}
              busy={busyRuntimeId === runtime.id}
              onRecheck={() => void recheck(runtime)}
              onDelete={() => setDeleteTarget(runtime)}
            />
          ))}
        </div>
      )}

      {scanError && (
        <div className="border-destructive/40 bg-destructive/5 flex flex-wrap items-center gap-2 rounded-lg border p-3 text-sm">
          <AlertTriangle className="text-destructive size-4 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="text-destructive font-medium">{t("frp.runtime.scanFailed")}</p>
            <p className="text-destructive/80 text-xs break-words">{scanError}</p>
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={scanMode !== null}
            onClick={() => void runScan(lastScanMode)}
          >
            {scanMode !== null ? <Loader2 className="animate-spin" /> : null}
            {t("frp.common.retry")}
          </Button>
        </div>
      )}

      {discovered !== null && !scanError && (
        <section className="flex flex-col gap-2">
          <h3 className="text-foreground text-sm font-medium">{t("frp.runtime.discovered")}</h3>
          <DiscoveredList
            entries={discovered}
            importingPath={importingPath}
            onImport={(entry) => void importDiscovered(entry)}
          />
        </section>
      )}

      <RuntimeImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        existingPaths={existingPaths}
        onImported={handleImported}
      />

      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(next) => {
          if (!next) setDeleteTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("frp.runtime.deleteTitle")}</DialogTitle>
            <DialogDescription>{t("frp.runtime.deleteDescription")}</DialogDescription>
          </DialogHeader>
          <p className="text-muted-foreground font-mono text-xs break-all">{deleteTarget?.path}</p>
          <DialogFooter>
            <Button variant="outline" disabled={deleteBusy} onClick={() => setDeleteTarget(null)}>
              {t("frp.common.cancel")}
            </Button>
            <Button
              variant="destructive"
              disabled={deleteBusy}
              onClick={() => void confirmDelete()}
            >
              {deleteBusy && <Loader2 className="animate-spin" />}
              {t("frp.runtime.delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
