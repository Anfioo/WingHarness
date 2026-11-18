import { createPortal } from "react-dom";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { formatBytes, formatShare } from "@/lib/systools/format";
import type { DirectoryEntryInfo } from "@/lib/systools/storage";
import { AnalysisEntryIcon } from "./entry-icon";

type EntryHoverCardProps = {
  entry: DirectoryEntryInfo;
  /** Bytes of the folder the entry is listed in. */
  folderBytes: number;
  /** Bytes of that folder's parent; null at the scan root. */
  parentBytes: number | null;
  x: number;
  y: number;
};

const CARD_WIDTH = 288;
const CARD_HEIGHT = 150;

/** Cursor tooltip with the entry's icon, size shares and full path. */
export function EntryHoverCard({ entry, folderBytes, parentBytes, x, y }: EntryHoverCardProps) {
  const { t, language } = useAppTranslation();

  const left = Math.max(8, Math.min(x + 16, window.innerWidth - CARD_WIDTH - 8));
  const top =
    y + 16 + CARD_HEIGHT > window.innerHeight
      ? Math.max(8, y - CARD_HEIGHT - 16)
      : Math.max(8, y + 16);

  return createPortal(
    <div
      role="tooltip"
      className="bg-popover text-popover-foreground pointer-events-none fixed z-50 w-72 rounded-lg border p-3 shadow-lg"
      style={{ left, top }}
    >
      <div className="flex items-start gap-2.5">
        <AnalysisEntryIcon entry={entry} className="size-9" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium" title={entry.name}>
            {entry.name}
          </p>
          <p className="text-muted-foreground text-[11px]">
            {formatBytes(entry.bytes, language)}
            {" · "}
            {t("systools.analysis.fileCount", { count: entry.fileCount })}
          </p>
        </div>
      </div>

      <dl className="mt-2 space-y-1 text-[11px]">
        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-muted-foreground">{t("systools.analysis.shareOfCurrentFolder")}</dt>
          <dd className="tabular-nums">{formatShare(entry.bytes, folderBytes, language)}</dd>
        </div>
        {parentBytes !== null && (
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-muted-foreground">{t("systools.analysis.shareOfParentFolder")}</dt>
            <dd className="tabular-nums">{formatShare(entry.bytes, parentBytes, language)}</dd>
          </div>
        )}
      </dl>

      <p className="text-muted-foreground mt-2 border-t pt-2 text-[10px] break-all">{entry.path}</p>
    </div>,
    document.body
  );
}
