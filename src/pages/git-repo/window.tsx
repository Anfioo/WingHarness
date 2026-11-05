import { useMemo } from "react";
import { TitleBar } from "@/components/title-bar";
import { WindowFrame } from "@/components/window-frame";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { useRouter } from "@/lib/router";
import { RepositoryView } from "./repository-view";
import { WelcomeView } from "./welcome-view";

/** The repository this window was opened for, taken from its own URL. */
function repoFromUrl(search: string) {
  return new URLSearchParams(search).get("path") ?? "";
}

/**
 * A repository window. It is its own window and draws its own frame, and the
 * repository it shows comes from `?path=`. Without one it falls back to the
 * picker, which is what a window opened by hand shows.
 */
export default function GitRepoWindow() {
  const { t } = useAppTranslation();
  const { search } = useRouter();
  const path = useMemo(() => repoFromUrl(search), [search]);

  return (
    <WindowFrame
      titleBar={
        <TitleBar
          title={t("gitRepo.shell.windowTitle")}
          showPin
          showMaximize
          closeOnEscape={!path}
        />
      }
      contentClassName="flex flex-1 flex-col overflow-hidden"
    >
      {path ? <RepositoryView path={path} /> : <WelcomeView />}
    </WindowFrame>
  );
}
