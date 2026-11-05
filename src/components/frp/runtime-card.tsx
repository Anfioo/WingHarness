import { Loader2, RotateCw, Trash2 } from "lucide-react";
import type { RuntimeView } from "@/commands/services/frp/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { formatBytes, formatTimestamp, formatVersion } from "@/lib/frp/format";

export type RuntimeCardProps = {
  runtime: RuntimeView;
  /** A live frpc process was launched from this runtime. */
  running: boolean;
  busy: boolean;
  onRecheck: () => void;
  onDelete: () => void;
};

/** One installed runtime: identity, usage, and the two record-level actions. */
export function RuntimeCard({ runtime, running, busy, onRecheck, onDelete }: RuntimeCardProps) {
  const { t } = useAppTranslation();

  const blocked = running || runtime.inUse;
  const blockReason = running
    ? t("frp.runtime.runningInUse")
    : runtime.inUse
      ? t("frp.runtime.inUseBy", { count: runtime.profileCount })
      : null;

  return (
    <div className="border-border bg-card flex flex-col gap-2 rounded-lg border p-3">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="text-sm font-semibold">{formatVersion(runtime.version)}</span>
        {runtime.inUse && <Badge variant="secondary">{t("frp.runtime.inUse")}</Badge>}
        {running && (
          <Badge
            variant="outline"
            className="border-emerald-500/40 text-emerald-700 dark:text-emerald-400"
          >
            {t("frp.status.running")}
          </Badge>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-1">
          <Button
            size="xs"
            variant="outline"
            disabled={busy}
            onClick={onRecheck}
            title={t("frp.runtime.recheck")}
          >
            {busy ? <Loader2 className="animate-spin" /> : <RotateCw />}
            {t("frp.runtime.recheck")}
          </Button>
          <Button
            size="xs"
            variant="outline"
            disabled={busy || blocked}
            onClick={onDelete}
            title={blockReason ?? t("frp.runtime.delete")}
          >
            <Trash2 />
            {t("frp.runtime.delete")}
          </Button>
        </span>
      </div>

      <p className="text-muted-foreground truncate font-mono text-xs" title={runtime.path}>
        {runtime.path}
      </p>

      <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <span>
          {t("frp.runtime.col.platform")}: {runtime.platform} / {runtime.architecture}
        </span>
        <span>
          {t("frp.runtime.col.size")}:{" "}
          <span className="tabular-nums">{formatBytes(runtime.sizeBytes)}</span>
        </span>
        <span>
          {t("frp.runtime.col.usage")}: {t("frp.runtime.inUseBy", { count: runtime.profileCount })}
        </span>
        <span>
          {t("frp.runtime.col.added")}: {formatTimestamp(runtime.addedAt)}
        </span>
      </div>

      {blockReason && <p className="text-muted-foreground text-xs">{blockReason}</p>}
    </div>
  );
}
