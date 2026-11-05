import { useEffect, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useAppTranslation } from "@/hooks/use-app-translation";
import type { ApplicationUninstallCandidate } from "@/lib/systools/applications";
import { ApplicationRow, APPLICATION_ROW_HEIGHT } from "./application-row";

type ApplicationListProps = {
  applications: ApplicationUninstallCandidate[];
  selectedIds: ReadonlySet<string>;
  icons: ReadonlyMap<string, string>;
  /** Changes whenever the filter or sort changes so the list scrolls back up. */
  resetKey: string;
  disabledReason: (candidate: ApplicationUninstallCandidate) => string | null;
  onToggle: (applicationId: string) => void;
  onOpen: (applicationId: string) => void;
};

/** Virtualized catalog table; rows keep a fixed height so scrolling stays cheap. */
export function ApplicationList({
  applications,
  selectedIds,
  icons,
  resetKey,
  disabledReason,
  onToggle,
  onOpen,
}: ApplicationListProps) {
  const { t } = useAppTranslation();
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const virtualizer = useVirtualizer({
    count: applications.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => APPLICATION_ROW_HEIGHT,
    getItemKey: (index) => applications[index].applicationId,
    overscan: 8,
  });

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [resetKey]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="text-muted-foreground grid h-8 shrink-0 grid-cols-[20px_32px_minmax(0,1fr)_auto] items-center gap-3 border-b px-2 text-xs">
        <span />
        <span />
        <span>{t("systools.uninstall.columns.name")}</span>
        <span className="flex items-center justify-end gap-3">
          <span className="hidden w-24 text-right md:block">
            {t("systools.uninstall.columns.installed")}
          </span>
          <span className="w-20 text-right">{t("systools.uninstall.columns.size")}</span>
          <span className="min-w-16 text-center">{t("systools.uninstall.columns.status")}</span>
        </span>
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto px-1">
        <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((item) => {
            const candidate = applications[item.index];
            const reason = disabledReason(candidate);
            return (
              <div
                key={item.key}
                className="absolute top-0 left-0 w-full"
                style={{ transform: `translateY(${item.start}px)` }}
              >
                <ApplicationRow
                  candidate={candidate}
                  iconSrc={candidate.iconPath ? icons.get(candidate.iconPath) : undefined}
                  selected={selectedIds.has(candidate.applicationId)}
                  disabled={reason !== null}
                  disabledReason={reason}
                  onToggle={() => onToggle(candidate.applicationId)}
                  onOpen={() => onOpen(candidate.applicationId)}
                />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
