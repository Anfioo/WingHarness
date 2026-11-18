// Part of the one-mail module, adapted from OneMail
// (https://github.com/zhihui-hu/one-mail), AGPL-3.0-only.
// See `src-tauri/one-mail-core/UPSTREAM.md` for the porting record.

import { useAppTranslation } from "@/hooks/use-app-translation";

/**
 * The mail partition of the Settings window.
 *
 * A0 placeholder: only the title and a loading line. F3 replaces this file with
 * the refresh interval, body display, remote image policy and notification
 * controls.
 */
export function OneMailSection() {
  const { t } = useAppTranslation();

  return (
    <section className="space-y-2">
      <h2 className="text-lg font-semibold">{t("oneMail.settings.title")}</h2>
      <p className="text-muted-foreground text-sm">{t("oneMail.common.loading")}</p>
    </section>
  );
}
