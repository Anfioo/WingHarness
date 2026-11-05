import { useEffect, useMemo, useState } from "react";
import { AlertCircle, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Group, Panel, Separator, useDefaultLayout } from "react-resizable-panels";
import { Button } from "@/components/ui/button";
import { CollectionPane } from "@/features/api-client/collection";
import { EnvironmentBar } from "@/features/api-client/environment/env-bar";
import { EnvironmentDialog } from "@/features/api-client/environment/dialog";
import { RequestPane } from "@/features/api-client/request";
import { ResponsePane } from "@/features/api-client/response";
import { useApiClient } from "@/features/api-client/store";
import { showApiHome } from "@/lib/api-windows";

const COLLECTION_DEFAULT_SIZE = 22;
const RESPONSE_DEFAULT_SIZE = 32;

/**
 * One workspace: the collection tree on the left, the request editor in the
 * middle and the response viewer on the right. The panes are placeholders the
 * collection/request/response phases replace wholesale; the layout and the
 * window plumbing around them are what this phase ships.
 *
 * The layout is remembered per workspace (`useDefaultLayout` keyed on the id),
 * which is a view preference, so it persists while the tree itself never does.
 */
export function WorkspaceView({ workspaceId }: { workspaceId: string }) {
  const { t } = useTranslation("translation", { keyPrefix: "apiClient.welcome" });
  const open = useApiClient((state) => state.openWorkspace);
  const tree = useApiClient((state) => state.tree);
  const openLoading = useApiClient((state) => state.openLoading);
  const openError = useApiClient((state) => state.listError);

  const layoutId = useMemo(() => `api-client-layout:${workspaceId}`, [workspaceId]);
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({ id: layoutId });
  const [environmentOpen, setEnvironmentOpen] = useState(false);

  useEffect(() => {
    void open(workspaceId).catch(() => undefined);
  }, [open, workspaceId]);

  if (openError && !tree) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <span aria-hidden className="bg-muted text-muted-foreground rounded-lg p-2.5">
          <AlertCircle className="size-5" />
        </span>
        <div>
          <p className="text-sm font-medium">{t("openFailed.title")}</p>
          <p className="text-muted-foreground mt-1 text-xs">{t("openFailed.description")}</p>
        </div>
        <Button variant="secondary" size="sm" onClick={() => void showApiHome()}>
          {t("openFailed.home")}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <div className="border-border flex h-9 shrink-0 items-center gap-2 border-b px-3">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {tree?.name ?? t("window.loading")}
        </span>
        {openLoading ? (
          <Loader2 className="text-muted-foreground size-3.5 shrink-0 animate-spin" />
        ) : null}
        {tree ? (
          <div className="shrink-0">
            <EnvironmentBar onManage={() => setEnvironmentOpen(true)} />
          </div>
        ) : null}
      </div>
      <EnvironmentDialog open={environmentOpen} onOpenChange={setEnvironmentOpen} />
      <div className="min-h-0 flex-1">
        <Group className="h-full" defaultLayout={defaultLayout} onLayoutChanged={onLayoutChanged}>
          <Panel
            id="collection"
            defaultSize={`${COLLECTION_DEFAULT_SIZE}`}
            minSize="14"
            className="h-full overflow-hidden"
          >
            <CollectionPane />
          </Panel>
          <Separator className="bg-border w-px" />
          <Panel id="request" defaultSize="46" minSize="24" className="h-full overflow-hidden">
            <RequestPane />
          </Panel>
          <Separator className="bg-border w-px" />
          <Panel
            id="response"
            defaultSize={`${RESPONSE_DEFAULT_SIZE}`}
            minSize="18"
            className="h-full overflow-hidden"
          >
            <ResponsePane />
          </Panel>
        </Group>
      </div>
    </div>
  );
}

export default WorkspaceView;
