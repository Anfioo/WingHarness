import { useCallback, useEffect, useMemo, useState } from "react";
import { open as pickFile } from "@tauri-apps/plugin-dialog";
import { AlertTriangle, ArrowLeft, FileJson2, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { apiFetchSpecUrl, apiImportApply, apiReadTextFile } from "@/commands";
import { useApiClient } from "@/features/api-client/store";
import { parseOpenApiDocument } from "@/lib/api-core/openapi";
import type { ImportResult, WorkspaceMeta } from "@/lib/api-core/types";
import { summarizeImport, sourceBaseName } from "./summary";

/** How many endpoint names the preview lists before collapsing to a count. */
const ENDPOINT_SAMPLE = 8;

/**
 * The OpenAPI / Swagger import flow. The user picks a spec from disk or a URL,
 * previews the parsed collection (folders, requests and any converter notes),
 * then confirms: a workspace is created, the parsed `ImportResult` is merged in
 * through `apiImportApply`, and the workspace window is opened.
 */
export function OpenApiImportDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (workspace: WorkspaceMeta) => void;
}) {
  const { t } = useTranslation("translation", { keyPrefix: "apiClient.import" });
  const createWorkspace = useApiClient((state) => state.createWorkspace);

  const [source, setSource] = useState<"file" | "url">("file");
  const [path, setPath] = useState("");
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [prefix, setPrefix] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [useBaseUrlVariable, setUseBaseUrlVariable] = useState(true);
  const [specText, setSpecText] = useState("");
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<ImportResult | null>(null);

  useEffect(() => {
    if (!open) return;
    setSource("file");
    setPath("");
    setUrl("");
    setName("");
    setNameTouched(false);
    setPrefix("");
    setBaseUrl("");
    setUseBaseUrlVariable(true);
    setSpecText("");
    setBusy(false);
    setPreview(null);
  }, [open]);

  // Editing the source invalidates a preview that was built from the old one.
  useEffect(() => {
    setPreview(null);
  }, [source, path, url]);

  const raw = source === "file" ? path : url;
  const effectiveName = nameTouched ? name : sourceBaseName(raw, t("defaultName"));
  const summary = useMemo(() => (preview ? summarizeImport(preview) : null), [preview]);

  const browse = useCallback(async () => {
    const picked = await pickFile({
      multiple: false,
      filters: [{ name: t("specFilter"), extensions: ["json", "yaml", "yml"] }],
    });
    if (typeof picked === "string") {
      setPath(picked);
      if (!nameTouched) setName(sourceBaseName(picked, t("defaultName")));
    }
  }, [nameTouched, t]);

  const loadSpec = useCallback(async (): Promise<string> => {
    const target = raw.trim();
    const file = source === "file" ? await apiReadTextFile(target) : await apiFetchSpecUrl(target);
    return file.text;
  }, [raw, source]);

  const readAndPreview = useCallback(async () => {
    if (busy || !raw.trim() || !effectiveName.trim()) return;
    setBusy(true);
    let text: string;
    try {
      text = await loadSpec();
    } catch (error) {
      toast.error(t("toast.readFailed"));
      console.error("Failed to read the OpenAPI spec:", error);
      setBusy(false);
      return;
    }
    try {
      setSpecText(text);
      const parsed = parseOpenApiDocument(text, { useBaseUrlVariable });
      setPreview(parsed);
      setBaseUrl(parsed.baseUrl);
    } catch (error) {
      toast.error(t("toast.parseFailed"));
      console.error("Failed to parse the OpenAPI spec:", error);
    } finally {
      setBusy(false);
    }
  }, [busy, effectiveName, loadSpec, raw, t, useBaseUrlVariable]);

  const confirmImport = useCallback(async () => {
    const spec = preview;
    const trimmedName = effectiveName.trim();
    if (!spec || !trimmedName || busy) return;
    setBusy(true);
    let createdId: string | null = null;
    try {
      const meta = await createWorkspace(trimmedName);
      createdId = meta.id;
      const applied = await apiImportApply(meta.id, spec, {
        namePrefix: prefix.trim(),
        baseUrl: useBaseUrlVariable ? baseUrl.trim() : "",
      });
      await useApiClient.getState().loadWorkspaces();
      onCreated(meta);
      toast.success(t("toast.imported", { count: applied.added, name: meta.name }));
      onOpenChange(false);
    } catch (error) {
      toast.error(t("toast.applyFailed"));
      console.error("Failed to apply the OpenAPI import:", error);
      // Do not leave a half-imported workspace behind.
      if (createdId) {
        await useApiClient
          .getState()
          .deleteWorkspace(createdId)
          .catch(() => undefined);
      }
    } finally {
      setBusy(false);
    }
  }, [
    busy,
    createWorkspace,
    effectiveName,
    onCreated,
    onOpenChange,
    prefix,
    baseUrl,
    useBaseUrlVariable,
    preview,
    t,
  ]);

  /** Re-parse the already-read spec so the toggle applies to every URL. */
  const onToggleBaseUrlVariable = (checked: boolean) => {
    setUseBaseUrlVariable(checked);
    if (specText === "") return;
    setPreview(parseOpenApiDocument(specText, { useBaseUrlVariable: checked }));
  };

  const sample = summary ? summary.endpoints.slice(0, ENDPOINT_SAMPLE) : [];
  const overflow = summary ? summary.endpoints.length - sample.length : 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

        {preview && summary ? (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="bg-primary/10 text-primary flex size-8 shrink-0 items-center justify-center rounded-md">
                <FileJson2 className="size-4" />
              </span>
              <span className="text-sm font-medium">
                {summary.collectionName || t("preview.untitled")}
              </span>
              <Badge variant="secondary" className="text-[10px]">
                {t("preview.folders", { count: summary.folderCount })}
              </Badge>
              <Badge variant="secondary" className="text-[10px]">
                {t("preview.requests", { count: summary.requestCount })}
              </Badge>
            </div>

            {sample.length > 0 ? (
              <div className="space-y-1">
                <p className="text-muted-foreground text-xs font-medium">
                  {t("preview.endpoints")}
                </p>
                <ul className="bg-muted/40 max-h-32 overflow-auto rounded-md px-3 py-2 text-xs">
                  {sample.map((endpoint, index) => (
                    <li key={`${index}-${endpoint}`} className="truncate">
                      {endpoint}
                    </li>
                  ))}
                  {overflow > 0 ? (
                    <li className="text-muted-foreground">
                      {t("preview.more", { count: overflow })}
                    </li>
                  ) : null}
                </ul>
              </div>
            ) : null}

            {preview.warnings.length > 0 ? (
              <div className="space-y-1">
                <p className="text-xs font-medium">
                  {t("warnings.title", { count: preview.warnings.length })}
                </p>
                <ul className="text-muted-foreground space-y-1 text-xs">
                  {preview.warnings.map((warning, index) => (
                    <li key={index} className="flex gap-1.5">
                      <AlertTriangle className="mt-0.5 size-3 shrink-0 text-amber-500" />
                      <span>{warning}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            <div className="space-y-1.5">
              <label className="text-xs font-medium" htmlFor="api-import-base-url">
                {t("preview.baseUrlLabel")}
              </label>
              <Input
                id="api-import-base-url"
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
                placeholder={t("preview.baseUrlPlaceholder")}
                className="h-8 text-sm"
                spellCheck={false}
              />
              <p className="text-faint text-[11px]">{t("preview.baseUrlHint")}</p>
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  className="accent-primary size-3.5"
                  checked={useBaseUrlVariable}
                  onChange={(event) => onToggleBaseUrlVariable(event.target.checked)}
                />
                {t("preview.useBaseUrlVariable")}
              </label>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium" htmlFor="api-import-prefix">
                {t("preview.prefixLabel")}
              </label>
              <Input
                id="api-import-prefix"
                value={prefix}
                onChange={(event) => setPrefix(event.target.value)}
                placeholder={t("preview.prefixPlaceholder")}
                className="h-8 text-sm"
              />
              <p className="text-faint text-[11px]">{t("preview.prefixHint")}</p>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                variant={source === "file" ? "secondary" : "ghost"}
                onClick={() => setSource("file")}
              >
                {t("source.file")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant={source === "url" ? "secondary" : "ghost"}
                onClick={() => setSource("url")}
              >
                {t("source.url")}
              </Button>
            </div>

            {source === "file" ? (
              <div className="space-y-1.5">
                <label className="text-xs font-medium" htmlFor="api-import-path">
                  {t("pathLabel")}
                </label>
                <div className="flex gap-2">
                  <Input
                    id="api-import-path"
                    value={path}
                    onChange={(event) => setPath(event.target.value)}
                    placeholder={t("pathPlaceholder")}
                    className="h-8 text-sm"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="shrink-0"
                    onClick={() => void browse()}
                  >
                    {t("browse")}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="space-y-1.5">
                <label className="text-xs font-medium" htmlFor="api-import-url">
                  {t("urlLabel")}
                </label>
                <Input
                  id="api-import-url"
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                  placeholder={t("urlPlaceholder")}
                  className="h-8 text-sm"
                />
              </div>
            )}

            <div className="space-y-1.5">
              <label className="text-xs font-medium" htmlFor="api-import-name">
                {t("nameLabel")}
              </label>
              <Input
                id="api-import-name"
                value={effectiveName}
                onChange={(event) => {
                  setNameTouched(true);
                  setName(event.target.value);
                }}
                placeholder={t("namePlaceholder")}
                className="h-8 text-sm"
              />
            </div>
          </div>
        )}

        <DialogFooter>
          {preview ? (
            <>
              <Button variant="ghost" onClick={() => setPreview(null)} disabled={busy}>
                <ArrowLeft className="size-3.5" />
                {t("actions.back")}
              </Button>
              <Button onClick={() => void confirmImport()} disabled={busy}>
                {busy ? (
                  <>
                    <Loader2 className="size-3.5 animate-spin" />
                    {t("actions.importing")}
                  </>
                ) : (
                  t("actions.import")
                )}
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                {t("actions.cancel")}
              </Button>
              <Button
                onClick={() => void readAndPreview()}
                disabled={busy || !raw.trim() || !effectiveName.trim()}
              >
                {busy ? (
                  <>
                    <Loader2 className="size-3.5 animate-spin" />
                    {t("actions.reading")}
                  </>
                ) : (
                  t("actions.preview")
                )}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default OpenApiImportDialog;
