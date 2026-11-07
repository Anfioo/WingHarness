import { useMemo } from "react";
import { ArrowLeft, FolderGit2 } from "lucide-react";
import { TitleBar } from "@/components/title-bar";
import { WindowFrame } from "@/components/window-frame";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { projectTitle, showProjectHome } from "@/lib/project-windows";
import { useRouter } from "@/lib/router";
import { cn } from "@/lib/utils";
import ProjectWorkbench from "./workbench";

/** The project this window was opened for, taken from its own URL. */
function projectFromUrl(search: string) {
  return new URLSearchParams(search).get("path") ?? "";
}

/**
 * A project's window. It is its own window and draws its own frame
 * (`WindowFrame` + `TitleBar`), and the project it shows comes from `?path=`.
 * Without one it explains how to open a project, which is what a window opened
 * by hand shows.
 */
export default function ProjectWindow() {
  const { t } = useAppTranslation();
  const { search } = useRouter();
  const root = useMemo(() => projectFromUrl(search), [search]);

  return (
    <WindowFrame
      titleBar={
        <TitleBar
          title={root ? projectTitle(root) : t("projectWindow.title")}
          showPin
          showMaximize
          closeOnEscape={!root}
          leftActions={
            <button
              type="button"
              // The bar's left half is the drag region; without this the button
              // would start dragging the window instead of firing.
              onMouseDown={(event) => event.stopPropagation()}
              onClick={() => void showProjectHome()}
              className={cn(
                "text-muted-foreground hover:text-foreground hover:bg-accent flex size-6 items-center justify-center rounded",
                root ? "" : "hidden"
              )}
              aria-label={t("projectWindow.back")}
              title={t("projectWindow.back")}
            >
              <ArrowLeft className="size-3.5" />
            </button>
          }
        />
      }
      contentClassName="flex flex-1 flex-col overflow-hidden"
    >
      {root ? <ProjectWorkbench root={root} /> : <ProjectWindowWelcome />}
    </WindowFrame>
  );
}

/** Shown when the window was opened without a project in its URL. */
function ProjectWindowWelcome() {
  const { t } = useAppTranslation();

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
      <span className="bg-muted text-muted-foreground flex size-12 items-center justify-center rounded-full">
        <FolderGit2 className="size-6" />
      </span>
      <div>
        <p className="text-sm font-medium">{t("projectWindow.emptyTitle")}</p>
        <p className="text-muted-foreground mx-auto mt-1 max-w-md text-xs">
          {t("projectWindow.emptyDescription")}
        </p>
      </div>
      <button
        type="button"
        onClick={() => void showProjectHome()}
        className="text-primary text-xs underline-offset-4 hover:underline"
      >
        {t("projectWindow.back")}
      </button>
    </div>
  );
}
