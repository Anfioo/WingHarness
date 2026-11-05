import { Paperclip, X } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { useTranslation } from "react-i18next";
import { KeyValueTable } from "@/components/api-client/key-value-table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { withBodyKind } from "@/lib/api-core/request-model";
import type { BodyKind, KeyValue, RequestBody } from "@/lib/api-core/types";

/** The body kinds in picker order. */
const BODY_KINDS: readonly BodyKind[] = ["none", "json", "form", "multipart", "raw"];

/** The final path segment of a local file path. */
function fileName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

export interface BodyEditorProps {
  body: RequestBody;
  onChange: (body: RequestBody) => void;
}

/**
 * The Body tab: switch the body kind and edit the matching payload. `json`/`raw`
 * use a text area (raw also carries its content type), `form`/`multipart` use the
 * key/value grid, and each multipart row can pick a local file whose path is
 * recorded in `body.filePaths` under the field name.
 */
export function BodyEditor({ body, onChange }: BodyEditorProps) {
  const { t } = useTranslation("translation", { keyPrefix: "apiClient.request.body" });
  const { t: tCommon } = useTranslation("translation", { keyPrefix: "apiClient.common" });

  const setRows = (rows: KeyValue[]) => onChange({ ...body, rows });

  const pickFile = async (row: KeyValue) => {
    if (row.key.trim() === "") return;
    const selected = await open({ multiple: false, directory: false });
    if (typeof selected === "string") {
      onChange({ ...body, filePaths: { ...body.filePaths, [row.key]: selected } });
    }
  };

  const clearFile = (row: KeyValue) => {
    const next = { ...body.filePaths };
    delete next[row.key];
    onChange({ ...body, filePaths: next });
  };

  /** Per-row file affordance for multipart fields; the path lives in `filePaths`. */
  const renderFileExtra = (row: KeyValue) => {
    const path = row.key ? body.filePaths[row.key] : undefined;
    const canPick = row.key.trim() !== "";
    const pickLabel = canPick ? t("file") : t("fileHint");
    return (
      <>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="shrink-0"
          disabled={!canPick}
          aria-label={pickLabel}
          title={pickLabel}
          onClick={() => void pickFile(row)}
        >
          <Paperclip className="size-3.5" />
        </Button>
        {path ? (
          <>
            <span className="text-muted-foreground max-w-24 truncate text-[11px]" title={path}>
              {fileName(path)}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="shrink-0"
              aria-label={t("clearFile")}
              title={t("clearFile")}
              onClick={() => clearFile(row)}
            >
              <X className="size-3" />
            </Button>
          </>
        ) : null}
      </>
    );
  };

  const kindLabel = (kind: BodyKind) =>
    kind === "none" ? tCommon("labels.none") : t(`kind.${kind}`);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Label htmlFor="body-kind" className="text-xs">
          {t("label")}
        </Label>
        <Select
          value={body.kind}
          onValueChange={(value) => onChange(withBodyKind(body, value as BodyKind))}
        >
          <SelectTrigger id="body-kind" size="sm" className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {BODY_KINDS.map((kind) => (
              <SelectItem key={kind} value={kind}>
                {kindLabel(kind)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {body.kind === "json" || body.kind === "raw" ? (
        <Textarea
          value={body.text}
          spellCheck={false}
          placeholder={body.kind === "json" ? t("jsonPlaceholder") : t("rawPlaceholder")}
          aria-label={t("label")}
          className="min-h-40 resize-y font-mono text-xs"
          onChange={(event) => onChange({ ...body, text: event.target.value })}
        />
      ) : null}

      {body.kind === "raw" ? (
        <div className="flex items-center gap-2">
          <Label htmlFor="raw-content-type" className="text-xs">
            {t("contentType")}
          </Label>
          <Input
            id="raw-content-type"
            value={body.rawContentType}
            spellCheck={false}
            placeholder={t("contentTypePlaceholder")}
            className="h-8 max-w-64 text-xs"
            onChange={(event) => onChange({ ...body, rawContentType: event.target.value })}
          />
        </div>
      ) : null}

      {body.kind === "form" || body.kind === "multipart" ? (
        <KeyValueTable
          rows={body.rows}
          onChange={setRows}
          keyPlaceholder={t("keyPlaceholder")}
          valuePlaceholder={t("valuePlaceholder")}
          addLabel={t("addField")}
          renderRowExtra={body.kind === "multipart" ? renderFileExtra : undefined}
        />
      ) : null}
    </div>
  );
}

export default BodyEditor;
