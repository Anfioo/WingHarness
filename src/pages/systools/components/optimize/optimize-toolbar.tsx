import { History, Loader2, RefreshCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAppTranslation } from "@/hooks/use-app-translation";

type OptimizeToolbarProps = {
  scanning: boolean;
  cancelling: boolean;
  busy: boolean;
  hasScanned: boolean;
  recoveryAvailable: boolean;
  restoring: boolean;
  onScan: () => void;
  onCancelScan: () => void;
  onRestore: () => void;
};

/** Title, recovery entry, and the scan/refresh action. */
export function OptimizeToolbar({
  scanning,
  cancelling,
  busy,
  hasScanned,
  recoveryAvailable,
  restoring,
  onScan,
  onCancelScan,
  onRestore,
}: OptimizeToolbarProps) {
  const { t } = useAppTranslation();

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2">
      <div className="min-w-0">
        <h2 className="text-sm font-medium">{t("systools.optimize.title")}</h2>
        <p className="text-muted-foreground truncate text-xs">{t("systools.optimize.subtitle")}</p>
      </div>

      <div className="ml-auto flex items-center gap-2">
        {recoveryAvailable && (
          <Button variant="outline" size="sm" onClick={onRestore} disabled={busy}>
            {restoring ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <History className="size-4" />
            )}
            {restoring
              ? t("systools.optimize.rollback.restoring")
              : t("systools.optimize.rollback.restore")}
          </Button>
        )}

        {scanning ? (
          <Button variant="outline" size="sm" onClick={onCancelScan} disabled={cancelling}>
            <X className="size-4" />
            {t("systools.optimize.cancelScan")}
          </Button>
        ) : (
          <Button size="sm" onClick={onScan} disabled={busy}>
            <RefreshCw className="size-4" />
            {hasScanned ? t("systools.optimize.rescan") : t("systools.optimize.scan")}
          </Button>
        )}
      </div>
    </div>
  );
}
