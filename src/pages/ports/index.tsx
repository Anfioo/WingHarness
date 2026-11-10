import { AppShell } from "@/components/app-shell";
import { PortDetailSheet } from "@/components/ports/ports-detail-sheet";
import { PortsList } from "@/components/ports/ports-list";
import { PortsStats } from "@/components/ports/ports-stats";
import { PortsToolbar } from "@/components/ports/ports-toolbar";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { usePortsPage } from "@/hooks/use-ports-page";
import { portsErrorKey } from "@/lib/ports/error-key";

/**
 * The ports page shell: the header, the load error row, and the assembly of the
 * three component lanes around the page hook.
 */
export default function PortsPage() {
  const { t } = useAppTranslation();
  const page = usePortsPage();

  return (
    <AppShell>
      <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col gap-4">
        <header className="space-y-1">
          <h1 className="text-xl font-semibold">{t("ports.title")}</h1>
          <p className="text-muted-foreground text-sm">{t("ports.subtitle")}</p>
        </header>

        {page.error && (
          <div
            role="alert"
            className="border-destructive/40 bg-destructive/5 text-destructive rounded-lg border px-3 py-2 text-sm"
          >
            {t("ports.error.load")} {t(portsErrorKey(page.error.code))}
          </div>
        )}

        <PortsStats counts={page.counts} />

        <PortsToolbar
          query={page.query}
          onQueryChange={page.setQuery}
          statuses={page.statuses}
          onToggleStatus={page.toggleStatus}
          groupBy={page.groupBy}
          onGroupingChange={(grouping) => void page.setGrouping(grouping)}
          refreshing={page.refreshing}
          updatedAt={page.updatedAt}
          paused={page.paused}
          onRefresh={page.refresh}
        />

        <PortsList
          pinned={page.pinned}
          others={page.others}
          query={page.query}
          pinnedOnly={page.settings?.pinnedOnly ?? false}
          groupBy={page.groupBy}
          loading={page.loading}
          onOpenDetail={page.openDetail}
          onKill={(pid) => void page.kill(pid)}
          onTogglePin={(port) => void page.togglePin(port)}
        />

        <PortDetailSheet
          port={page.detailPort}
          onOpenChange={(open) => {
            if (!open) page.closeDetail();
          }}
          onKill={(pid) => void page.kill(pid)}
        />
      </div>
    </AppShell>
  );
}
