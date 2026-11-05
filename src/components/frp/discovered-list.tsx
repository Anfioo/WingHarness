import { Check, Download, Loader2 } from "lucide-react";
import type { DiscoveredRuntime } from "@/commands/services/frp/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { formatVersion } from "@/lib/frp/format";

const SOURCE_KEYS: Record<string, string> = {
  path: "frp.runtime.source.path",
  common: "frp.runtime.source.common",
  deep: "frp.runtime.source.deep",
};

export type DiscoveredListProps = {
  entries: DiscoveredRuntime[];
  /** Path currently being imported, if any. */
  importingPath: string | null;
  onImport: (entry: DiscoveredRuntime) => void;
};

/** Results of a local scan, each with a one-click import. */
export function DiscoveredList({ entries, importingPath, onImport }: DiscoveredListProps) {
  const { t } = useAppTranslation();

  if (entries.length === 0) {
    return (
      <div className="border-border text-muted-foreground rounded-lg border border-dashed p-6 text-center text-sm">
        {t("frp.runtime.noneFound")}
      </div>
    );
  }

  return (
    <ul className="flex flex-col gap-1" role="list">
      {entries.map((entry) => {
        const busy = importingPath === entry.path;
        const sourceKey = SOURCE_KEYS[entry.source];
        return (
          <li
            key={entry.path}
            className="border-border flex flex-wrap items-center gap-2 rounded-md border px-2 py-1.5 text-xs"
          >
            <span className="font-mono font-medium">{formatVersion(entry.version)}</span>
            <Badge variant="outline" className="text-[10px]">
              {sourceKey ? t(sourceKey) : entry.source}
            </Badge>
            <span className="text-muted-foreground">
              {entry.platform ?? "—"} / {entry.architecture ?? "—"}
            </span>
            <span
              className="text-muted-foreground min-w-0 flex-1 truncate font-mono"
              title={entry.path}
            >
              {entry.path}
            </span>
            {entry.alreadyImported ? (
              <span className="text-muted-foreground flex items-center gap-1">
                <Check className="size-3" />
                {t("frp.runtime.alreadyImported")}
              </span>
            ) : (
              <Button size="xs" disabled={importingPath !== null} onClick={() => onImport(entry)}>
                {busy ? <Loader2 className="animate-spin" /> : <Download />}
                {t("frp.runtime.importOne")}
              </Button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
