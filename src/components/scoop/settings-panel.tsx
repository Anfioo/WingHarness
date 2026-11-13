import { Button } from "@/components/ui/button";
import { useAppTranslation } from "@/hooks/use-app-translation";
import type { ScoopPageController } from "@/hooks/use-scoop-page";
import { InfoRow } from "./info-row";
import { ScoopPathRows } from "./path-rows";
import { ProxyPicker } from "./pickers";

/** Paths are fixed once Scoop is installed; the proxy can be re-synced. */
export function ScoopSettingsPanel({ page }: { page: ScoopPageController }) {
  const { t } = useAppTranslation();
  const status = page.status;
  const busy = page.running !== null || page.preparing;
  if (!status) return null;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <section className="border-border space-y-2 rounded-xl border p-4">
        <h2 className="text-sm font-semibold">{t("scoop.settings.locationTitle")}</h2>
        <ScoopPathRows status={status} />
        <InfoRow label={t("scoop.overview.dataDir")} value={status.dataDir} />
        <p className="text-muted-foreground text-xs">{t("scoop.settings.locationNote")}</p>
      </section>

      <section className="border-border space-y-3 rounded-xl border p-4">
        <div>
          <h2 className="text-sm font-semibold">{t("scoop.settings.proxyTitle")}</h2>
          <p className="text-muted-foreground mt-1 text-xs">{t("scoop.settings.proxyHint")}</p>
        </div>
        <ProxyPicker page={page} disabled={busy} />
        <Button variant="secondary" size="sm" disabled={busy} onClick={() => void page.syncProxy()}>
          {t("scoop.settings.syncProxy")}
        </Button>
      </section>
    </div>
  );
}
