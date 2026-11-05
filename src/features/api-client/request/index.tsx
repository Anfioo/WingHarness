import { useState } from "react";
import { FileSearch, Loader2, Plus, Save, Send, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { EmptyPane } from "@/components/api-client/empty-pane";
import { KeyValueTable } from "@/components/api-client/key-value-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useApiClient, pickEnvironment } from "@/features/api-client/store";
import { URL_PROBLEM_KEYS, validateMethod } from "@/lib/api-core/request-model";
import { requestVariableNames, resolveRequest } from "@/lib/api-core/resolve-request";
import { variablesToMap } from "@/lib/api-core/template";
import type { KeyValue } from "@/lib/api-core/types";
import { AuthEditor } from "./auth-editor";
import { BodyEditor } from "./body-editor";
import { MethodSelect } from "./method-select";
import { RequestSettings } from "./request-settings";
import { displayUrl, paramsFromUrl, splitUrl, urlWithParams } from "./url-params";

/**
 * The request editor: the middle column of the workspace. It binds the method
 * and URL bar and the Params/Headers/Body/Auth tabs to the store's `draft`,
 * committing every edit through `updateRequest`, and drives send/cancel and the
 * workspace save affordance.
 *
 * The URL field keeps its own text while the user types (so the sync never
 * rewrites what they are entering) and only re-parses the query into the Params
 * table when they actually edit the URL. `draft.url` stays query-free because
 * the engine appends `params`, so the round-trip never duplicates the query.
 */
export function RequestPane() {
  const { t } = useTranslation("translation", { keyPrefix: "apiClient.request" });
  const { t: tCommon } = useTranslation("translation", { keyPrefix: "apiClient.common" });
  const { t: tRoot } = useTranslation();

  const draft = useApiClient((state) => state.draft);
  const tree = useApiClient((state) => state.tree);
  const activeEnvironmentId = useApiClient((state) => state.activeEnvironmentId);
  const dirty = useApiClient((state) => state.dirty);
  const saveLoading = useApiClient((state) => state.saveLoading);
  const sending = useApiClient((state) => state.sendState.status === "sending");
  const updateRequest = useApiClient((state) => state.updateRequest);
  const saveWorkspace = useApiClient((state) => state.saveWorkspace);
  const send = useApiClient((state) => state.send);
  const cancel = useApiClient((state) => state.cancel);

  const draftId = draft?.id ?? null;

  // The URL field's text is buffered per request so typing is never rewritten by
  // a sync; it falls back to the derived full URL whenever a new request loads.
  const [urlBuffer, setUrlBuffer] = useState<{ id: string; text: string } | null>(null);
  // Validation messages only appear after the first Send attempt per request.
  const [attempted, setAttempted] = useState<{ id: string; on: boolean } | null>(null);
  const [tab, setTab] = useState("params");

  const urlValue = draft
    ? urlBuffer && urlBuffer.id === draftId
      ? urlBuffer.text
      : displayUrl(draft.url, draft.params)
    : "";

  const methodError = draft ? validateMethod(draft.method) : null;
  // The URL is validated *after* interpolation, so `{{baseUrl}}/pets` is valid
  // as soon as the active environment provides a base URL.
  const environment = pickEnvironment(tree, activeEnvironmentId);
  const resolved = draft ? resolveRequest(draft, environment) : null;
  const urlError = resolved?.problem ? URL_PROBLEM_KEYS[resolved.problem] : null;
  const showErrors = attempted !== null && attempted.id === draftId && attempted.on;
  const errorMessage = methodError ?? urlError;
  const resolvedUrl = resolved?.finalUrl ?? "";

  // The line under the URL: warn about variables or a missing base URL, else
  // show where the request will actually go.
  const urlMissing = resolved?.urlMissing ?? [];
  const urlHint: { tone: "warn" | "muted"; text: string } | null =
    urlMissing.length > 0
      ? { tone: "warn", text: t("urlMissing", { names: urlMissing.join(", ") }) }
      : resolved?.problem && resolved.problem !== "empty"
        ? { tone: "warn", text: tRoot(URL_PROBLEM_KEYS[resolved.problem]) }
        : resolvedUrl !== ""
          ? { tone: "muted", text: t("resolvedUrl", { url: resolvedUrl }) }
          : null;

  const usedVariables = draft ? requestVariableNames(draft) : [];
  const requestVariableKeys = new Set(
    draft?.variables.filter((row) => row.enabled && row.key !== "").map((row) => row.key) ?? []
  );
  const environmentVariableKeys = new Set(
    Object.keys(variablesToMap(environment?.variables ?? []))
  );

  /** Add a request-level row for a variable the request references but nobody defines. */
  const addRequestVariable = (name: string) => {
    if (!draft) return;
    updateRequest({ variables: [...draft.variables, { key: name, value: "", enabled: true }] });
  };

  /** Edit the URL: buffer the raw text, and re-parse the query only when present
   *  so editing the base never wipes params the user set in the table. */
  const onUrlChange = (value: string) => {
    if (!draft) return;
    setUrlBuffer({ id: draft.id, text: value });
    const { base, hasQuery } = splitUrl(value);
    if (hasQuery) updateRequest({ url: base, params: paramsFromUrl(value) });
    else updateRequest({ url: value });
  };

  /** On blur, drop transient separators (`?`, `&`) from the field. */
  const onUrlBlur = () => {
    if (!draft) return;
    setUrlBuffer({ id: draft.id, text: displayUrl(draft.url, draft.params) });
  };

  /** Edit params: round-trip the encoded query back into the URL field. */
  const onParamsChange = (rows: KeyValue[]) => {
    if (!draft) return;
    setUrlBuffer({ id: draft.id, text: urlWithParams(draft.url, rows) });
    updateRequest({ params: rows });
  };

  const onHeadersChange = (rows: KeyValue[]) => updateRequest({ headers: rows });

  const onSend = () => {
    if (!draft) return;
    setAttempted({ id: draft.id, on: true });
    if (methodError || urlError) return;
    void send();
  };

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
          event.preventDefault();
          onSend();
        }
      }}
    >
      <div className="border-border flex h-9 shrink-0 items-center gap-2 border-b px-3">
        <span className="truncate text-xs font-medium">{draft ? draft.name : t("title")}</span>
        {dirty ? (
          <span className="flex shrink-0 items-center gap-1 text-[11px] text-amber-600 dark:text-amber-500">
            <span aria-hidden className="size-1.5 rounded-full bg-current" />
            {t("save.dirty")}
          </span>
        ) : null}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {draft ? (
            <RequestSettings
              timeoutMs={draft.timeoutMs}
              followRedirects={draft.followRedirects}
              onChange={(patch) => updateRequest(patch)}
            />
          ) : null}
          <Button
            type="button"
            variant="outline"
            size="xs"
            className="shrink-0"
            disabled={!dirty || saveLoading}
            onClick={() => void saveWorkspace()}
          >
            {saveLoading ? <Loader2 className="animate-spin" /> : <Save />}
            {saveLoading ? t("save.saving") : tCommon("actions.save")}
          </Button>
        </div>
      </div>

      {draft === null ? (
        <EmptyPane
          icon={<FileSearch className="size-5" />}
          title={t("empty.title")}
          description={t("empty.description")}
          className="flex-1"
        />
      ) : (
        <>
          <div className="border-border flex shrink-0 items-start gap-2 border-b px-3 py-2">
            <MethodSelect
              value={draft.method}
              invalid={Boolean(methodError) && showErrors}
              onChange={(method) => updateRequest({ method })}
            />
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <Input
                value={urlValue}
                spellCheck={false}
                autoComplete="off"
                placeholder={t("urlPlaceholder")}
                aria-label={tCommon("labels.url")}
                aria-invalid={(Boolean(urlError) && showErrors) || undefined}
                className="h-9 text-xs"
                onChange={(event) => onUrlChange(event.target.value)}
                onBlur={onUrlBlur}
              />
              {showErrors && errorMessage ? (
                <p className="text-destructive text-[11px]">{tRoot(errorMessage)}</p>
              ) : urlHint ? (
                <p
                  className={
                    urlHint.tone === "warn"
                      ? "truncate text-[11px] text-amber-600 dark:text-amber-500"
                      : "text-muted-foreground truncate text-[11px]"
                  }
                  title={urlHint.tone === "warn" ? undefined : resolvedUrl}
                >
                  {urlHint.text}
                </p>
              ) : null}
            </div>
            {sending ? (
              <Button
                type="button"
                variant="outline"
                className="h-9 shrink-0"
                onClick={() => void cancel()}
              >
                <X />
                {tCommon("actions.cancel")}
              </Button>
            ) : (
              <Button
                type="button"
                className="h-9 shrink-0"
                title={t("sendShortcut")}
                onClick={onSend}
              >
                <Send />
                {t("send")}
              </Button>
            )}
          </div>

          <Tabs value={tab} onValueChange={setTab} className="min-h-0 flex-1 gap-0">
            <TabsList className="mx-3 mt-2 h-8 w-fit shrink-0">
              <TabsTrigger value="params">{tCommon("labels.params")}</TabsTrigger>
              <TabsTrigger value="headers">{tCommon("labels.headers")}</TabsTrigger>
              <TabsTrigger value="body">{tCommon("labels.body")}</TabsTrigger>
              <TabsTrigger value="auth">{tCommon("labels.auth")}</TabsTrigger>
              <TabsTrigger value="variables">{tCommon("labels.variables")}</TabsTrigger>
            </TabsList>

            <TabsContent value="params" className="mt-2 min-h-0 flex-1 overflow-auto px-3 pb-3">
              <KeyValueTable rows={draft.params} onChange={onParamsChange} />
            </TabsContent>
            <TabsContent value="headers" className="mt-2 min-h-0 flex-1 overflow-auto px-3 pb-3">
              <KeyValueTable rows={draft.headers} onChange={onHeadersChange} />
            </TabsContent>
            <TabsContent value="body" className="mt-2 min-h-0 flex-1 overflow-auto px-3 pb-3">
              <BodyEditor body={draft.body} onChange={(body) => updateRequest({ body })} />
            </TabsContent>
            <TabsContent value="auth" className="mt-2 min-h-0 flex-1 overflow-auto px-3 pb-3">
              <AuthEditor auth={draft.auth} onChange={(auth) => updateRequest({ auth })} />
            </TabsContent>
            <TabsContent value="variables" className="mt-2 min-h-0 flex-1 overflow-auto px-3 pb-3">
              <p className="text-muted-foreground mb-2 text-[11px]">{t("variables.hint")}</p>
              <div className="mb-3 space-y-1">
                <p className="text-muted-foreground text-[11px]">{t("variables.used")}</p>
                {usedVariables.length === 0 ? (
                  <p className="text-muted-foreground text-[11px]">{t("variables.none")}</p>
                ) : (
                  <div className="flex flex-wrap gap-1">
                    {usedVariables.map((name) => {
                      const source = requestVariableKeys.has(name)
                        ? t("variables.source.request")
                        : environmentVariableKeys.has(name)
                          ? t("variables.source.environment")
                          : null;
                      return (
                        <Badge
                          key={name}
                          variant="outline"
                          className={
                            source
                              ? "gap-1 text-[10px] font-normal"
                              : "gap-1 border-amber-500/40 text-[10px] font-normal text-amber-600 dark:text-amber-500"
                          }
                        >
                          <span className="font-mono">{name}</span>
                          <span className="text-muted-foreground">
                            {source ?? t("variables.source.undefined")}
                          </span>
                          {source ? null : (
                            <button
                              type="button"
                              aria-label={t("variables.addUndefined", { name })}
                              title={t("variables.addUndefined", { name })}
                              onClick={() => addRequestVariable(name)}
                            >
                              <Plus className="size-3" />
                            </button>
                          )}
                        </Badge>
                      );
                    })}
                  </div>
                )}
              </div>
              <KeyValueTable
                rows={draft.variables}
                onChange={(variables) => updateRequest({ variables })}
              />
            </TabsContent>
          </Tabs>
        </>
      )}
    </div>
  );
}

export default RequestPane;
