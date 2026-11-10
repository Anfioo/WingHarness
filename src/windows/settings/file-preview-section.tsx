import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { useConfigDraft } from "@/hooks/use-config-draft";
import type { FilePreviewConfig } from "@/commands";

/** The range the backend clamps to, mirrored here so the field cannot lie. */
const MB = 1024 * 1024;
const MAX_SIZE = { min: 1, max: 1024 };

/** A value past the allowed range is pulled to the nearest bound, not dropped. */
function clampMb(value: number): number {
  return Math.min(MAX_SIZE.max, Math.max(MAX_SIZE.min, Math.round(value)));
}

/**
 * A number input that lets the field be empty while typing and commits on blur
 * or Enter, so a half-typed value is never written to the config.
 */
function SizeField({
  value,
  unit,
  disabled,
  onChange,
}: {
  value: number;
  unit: string;
  disabled?: boolean;
  onChange: (value: number) => void;
}) {
  const [text, setText] = useState(String(value));

  // Follow the stored value when it changes from outside (first load, retry).
  useEffect(() => {
    setText(String(value));
  }, [value]);

  const commit = () => {
    const trimmed = text.trim();
    const parsed = Number(trimmed);
    if (trimmed === "" || !Number.isFinite(parsed)) {
      setText(String(value));
      return;
    }
    const next = clampMb(parsed);
    setText(String(next));
    if (next !== value) onChange(next);
  };

  return (
    <div className="flex items-center gap-2">
      <Input
        type="number"
        className="w-24"
        value={text}
        min={MAX_SIZE.min}
        max={MAX_SIZE.max}
        step={1}
        disabled={disabled}
        onChange={(event) => setText(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
      />
      <span className="text-muted-foreground text-xs">{unit}</span>
    </div>
  );
}

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{label}</div>
        {hint && <div className="text-muted-foreground mt-0.5 text-xs">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

/**
 * How the preview page reads and paints files.
 *
 * The threshold decides what the backend is willing to read — it is enforced
 * where the bytes are read, not only in the page — so raising it is what lets a
 * bigger file open. The highlight switch reaches both the text viewers and the
 * editor that opened from the same toolbar.
 */
export function FilePreviewSection() {
  const { t } = useAppTranslation();
  const { draft, setDraft, loading } = useConfigDraft("file preview");

  const update = (patch: Partial<FilePreviewConfig>) => {
    setDraft((current) =>
      current ? { ...current, filePreview: { ...current.filePreview, ...patch } } : current
    );
  };

  const config = draft?.filePreview;

  return (
    <div className="space-y-4">
      <div>
        <h2 className="mb-1 text-lg font-semibold">{t("settings.filePreview.title")}</h2>
        <p className="text-muted-foreground text-sm">{t("settings.filePreview.description")}</p>
      </div>

      {loading && !config ? (
        <Skeleton className="h-40 rounded-xl" />
      ) : config ? (
        <div className="space-y-4">
          <div className="border-border divide-y rounded-xl border px-4">
            <Row
              label={t("settings.filePreview.maxSize")}
              hint={t("settings.filePreview.maxSizeHint")}
            >
              <SizeField
                value={Math.round(config.maxBytes / MB)}
                unit={t("settings.filePreview.maxSizeUnit")}
                onChange={(mb) => update({ maxBytes: clampMb(mb) * MB })}
              />
            </Row>
            <Row
              label={t("settings.filePreview.highlight")}
              hint={t("settings.filePreview.highlightHint")}
            >
              <Switch
                checked={config.highlight}
                onCheckedChange={(highlight) => update({ highlight })}
              />
            </Row>
          </div>

          <p className="text-muted-foreground text-xs">{t("settings.filePreview.autoSave")}</p>
        </div>
      ) : (
        <p className="text-muted-foreground text-sm">{t("settings.filePreview.loadFailed")}</p>
      )}
    </div>
  );
}
