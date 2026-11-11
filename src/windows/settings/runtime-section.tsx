import { RuntimeInstaller } from "@/components/runtime/runtime-installer";
import { useAppTranslation } from "@/hooks/use-app-translation";

/** Both runtimes in one place; the Clash and FRP pages link here when missing. */
export function RuntimeSection() {
  const { t } = useAppTranslation();

  return (
    <div className="space-y-4">
      <div>
        <h2 className="mb-1 text-lg font-semibold">{t("runtime.title")}</h2>
        <p className="text-muted-foreground text-sm">{t("runtime.description")}</p>
      </div>

      <RuntimeInstaller
        kind="clash"
        title={t("runtime.clash.title")}
        description={t("runtime.clash.description")}
      />

      <RuntimeInstaller
        kind="frp"
        title={t("runtime.frp.title")}
        description={t("runtime.frp.description")}
        hint={t("runtime.frpHint")}
        official
      />
    </div>
  );
}
