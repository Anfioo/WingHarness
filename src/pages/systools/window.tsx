import { useMemo } from "react";
import { TitleBar } from "@/components/title-bar";
import { WindowFrame } from "@/components/window-frame";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { useRouter } from "@/lib/router";
import { readSystoolsTab } from "@/lib/systools-routes";
import { SystoolsApp } from "./systools-app";

/** The systools window; the tab it shows comes from `?tab=`. */
export default function SystoolsWindow() {
  const { t } = useAppTranslation();
  const { search } = useRouter();
  const tab = useMemo(() => readSystoolsTab(search), [search]);

  return (
    <WindowFrame
      titleBar={<TitleBar title={t("systools.common.title")} showPin />}
      contentClassName="flex flex-1 flex-col overflow-hidden"
    >
      <SystoolsApp initialTab={tab} inWindow />
    </WindowFrame>
  );
}
