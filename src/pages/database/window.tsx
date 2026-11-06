import { useMemo } from "react";
import { Database } from "lucide-react";
import { TitleBar } from "@/components/title-bar";
import { WindowFrame } from "@/components/window-frame";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { useRouter } from "@/lib/router";
import { ConsoleView } from "./console-view";

/** The data source this window was opened for, taken from its own URL. */
function sourceFromUrl(search: string) {
  return new URLSearchParams(search).get("source") ?? "";
}

/**
 * A data source window. It is its own window and draws its own frame
 * (`WindowFrame` + `TitleBar`), and the data source it shows comes from
 * `?source=`. Without one there is nothing to connect to, so it says so rather
 * than guessing at a data source.
 */
export default function DatabaseWindow() {
  const { t } = useAppTranslation();
  const { search } = useRouter();
  const sourceId = useMemo(() => sourceFromUrl(search), [search]);

  return (
    <WindowFrame
      titleBar={
        <TitleBar title={t("database.title")} showPin showMaximize closeOnEscape={!sourceId} />
      }
      contentClassName="flex flex-1 flex-col overflow-hidden"
    >
      {sourceId ? (
        <ConsoleView sourceId={sourceId} />
      ) : (
        <div className="text-muted-foreground flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center text-sm">
          <Database className="size-8" />
          <p className="text-foreground font-medium">{t("database.window.missingTitle")}</p>
          <p className="max-w-md text-xs">
            {t("database.window.missingDescription", {
              defaultValue: "The data source was deleted or belongs to another project.",
            })}
          </p>
        </div>
      )}
    </WindowFrame>
  );
}
