import { Button } from "@/components/ui/button";
import { useAppTranslation } from "@/hooks/use-app-translation";
import type { ScoopPageController } from "@/hooks/use-scoop-page";
import { chosenPath, proxySummary, samePath } from "@/lib/scoop/page";
import { InfoRow } from "./info-row";
import { PathPicker, ProxyPicker } from "./pickers";

/** The first-run screen: two folders, proxy, what will be written, install. */
export function ScoopInstallPanel({ page }: { page: ScoopPageController }) {
  const { t } = useAppTranslation();
  const busy = page.running !== null || page.preparing;
  const status = page.status;
  const scoopTarget = chosenPath("scoop", page.prefs.scoop, status);
  const globalTarget = chosenPath("global", page.prefs.global, status);
  const scoopRoot = status?.root ?? "";
  const globalRoot = status?.globalRoot ?? "";
  const proxy = proxySummary(page.prefs, status);
  const proxyText =
    proxy.url ?? (proxy.mode === "none" ? t("scoop.proxy.direct") : t("scoop.proxy.system"));

  const linkValue = (link: string, target: string) => {
    if (!link || !target) return link || target || "—";
    return samePath(link, target)
      ? t("scoop.install.samePath")
      : t("scoop.install.linkValue", { link, target });
  };

  const envValue = (link: string, target: string) =>
    target ? t("scoop.install.envValue", { link, target }) : link || "—";

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <section className="border-border space-y-4 rounded-xl border p-4">
          <h2 className="text-sm font-semibold">{t("scoop.install.locationTitle")}</h2>
          <PathPicker page={page} kind="scoop" disabled={busy} />
          <div className="border-border border-t pt-4">
            <PathPicker page={page} kind="global" disabled={busy} />
          </div>
        </section>

        <section className="border-border space-y-3 rounded-xl border p-4">
          <div>
            <h2 className="text-sm font-semibold">{t("scoop.install.proxyTitle")}</h2>
            <p className="text-muted-foreground mt-1 text-xs">{t("scoop.install.proxyHint")}</p>
          </div>
          <ProxyPicker page={page} disabled={busy} />
        </section>
      </div>

      <section className="border-border space-y-2 rounded-xl border p-4">
        <h2 className="text-sm font-semibold">{t("scoop.install.summaryTitle")}</h2>

        <div className="space-y-2">
          <InfoRow label={t("scoop.install.scoopFolder")} value={scoopTarget} />
          <InfoRow label={t("scoop.install.globalFolder")} value={globalTarget} />
          <InfoRow label={t("scoop.install.scoopLink")} value={linkValue(scoopRoot, scoopTarget)} />
          <InfoRow
            label={t("scoop.install.globalLink")}
            value={linkValue(globalRoot, globalTarget)}
          />
          <InfoRow label={t("scoop.install.scoopEnv")} value={envValue(scoopRoot, scoopTarget)} />
          <InfoRow
            label={t("scoop.install.globalEnv")}
            value={envValue(globalRoot, globalTarget)}
          />
          <InfoRow label={t("scoop.install.proxy")} value={proxyText} />
        </div>

        <p className="text-muted-foreground text-xs">{t("scoop.install.linkNote")}</p>
        <p className="text-muted-foreground text-xs">{t("scoop.install.envHint")}</p>
        <p className="text-muted-foreground text-xs">{t("scoop.install.steps")}</p>
        <Button
          disabled={busy || !scoopTarget || !globalTarget}
          onClick={() => void page.prepareInstall()}
        >
          {page.preparing
            ? t("scoop.install.preparing")
            : page.running === "install"
              ? t("scoop.install.starting")
              : t("scoop.install.start")}
        </Button>
      </section>

      {status?.otherInstall && (
        <section className="border-border bg-muted/30 space-y-3 rounded-xl border p-4">
          <div>
            <h2 className="text-sm font-semibold">{t("scoop.install.adoptTitle")}</h2>
            <p className="text-muted-foreground mt-1 text-xs">
              {t("scoop.install.adoptHint", { path: status.otherInstall })}
            </p>
          </div>
          <Button variant="secondary" size="sm" disabled={busy} onClick={() => void page.adopt()}>
            {t("scoop.install.adopt")}
          </Button>
        </section>
      )}

      <p className="text-muted-foreground text-xs">{t("scoop.install.note")}</p>
    </div>
  );
}
