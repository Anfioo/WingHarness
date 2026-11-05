import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, FileSearch, Loader2, Upload } from "lucide-react";
import { open as pickFile } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { frpConfigImport, frpConfigImportPreview } from "@/commands/services/frp";
import {
  frpErrorCode,
  isFrpError,
  type FrpImportPreview,
  type FrpImportResult,
  type FrpImportSource,
  type RuntimePolicy,
  type RuntimeView,
} from "@/commands/services/frp/types";
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
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { useAppTranslation } from "@/hooks/use-app-translation";
import {
  formatEndpoint,
  formatPublicAddress,
  formatVersion,
  frpFailureKey,
} from "@/lib/frp/format";
import { cn } from "@/lib/utils";

const CONFIG_EXTENSIONS = ["toml", "conf", "txt"];
const NAME_MAX_LENGTH = 80;

type SourceKind = "text" | "file";

type FieldName = "name" | "runtime" | "source";

type FieldErrors = Partial<Record<FieldName, string>>;

/** Maps the engine's `detail.field` onto this dialog's own fields. */
function backendField(error: unknown): FieldName | null {
  if (!isFrpError(error) || !error.detail) return null;
  const field = error.detail.field;
  if (typeof field !== "string") return null;
  switch (field) {
    case "name":
      return "name";
    case "runtimeId":
    case "runtime_id":
    case "runtimePolicy":
    case "runtime_policy":
      return "runtime";
    case "source":
    case "content":
    case "path":
      return "source";
    default:
      return null;
  }
}

export type ConfigImportDialogProps = {
  open: boolean;
  runtimes: RuntimeView[];
  onOpenChange: (open: boolean) => void;
  /** Called after a successful import; the caller reloads the workspace. */
  onImported: (result: FrpImportResult) => void;
  /** Switches to the runtime tab when the engine reports a missing runtime. */
  onOpenRuntime?: () => void;
};

/**
 * Imports an existing frpc.toml as one server profile plus its tunnels.
 *
 * The config is parsed once for a preview and nothing is written until the
 * user confirms. A file source is passed to the engine as a path only; this
 * dialog never reads it. The token is reported as present or absent, never
 * displayed, and applying it is the user's choice.
 */
export function ConfigImportDialog({
  open,
  runtimes,
  onOpenChange,
  onImported,
  onOpenRuntime,
}: ConfigImportDialogProps) {
  const { t } = useAppTranslation();

  const [sourceKind, setSourceKind] = useState<SourceKind>("text");
  const [text, setText] = useState("");
  const [filePath, setFilePath] = useState<string | null>(null);
  const [preview, setPreview] = useState<FrpImportPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  // Invalidates a preview response that arrives after the source changed.
  const previewToken = useRef(0);
  const [importing, setImporting] = useState(false);
  const [name, setName] = useState("");
  const [nameEdited, setNameEdited] = useState(false);
  const [applyToken, setApplyToken] = useState(true);
  const [runtimePolicy, setRuntimePolicy] = useState<RuntimePolicy>("recommended");
  const [runtimeId, setRuntimeId] = useState<string | null>(null);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [runtimeMissing, setRuntimeMissing] = useState(false);

  useEffect(() => {
    if (!open) return;
    previewToken.current += 1;
    setSourceKind("text");
    setText("");
    setFilePath(null);
    setPreview(null);
    setPreviewing(false);
    setImporting(false);
    setName("");
    setNameEdited(false);
    setApplyToken(true);
    setRuntimePolicy("recommended");
    setRuntimeId(null);
    setErrors({});
    setError(null);
    setRuntimeMissing(false);
  }, [open]);

  const describe = useCallback(
    (failure: unknown): string => {
      const key = frpFailureKey(failure);
      if (!key) return failure instanceof Error ? failure.message : String(failure);
      const message = isFrpError(failure) ? failure.message.trim() : "";
      return message ? `${t(key)}: ${message}` : t(key);
    },
    [t]
  );

  const currentSource: FrpImportSource | null =
    sourceKind === "text"
      ? text.trim()
        ? { kind: "text", content: text }
        : null
      : filePath
        ? { kind: "file", path: filePath }
        : null;

  const invalidatePreview = () => {
    previewToken.current += 1;
    setPreview(null);
    setPreviewing(false);
    setError(null);
    setRuntimeMissing(false);
    setErrors({});
  };

  const changeSourceKind = (value: string) => {
    if (value === sourceKind) return;
    setSourceKind(value as SourceKind);
    invalidatePreview();
  };

  const chooseFile = async () => {
    setError(null);
    const picked = await pickFile({
      multiple: false,
      directory: false,
      filters: [{ name: t("frp.import.fileFilter"), extensions: CONFIG_EXTENSIONS }],
    });
    if (typeof picked !== "string") return;
    setFilePath(picked);
    invalidatePreview();
  };

  const runPreview = async () => {
    if (!currentSource || previewing) return;

    const token = ++previewToken.current;
    setPreviewing(true);
    setError(null);
    setRuntimeMissing(false);
    setErrors({});
    try {
      const result = await frpConfigImportPreview(currentSource);
      if (previewToken.current !== token) return;
      setPreview(result);
      if (!result.tokenPresent) setApplyToken(false);
      if (!nameEdited) {
        setName(t("frp.import.defaultName", { addr: result.serverAddr }));
      }
    } catch (failure) {
      if (previewToken.current !== token) return;
      setPreview(null);
      const field = frpErrorCode(failure) === "invalid-input" ? backendField(failure) : null;
      if (field) {
        setErrors({ [field]: t("frp.import.validation.source") });
      } else {
        setError(describe(failure));
      }
    } finally {
      if (previewToken.current === token) setPreviewing(false);
    }
  };

  const changeRuntimePolicy = (value: RuntimePolicy) => {
    setRuntimePolicy(value);
    if (value === "pinned" && !runtimeId) setRuntimeId(runtimes[0]?.id ?? null);
    if (value === "recommended") setRuntimeId(null);
  };

  const validate = (): boolean => {
    const next: FieldErrors = {};
    const trimmedName = name.trim();
    if (!trimmedName || [...trimmedName].length > NAME_MAX_LENGTH) {
      next.name = t("frp.import.validation.name");
    }
    if (runtimePolicy === "pinned" && !runtimeId) {
      next.runtime = t("frp.import.validation.runtime");
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const submit = async () => {
    if (importing || previewing) return;
    if (!preview || !currentSource) return;
    if (!validate()) return;

    setImporting(true);
    setError(null);
    setRuntimeMissing(false);
    try {
      const result = await frpConfigImport({
        source: currentSource,
        name: name.trim(),
        applyToken,
        runtimePolicy,
        runtimeId: runtimePolicy === "pinned" ? runtimeId : null,
      });
      toast.success(t("frp.import.success", { count: result.tunnelCount }));
      onImported(result);
      onOpenChange(false);
    } catch (failure) {
      if (frpErrorCode(failure) === "runtime-missing") {
        setRuntimeMissing(true);
        setError(describe(failure));
      } else {
        const field = frpErrorCode(failure) === "invalid-input" ? backendField(failure) : null;
        if (field) {
          setErrors((current) => ({
            ...current,
            [field]:
              field === "source"
                ? t("frp.import.validation.source")
                : t(`frp.import.validation.${field}`),
          }));
        } else {
          setError(describe(failure));
        }
      }
    } finally {
      setImporting(false);
    }
  };

  const previewMatchesSource = preview !== null;

  return (
    <Dialog open={open} onOpenChange={(next) => !importing && onOpenChange(next)}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("frp.import.title")}</DialogTitle>
          <DialogDescription>{t("frp.import.description")}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <Tabs value={sourceKind} onValueChange={changeSourceKind}>
            <TabsList>
              <TabsTrigger value="text">{t("frp.import.source.text")}</TabsTrigger>
              <TabsTrigger value="file">{t("frp.import.source.file")}</TabsTrigger>
            </TabsList>
          </Tabs>

          {sourceKind === "text" ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="frp-import-text">{t("frp.import.source.text")}</Label>
              <Textarea
                id="frp-import-text"
                rows={8}
                value={text}
                spellCheck={false}
                className="font-mono text-xs"
                placeholder={t("frp.import.placeholder")}
                aria-invalid={errors.source ? true : undefined}
                onChange={(event) => {
                  setText(event.target.value);
                  invalidatePreview();
                }}
              />
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="frp-import-file">{t("frp.import.source.file")}</Label>
              <div className="flex items-center gap-2">
                <Input
                  id="frp-import-file"
                  readOnly
                  value={filePath ?? ""}
                  placeholder={t("frp.import.noFile")}
                  aria-invalid={errors.source ? true : undefined}
                  className="font-mono text-xs"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={previewing || importing}
                  onClick={() => void chooseFile()}
                >
                  <FileSearch />
                  {t("frp.import.chooseFile")}
                </Button>
              </div>
            </div>
          )}

          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={!currentSource || previewing || importing}
              onClick={() => void runPreview()}
            >
              {previewing ? <Loader2 className="animate-spin" /> : <FileSearch />}
              {previewing ? t("frp.import.previewing") : t("frp.import.preview")}
            </Button>
          </div>

          {errors.source && <p className="text-destructive text-xs">{errors.source}</p>}

          {preview && previewMatchesSource && (
            <div className="rounded-lg border p-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-muted-foreground text-xs font-medium">
                  {t("frp.import.previewTitle")}
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs">
                    {formatEndpoint(preview.serverAddr, preview.serverPort)}
                  </span>
                  <Badge variant={preview.tokenPresent ? "secondary" : "outline"}>
                    {preview.tokenPresent
                      ? t("frp.import.tokenDetected")
                      : t("frp.import.tokenMissing")}
                  </Badge>
                </div>
              </div>

              {preview.tunnels.length === 0 ? (
                <p className="mt-3 flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
                  <AlertTriangle className="size-3.5 shrink-0" />
                  {t("frp.import.noTunnels")}
                </p>
              ) : (
                <div className="border-border mt-3 overflow-x-auto rounded-md border">
                  <table className="w-full border-collapse text-xs">
                    <thead className="bg-muted/50 text-muted-foreground">
                      <tr>
                        <th scope="col" className="px-2 py-1.5 text-left font-medium">
                          {t("frp.import.col.name")}
                        </th>
                        <th scope="col" className="px-2 py-1.5 text-left font-medium">
                          {t("frp.import.col.type")}
                        </th>
                        <th scope="col" className="px-2 py-1.5 text-left font-medium">
                          {t("frp.import.col.local")}
                        </th>
                        <th scope="col" className="px-2 py-1.5 text-left font-medium">
                          {t("frp.import.col.public")}
                        </th>
                        <th scope="col" className="px-2 py-1.5 text-left font-medium">
                          {t("frp.import.col.enabled")}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.tunnels.map((tunnel, index) => (
                        <tr key={`${tunnel.name}-${index}`} className="border-border border-t">
                          <td className="px-2 py-1.5 font-medium">{tunnel.name}</td>
                          <td className="px-2 py-1.5">
                            <Badge variant="secondary">{tunnel.type.toUpperCase()}</Badge>
                          </td>
                          <td className="px-2 py-1.5 font-mono">
                            {formatEndpoint(tunnel.localIp, tunnel.localPort)}
                          </td>
                          <td className="px-2 py-1.5 font-mono">
                            {formatPublicAddress(tunnel, preview.serverAddr) ??
                              t("frp.tunnel.noPublicAddress")}
                          </td>
                          <td className="px-2 py-1.5">
                            {tunnel.enabled ? t("frp.common.enabled") : t("frp.common.disabled")}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {preview.warnings.length > 0 && (
                <div className="mt-3 flex flex-col gap-1">
                  <p className="text-muted-foreground text-xs font-medium">
                    {t("frp.import.warnings")}
                  </p>
                  <ul className="flex flex-col gap-0.5">
                    {preview.warnings.map((warning, index) => (
                      <li
                        key={`${warning}-${index}`}
                        className="text-muted-foreground flex items-start gap-1.5 text-xs"
                      >
                        <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
                        <span className="break-words">{warning}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="frp-import-name">{t("frp.import.name")}</Label>
            <Input
              id="frp-import-name"
              value={name}
              aria-invalid={errors.name ? true : undefined}
              onChange={(event) => {
                setName(event.target.value);
                setNameEdited(event.target.value.trim().length > 0);
              }}
            />
            {errors.name && <p className="text-destructive text-xs">{errors.name}</p>}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="frp-import-runtime-policy">{t("frp.import.runtimePolicy")}</Label>
            <Select
              value={runtimePolicy}
              onValueChange={(value) => changeRuntimePolicy(value as RuntimePolicy)}
            >
              <SelectTrigger id="frp-import-runtime-policy" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="recommended">
                  {t("frp.serverForm.runtimeRecommended")}
                </SelectItem>
                <SelectItem value="pinned">{t("frp.serverForm.runtimePinned")}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {runtimePolicy === "pinned" && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="frp-import-runtime">{t("frp.import.runtime")}</Label>
              {runtimes.length === 0 ? (
                <p className="text-muted-foreground text-xs">{t("frp.import.runtimeEmpty")}</p>
              ) : (
                <Select value={runtimeId ?? ""} onValueChange={(value) => setRuntimeId(value)}>
                  <SelectTrigger
                    id="frp-import-runtime"
                    className={cn("w-full", errors.runtime && "border-destructive")}
                  >
                    <SelectValue placeholder={t("frp.import.runtimePlaceholder")} />
                  </SelectTrigger>
                  <SelectContent>
                    {runtimes.map((runtime) => (
                      <SelectItem key={runtime.id} value={runtime.id}>
                        {formatVersion(runtime.version)} · {runtime.platform}/{runtime.architecture}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              {errors.runtime && <p className="text-destructive text-xs">{errors.runtime}</p>}
            </div>
          )}

          <div className="flex items-center justify-between gap-3">
            <Label htmlFor="frp-import-apply-token">{t("frp.import.applyToken")}</Label>
            <Switch
              id="frp-import-apply-token"
              checked={applyToken}
              disabled={preview !== null && !preview.tokenPresent}
              onCheckedChange={setApplyToken}
            />
          </div>

          <p className="text-muted-foreground text-xs">{t("frp.import.notStarted")}</p>

          {error && (
            <div className="border-destructive/40 bg-destructive/5 text-destructive flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-xs">
              <AlertTriangle className="size-4 shrink-0" />
              <span className="min-w-0 flex-1 break-words">{error}</span>
              {runtimeMissing && onOpenRuntime && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    onOpenChange(false);
                    onOpenRuntime();
                  }}
                >
                  {t("frp.import.openRuntime")}
                </Button>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            disabled={importing}
            onClick={() => onOpenChange(false)}
          >
            {t("frp.common.cancel")}
          </Button>
          <Button
            type="button"
            disabled={!previewMatchesSource || previewing || importing}
            onClick={() => void submit()}
          >
            {importing ? <Loader2 className="animate-spin" /> : <Upload />}
            {importing ? t("frp.import.importing") : t("frp.import.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
