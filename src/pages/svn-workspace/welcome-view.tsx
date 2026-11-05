import { FolderSync, ListTree } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { showSvnHome } from "@/lib/svn-windows";

/**
 * The no-workspace state of a working-copy window: shown when the window was
 * opened without a `?path=`. A working copy is opened from the picker, which is
 * a page of the main window, so the one real action is going back there.
 */
export function WelcomeView() {
  const { t } = useAppTranslation();

  return (
    <div className="flex flex-1 flex-col overflow-y-auto">
      <div className="animate-fade-in flex w-full flex-1 flex-col justify-center gap-6 px-6 py-10">
        <header className="flex items-center gap-3">
          <span className="bg-primary/10 text-primary flex size-12 shrink-0 items-center justify-center rounded-xl">
            <FolderSync className="size-6" />
          </span>
          <div className="min-w-0">
            <h1 className="text-primary text-xl font-semibold tracking-tight">
              {t("svnWorkspace.welcome.header.brand")}
            </h1>
            <p className="text-muted-foreground text-sm">
              {t("svnWorkspace.welcome.header.tagline")}
            </p>
          </div>
        </header>

        <section className="border-border bg-card shadow-soft rounded-lg border p-5">
          <div className="flex items-start gap-3">
            <span className="bg-primary/15 text-primary mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-md">
              <ListTree className="size-4" />
            </span>
            <div className="min-w-0">
              <h2 className="text-sm font-medium">{t("svnWorkspace.welcome.noWorkspace.title")}</h2>
              <p className="text-muted-foreground mt-1 text-xs leading-relaxed">
                {t("svnWorkspace.welcome.noWorkspace.description")}
              </p>
            </div>
          </div>

          <div className="mt-5">
            <Button size="sm" onClick={() => void showSvnHome()}>
              {t("svnWorkspace.welcome.noWorkspace.openList")}
            </Button>
          </div>
        </section>
      </div>
    </div>
  );
}

export default WelcomeView;
