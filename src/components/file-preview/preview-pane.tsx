import type { ReactNode } from "react";
import { Check, Loader2, Pencil, RefreshCw, ScanEye, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Preview } from "@/lib/preview/viewers/Preview";
import { resolveViewer } from "@/lib/preview/viewers/registry";
import { formatBytes } from "@/lib/preview/lib/format";
import type { FileMetadata, OpenTab } from "@/lib/preview/types";
import type { LoadState } from "@/lib/preview/viewers/previewTypes";

/**
 * The right-hand pane: a small toolbar over the viewer.
 *
 * The toolbar is the host's — shadcn buttons and Tailwind — and sits outside
 * `.ov-preview`, which is what keeps the viewer's own bare-`button` styles from
 * reaching it. Inside that container the viewer renders itself in its own CSS.
 *
 * `onClose` is only passed where the pane is covering something — a tab's preview
 * over an editor — so the page that owns the pane in a column of its own draws no
 * close button it has nothing to close.
 *
 * Editing is the host's too: the pane shows the button when `onEdit` is given,
 * and swaps the viewer for `editor` while `editing` is true. The pane knows
 * nothing about the text, the file or the save — it only draws the buttons.
 */
export function PreviewPane({
  payload,
  state,
  onReload,
  reloadLabel,
  emptyLabel,
  onClose,
  closeLabel,
  highlight = false,
  onEdit,
  editLabel,
  editing = false,
  dirty = false,
  dirtyLabel,
  saving = false,
  onSave,
  saveLabel,
  onCancel,
  cancelLabel,
  editor,
}: {
  payload: FileMetadata | null;
  state: LoadState;
  onReload: () => void;
  reloadLabel: string;
  emptyLabel: string;
  onClose?: () => void;
  closeLabel?: string;
  highlight?: boolean;
  onEdit?: () => void;
  editLabel?: string;
  editing?: boolean;
  dirty?: boolean;
  dirtyLabel?: string;
  saving?: boolean;
  onSave?: () => void;
  saveLabel?: string;
  onCancel?: () => void;
  cancelLabel?: string;
  editor?: ReactNode;
}) {
  const viewer = payload ? resolveViewer(payload.name) : null;
  const tab: OpenTab | undefined =
    payload && viewer ? { path: payload.path, name: payload.name, viewerId: viewer.id } : undefined;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="border-border flex h-10 shrink-0 items-center gap-2 border-b px-3">
        <span className="min-w-0 flex-1 truncate text-sm font-medium" title={payload?.path}>
          {payload?.name ?? ""}
        </span>
        {editing ? (
          <>
            {dirty && (
              <span
                className="bg-primary size-2 shrink-0 rounded-full"
                title={dirtyLabel}
                aria-label={dirtyLabel}
              />
            )}
            <Button size="sm" onClick={onSave} disabled={saving || !dirty}>
              {saving ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Check className="size-3.5" />
              )}
              {saveLabel}
            </Button>
            <Button variant="ghost" size="sm" onClick={onCancel} disabled={saving}>
              <X className="size-3.5" />
              {cancelLabel}
            </Button>
          </>
        ) : (
          <>
            {viewer && (
              <span className="text-muted-foreground shrink-0 text-xs">{viewer.label}</span>
            )}
            {payload && (
              <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                {formatBytes(payload.size)}
              </span>
            )}
            {onEdit && (
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={onEdit}
                title={editLabel}
                aria-label={editLabel}
              >
                <Pencil className="size-4" />
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={onReload}
              disabled={!payload}
              title={reloadLabel}
              aria-label={reloadLabel}
            >
              <RefreshCw className="size-4" />
            </Button>
            {onClose && (
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={onClose}
                title={closeLabel}
                aria-label={closeLabel}
              >
                <X className="size-4" />
              </Button>
            )}
          </>
        )}
      </div>
      {editing && editor ? (
        <div className="bg-background flex min-h-0 flex-1 flex-col">{editor}</div>
      ) : (
        <div className="ov-preview min-h-0 flex-1 overflow-hidden">
          {payload ? (
            <div className="viewer-surface h-full">
              <Preview
                tab={tab}
                viewer={viewer ?? undefined}
                payload={payload}
                state={state}
                highlight={highlight}
              />
            </div>
          ) : (
            <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-2 p-8 text-center text-sm">
              <ScanEye className="size-6" />
              <span>{emptyLabel}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
