import { AppShell } from "@/components/app-shell";
import { useAppTranslation } from "@/hooks/use-app-translation";

/**
 * The AI config page while its engine is rebuilt.
 *
 * The route and this file stay in place so the sidebar entry keeps working;
 * only the content is gone until the new asset store lands.
 */
export default function AiConfigPage() {
  const { t } = useAppTranslation();

  return (
    <AppShell>
      <div className="flex min-h-0 w-full min-w-0 flex-1 items-center justify-center">
        <div className="max-w-md space-y-2 text-center">
          <h1 className="text-xl font-semibold">{t("aiConfig.underConstruction.title")}</h1>
          <p className="text-muted-foreground text-sm">
            {t("aiConfig.underConstruction.description")}
          </p>
        </div>
      </div>
    </AppShell>
  );
}
