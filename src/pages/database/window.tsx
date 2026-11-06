import { useMemo } from "react";
import { Database } from "lucide-react";
import { TitleBar } from "@/components/title-bar";
import { WindowFrame } from "@/components/window-frame";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { useRouter } from "@/lib/router";
import { ConsoleView } from "./console-view";
import { TableEditor } from "./table-editor";
import { TabBar } from "./tab-bar";
import { DatabaseTabsProvider, tabKey, useDatabaseTabs } from "./window-tabs";

/** The data source this window was opened for, taken from its own URL. */
function sourceFromUrl(search: string) {
  return new URLSearchParams(search).get("source") ?? "";
}

/** The body of the active tab. */
function DatabaseBody({ sourceId }: { sourceId: string }) {
  const { tabs, active } = useDatabaseTabs();
  const tab = tabs.find((entry) => tabKey(entry) === active) ?? tabs[0];

  if (!tab || tab.kind === "console") {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <ConsoleView sourceId={sourceId} />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <TableEditor target={tab.target} schema={tab.schema} table={tab.table} />
    </div>
  );
}

/**
 * A data source window. It is its own window and draws its own frame
 * (`WindowFrame` + `TitleBar`), and the data source it shows comes from
 * `?source=`. Without one there is nothing to connect to, so it says so rather
 * than guessing at a data source.
 *
 * The window holds a tab strip: the SQL console is always the first tab and
 * cannot be closed, and every table opened from the objects tree gets a tab of
 * its own.
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
        <DatabaseTabsProvider sourceId={sourceId}>
          <TabBar />
          <DatabaseBody sourceId={sourceId} />
        </DatabaseTabsProvider>
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
