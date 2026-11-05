import { useState, type ReactNode } from "react";
import { Plus, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { KeyValue } from "@/lib/api-core/types";

export interface KeyValueTableProps {
  /** The rows to edit; the parent owns the array and receives the next one. */
  rows: KeyValue[];
  /** Called with the whole next array on every edit. */
  onChange: (rows: KeyValue[]) => void;
  /** Placeholder and column header for the key column. */
  keyPlaceholder?: string;
  /** Placeholder and column header for the value column. */
  valuePlaceholder?: string;
  /** Label for the add-row control. */
  addLabel?: string;
  disabled?: boolean;
  className?: string;
  /**
   * Extra content rendered after the value input of each row, e.g. a multipart
   * file picker. When omitted the extra column is dropped entirely so the grid
   * stays tight for plain params/headers.
   */
  renderRowExtra?: (row: KeyValue, index: number) => ReactNode;
}

/**
 * An editable key/value grid: an enable checkbox, name and value inputs and a
 * delete button per row, plus an inline append row at the bottom. Params,
 * headers and form/multipart body fields all reuse it; multipart passes
 * `renderRowExtra` to hang a file picker off each row.
 */
export function KeyValueTable({
  rows,
  onChange,
  keyPlaceholder,
  valuePlaceholder,
  addLabel,
  disabled = false,
  className,
  renderRowExtra,
}: KeyValueTableProps): ReactNode {
  const { t } = useTranslation("translation", { keyPrefix: "apiClient.request.keyValue" });
  const [draftKey, setDraftKey] = useState("");
  const [draftValue, setDraftValue] = useState("");

  const hasExtra = renderRowExtra !== undefined;
  const columns = hasExtra
    ? "24px minmax(0,1fr) minmax(0,1fr) auto 26px"
    : "24px minmax(0,1fr) minmax(0,1fr) 26px";

  const updateRow = (index: number, patch: Partial<KeyValue>) =>
    onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  const removeRow = (index: number) => onChange(rows.filter((_, i) => i !== index));

  const commitDraft = () => {
    if (draftKey.trim() === "" && draftValue.trim() === "") return;
    onChange([...rows, { key: draftKey, value: draftValue, enabled: true }]);
    setDraftKey("");
    setDraftValue("");
  };

  const keyLabel = keyPlaceholder ?? t("key");
  const valueLabel = valuePlaceholder ?? t("value");
  const add = addLabel ?? t("add");

  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      <div
        className="text-muted-foreground grid items-center gap-x-2 border-b px-1 pb-1.5 text-[10px] font-semibold tracking-wide uppercase"
        style={{ gridTemplateColumns: columns }}
      >
        <span aria-hidden />
        <span>{keyLabel}</span>
        <span>{valueLabel}</span>
        {hasExtra ? <span aria-hidden /> : null}
        <span aria-hidden />
      </div>

      {rows.map((row, index) => (
        <div
          key={index}
          className="grid items-center gap-x-2 px-1 py-0.5"
          style={{ gridTemplateColumns: columns }}
        >
          <label className="flex items-center justify-center">
            <input
              type="checkbox"
              className="accent-primary size-3.5"
              checked={row.enabled}
              disabled={disabled}
              aria-label={t("enable", { name: row.key || index + 1 })}
              onChange={(event) => updateRow(index, { enabled: event.target.checked })}
            />
          </label>
          <Input
            value={row.key}
            disabled={disabled}
            spellCheck={false}
            placeholder={keyLabel}
            aria-label={keyLabel}
            className="h-8 text-xs"
            onChange={(event) => updateRow(index, { key: event.target.value })}
          />
          <Input
            value={row.value}
            disabled={disabled}
            spellCheck={false}
            placeholder={valueLabel}
            aria-label={valueLabel}
            className="h-8 text-xs"
            onChange={(event) => updateRow(index, { value: event.target.value })}
          />
          {hasExtra ? (
            <div className="flex min-w-0 items-center gap-1">{renderRowExtra?.(row, index)}</div>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            disabled={disabled}
            className="text-muted-foreground justify-self-center"
            aria-label={t("remove", { name: row.key || index + 1 })}
            title={t("remove", { name: row.key || index + 1 })}
            onClick={() => removeRow(index)}
          >
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      ))}

      {rows.length === 0 ? (
        <p className="text-muted-foreground px-1 py-2 text-[11px]">{t("empty")}</p>
      ) : null}

      <div
        className="grid items-center gap-x-2 px-1 py-0.5"
        style={{ gridTemplateColumns: columns }}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          commitDraft();
        }}
      >
        <span aria-hidden className="text-muted-foreground flex justify-center">
          <Plus className="size-3.5" />
        </span>
        <Input
          value={draftKey}
          disabled={disabled}
          spellCheck={false}
          placeholder={keyLabel}
          aria-label={t("add")}
          className="h-8 text-xs"
          onChange={(event) => setDraftKey(event.target.value)}
        />
        <Input
          value={draftValue}
          disabled={disabled}
          spellCheck={false}
          placeholder={valueLabel}
          aria-label={t("add")}
          className="h-8 text-xs"
          onChange={(event) => setDraftValue(event.target.value)}
        />
        {hasExtra ? <span aria-hidden /> : null}
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          disabled={disabled}
          className="justify-self-center"
          aria-label={add}
          title={add}
          onClick={commitDraft}
        >
          <Plus className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}

export default KeyValueTable;
