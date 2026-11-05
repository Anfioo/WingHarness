import { useState, type ReactNode } from "react";
import { AlertTriangle, ArrowDownToLine, Ban, Loader2, RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { EmptyPane } from "@/components/api-client/empty-pane";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useApiClient } from "@/features/api-client/store";
import { BodyView, RawView, bodyClipboardText } from "./body-view";
import { CopyButton } from "./copy-button";
import { HeadersView } from "./headers-view";
import { StatusLine } from "./status-line";

/**
 * The response viewer: the right column of the workspace. It reads the store's
 * `sendState` and renders the matching slice — an idle/sending/cancelled/error
 * notice, or, once a response arrives, the status line plus the
 * Body/Headers/Raw tabs. Sending and cancelling are owned by the request pane;
 * this pane only displays their outcome (and offers a retry when a request
 * failed or was cancelled).
 */
export function ResponsePane(): ReactNode {
  const { t } = useTranslation("translation", { keyPrefix: "apiClient.response" });
  const { t: tCommon } = useTranslation("translation", { keyPrefix: "apiClient.common" });
  const sendState = useApiClient((state) => state.sendState);
  const send = useApiClient((state) => state.send);

  const [tab, setTab] = useState("body");

  const { status, response, errorMessage } = sendState;

  const retry = (
    <Button type="button" variant="secondary" size="sm" onClick={() => void send()}>
      <RotateCcw />
      {tCommon("actions.retry")}
    </Button>
  );

  if (status === "sending") {
    return (
      <EmptyPane
        icon={<Loader2 className="size-5 animate-spin" />}
        title={t("sending.title")}
        description={t("sending.description")}
        className="flex-1"
      />
    );
  }

  if (status === "cancelled") {
    return (
      <EmptyPane
        icon={<Ban className="size-5" />}
        title={t("cancelled.title")}
        description={t("cancelled.description")}
        action={retry}
        className="flex-1"
      />
    );
  }

  if (status === "error") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <span
          aria-hidden
          className="bg-destructive/10 text-destructive flex size-10 shrink-0 items-center justify-center rounded-full"
        >
          <AlertTriangle className="size-5" />
        </span>
        <div className="max-w-xs">
          <p className="text-sm font-medium">{t("error.title")}</p>
          <p className="text-muted-foreground mt-1 text-xs break-words">
            {errorMessage ?? t("error.description")}
          </p>
        </div>
        {retry}
      </div>
    );
  }

  if (status !== "done" || response === null) {
    return (
      <EmptyPane
        icon={<ArrowDownToLine className="size-5" />}
        title={t("empty.title")}
        description={t("empty.description")}
        className="flex-1"
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <StatusLine response={response} />

      <Tabs value={tab} onValueChange={setTab} className="min-h-0 flex-1 gap-0">
        <div className="flex shrink-0 items-center justify-between gap-2 px-3 pt-2">
          <TabsList className="h-8">
            <TabsTrigger value="body">{t("tabs.body")}</TabsTrigger>
            <TabsTrigger value="headers">{t("tabs.headers")}</TabsTrigger>
            <TabsTrigger value="raw">{t("tabs.raw")}</TabsTrigger>
          </TabsList>
          {tab === "headers" ? null : (
            <CopyButton text={bodyClipboardText(response)} label={t("copy.body")} />
          )}
        </div>

        <TabsContent value="body" className="mt-2 min-h-0 flex-1 overflow-auto px-3 pb-3">
          <BodyView response={response} />
        </TabsContent>
        <TabsContent value="headers" className="mt-2 min-h-0 flex-1 overflow-auto px-3 pb-3">
          <HeadersView headers={response.headers} />
        </TabsContent>
        <TabsContent value="raw" className="mt-2 min-h-0 flex-1 overflow-auto px-3 pb-3">
          <RawView response={response} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

export default ResponsePane;
