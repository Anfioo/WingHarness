import { useCallback, useEffect, useState } from "react";
import { FileSearch, Loader2 } from "lucide-react";
import { open as pickFile } from "@tauri-apps/plugin-dialog";
import { frpRuntimeImport, frpRuntimeProbe } from "@/commands/services/frp";
import { isFrpError, type RuntimeProbe, type RuntimeRecord } from "@/commands/services/frp/types";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { formatVersion, frpFailureKey } from "@/lib/frp/format";

export type RuntimeImportDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Paths already in the workspace, so a repeat selection can say so. */
  existingPaths: string[];
  /** Called after a successful import; the caller reloads the workspace. */
  onImported: (runtime: RuntimeRecord) => void;
};

const FRPC_FILTERS = [{ name: "frpc", extensions: ["exe"] }];

/**
 * Pick an existing frpc binary, probe it without persisting, then import only
 * after the user confirms. Nothing here downloads anything.
 */
export function RuntimeImportDialog({
  open,
  onOpenChange,
  existingPaths,
  onImported,
}: RuntimeImportDialogProps) {
  const { t } = useAppTranslation();

  const [path, setPath] = useState<string | null>(null);
  const [probe, setProbe] = useState<RuntimeProbe | null>(null);
  const [probing, setProbing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setPath(null);
    setProbe(null);
    setProbing(false);
    setImporting(false);
    setError(null);
  }, [open]);

  const describe = useCallback(
    (failure: unknown): string => {
      const key = frpFailureKey(failure);
      if (!key) return failure instanceof Error ? failure.message : String(failure);
      const message = isFrpError(failure) ? failure.message.trim() : "";
      return message ? `${t(key)}: ${message}` : t(key);
    },
    [t]
  );

  const choose = async () => {
    setError(null);
    const picked = await pickFile({
      multiple: false,
      directory: false,
      filters: FRPC_FILTERS,
    });
    if (typeof picked !== "string") return;

    setPath(picked);
    setProbe(null);
    setProbing(true);
    try {
      const result = await frpRuntimeProbe(picked);
      setProbe(result);
    } catch (failure) {
      setError(describe(failure));
    } finally {
      setProbing(false);
    }
  };

  const confirm = async () => {
    if (!path || !probe?.valid) return;

    setImporting(true);
    setError(null);
    try {
      const record = await frpRuntimeImport(path);
      onImported(record);
      onOpenChange(false);
    } catch (failure) {
      setError(describe(failure));
    } finally {
      setImporting(false);
    }
  };

  const duplicate =
    path !== null &&
    existingPaths.some((existing) => existing.toLowerCase() === path.toLowerCase());

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("frp.runtime.action.import")}</DialogTitle>
          <DialogDescription>{t("frp.runtime.empty.description")}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <Input
              readOnly
              value={path ?? ""}
              placeholder={t("frp.runtime.noFile")}
              aria-label={t("frp.runtime.noFile")}
              className="font-mono text-xs"
            />
            <Button
              variant="outline"
              size="sm"
              disabled={probing || importing}
              onClick={() => void choose()}
            >
              {probing ? <Loader2 className="animate-spin" /> : <FileSearch />}
              {t("frp.runtime.chooseFile")}
            </Button>
          </div>

          {duplicate && (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              {t("frp.runtime.alreadyImported")}
            </p>
          )}

          {error && <p className="text-destructive text-sm break-words">{error}</p>}

          {probe && (
            <div className="rounded-lg border p-3 text-sm">
              <p
                className={
                  probe.valid ? "text-emerald-600 dark:text-emerald-400" : "text-destructive"
                }
              >
                {probe.valid ? t("frp.runtime.probe.valid") : t("frp.runtime.probe.invalid")}
              </p>
              <dl className="text-muted-foreground mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                <dt>{t("frp.runtime.probe.version")}</dt>
                <dd className="font-mono">{formatVersion(probe.version)}</dd>
                <dt>{t("frp.runtime.probe.platform")}</dt>
                <dd className="font-mono">{probe.platform ?? "—"}</dd>
                <dt>{t("frp.runtime.probe.architecture")}</dt>
                <dd className="font-mono">{probe.architecture ?? "—"}</dd>
                {probe.error && (
                  <>
                    <dt>{t("frp.runtime.probe.error")}</dt>
                    <dd className="text-destructive break-words">{probe.error}</dd>
                  </>
                )}
              </dl>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" disabled={importing} onClick={() => onOpenChange(false)}>
            {t("frp.common.cancel")}
          </Button>
          <Button disabled={!probe?.valid || probing || importing} onClick={() => void confirm()}>
            {importing && <Loader2 className="animate-spin" />}
            {t("frp.common.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
