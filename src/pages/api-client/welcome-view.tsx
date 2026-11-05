import { FileJson2, ListTree, Send } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { showApiHome } from "@/lib/api-windows";

/**
 * What a workspace window shows with no `?id=` — guidance for starting from
 * nothing: pull in an OpenAPI/Swagger spec, or build a request by hand inside a
 * collection. Both happen in a workspace, so the one real action is going back
 * to the picker, which is a page of the main window.
 */
export function WelcomeView() {
  const { t } = useTranslation("translation", { keyPrefix: "apiClient.welcome" });

  return (
    <div className="flex flex-1 flex-col overflow-y-auto">
      <div className="animate-fade-in flex w-full flex-1 flex-col justify-center gap-6 px-6 py-10">
        <header className="flex items-center gap-3">
          <span className="bg-primary/10 text-primary flex size-12 shrink-0 items-center justify-center rounded-xl">
            <Send className="size-6" />
          </span>
          <div className="min-w-0">
            <h1 className="text-primary text-xl font-semibold tracking-tight">
              {t("header.brand")}
            </h1>
            <p className="text-muted-foreground text-sm">{t("header.tagline")}</p>
          </div>
        </header>

        <section className="border-border bg-card shadow-soft rounded-lg border p-5">
          <h2 className="text-sm font-medium">{t("guidance.title")}</h2>
          <p className="text-muted-foreground mt-1 text-xs leading-relaxed">
            {t("guidance.description")}
          </p>

          <ul className="mt-4 space-y-3">
            <li className="flex items-start gap-3">
              <span className="bg-primary/15 text-primary mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md">
                <FileJson2 className="size-4" />
              </span>
              <div className="min-w-0">
                <p className="text-sm font-medium">{t("guidance.importTitle")}</p>
                <p className="text-muted-foreground text-xs">{t("guidance.importHint")}</p>
              </div>
            </li>
            <li className="flex items-start gap-3">
              <span className="bg-info/15 text-info mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md">
                <ListTree className="size-4" />
              </span>
              <div className="min-w-0">
                <p className="text-sm font-medium">{t("guidance.requestTitle")}</p>
                <p className="text-muted-foreground text-xs">{t("guidance.requestHint")}</p>
              </div>
            </li>
          </ul>

          <div className="mt-5">
            <Button size="sm" onClick={() => void showApiHome()}>
              {t("guidance.openList")}
            </Button>
          </div>
        </section>
      </div>
    </div>
  );
}

export default WelcomeView;
