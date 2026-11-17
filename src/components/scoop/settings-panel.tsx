import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Github, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useAppTranslation } from "@/hooks/use-app-translation";
import type { ScoopPageController } from "@/hooks/use-scoop-page";
import { useManualUpdateCheck } from "@/hooks/use-updater";
import { AUTHOR, REPO_URL } from "@/lib/app-meta";
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

      <ScoopCreditSection />
    </div>
  );
}

/**
 * The signature: which app this is, its version, its licence and where it
 * lives. Scoop's own settings are the two cards above; this one is about the
 * app carrying them.
 */
function ScoopCreditSection() {
  const { t } = useAppTranslation();
  const [version, setVersion] = useState("");
  const { checkUpdate, checking, showNoUpdate } = useManualUpdateCheck();

  useEffect(() => {
    void getVersion().then(setVersion);
  }, []);

  return (
    <section className="border-border space-y-3 rounded-xl border p-4 lg:col-span-2">
      <div>
        <h2 className="text-sm font-semibold">{t("scoop.settings.creditTitle")}</h2>
        <p className="text-muted-foreground mt-1 text-xs">{t("scoop.settings.creditHint")}</p>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant="secondary">{t("about.appName")}</Badge>
        <Badge variant="outline" className="font-mono">
          {version ? `v${version}` : "—"}
        </Badge>
        <Badge variant="outline" className="font-mono">
          GPL-3.0-only
        </Badge>
        <span className="text-muted-foreground text-xs">
          {t("scoop.settings.creditAuthor", { name: AUTHOR.name })}
        </span>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={() => void openUrl(REPO_URL)}>
          <Github />
          {t("scoop.settings.creditRepo")}
        </Button>
        <Button variant="outline" size="sm" disabled={checking} onClick={checkUpdate}>
          <RefreshCw className={checking ? "animate-spin" : undefined} />
          {checking ? t("updater.checking") : t("updater.checkForUpdates")}
        </Button>
        {showNoUpdate && (
          <span className="text-muted-foreground self-center text-xs">{t("updater.upToDate")}</span>
        )}
      </div>
    </section>
  );
}
