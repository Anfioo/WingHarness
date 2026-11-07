// Ported from the openidea project (Apache-2.0) — see ./UPSTREAM.md.

/**
 * The statements one data source ran, newest first: search, preview, paste into
 * the console, delete one entry or clear the whole history.
 */

import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Eraser, Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { dbHistory, dbRemoveHistory, databaseErrorCode, type HistoryEntry } from "@/commands";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { cn } from "@/lib/utils";

export type HistoryDialogProps = {
  open: boolean;
  sourceId: string;
  onOpenChange(open: boolean): void;
  onPaste(text: string): void;
};

export function HistoryDialog({
  open,
  sourceId,
  onOpenChange,
  onPaste,
}: HistoryDialogProps): ReactNode {
  const { t } = useAppTranslation();

  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [confirmClear, setConfirmClear] = useState(false);
  const [busy, setBusy] = useState(false);

  // A closing dialog must not take the late answer of a request it made.
  const openRef = useRef(open);
  useEffect(() => {
    openRef.current = open;
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let live = true;
    setEntries(null);
    setFailure(null);
    setQuery("");
    setActive(0);
    setConfirmClear(false);
    setBusy(false);
    dbHistory(sourceId).then(
      (list) => {
        if (live) setEntries(list);
      },
      (error: unknown) => {
        if (!live) return;
        setEntries([]);
        setFailure(error);
      }
    );
    return () => {
      live = false;
    };
  }, [open, sourceId]);

  const describeFailure = (cause: unknown) => {
    const code = databaseErrorCode(cause);
    if (code) {
      return t(`database.error.${code}`, {
        defaultValue: (cause as { message: string }).message,
      });
    }
    return cause instanceof Error ? cause.message : String(cause);
  };

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const list = entries ?? [];
    return needle ? list.filter((entry) => entry.text.toLowerCase().includes(needle)) : list;
  }, [entries, query]);

  const activeIndex = shown.length === 0 ? -1 : Math.min(active, shown.length - 1);
  const current = activeIndex === -1 ? undefined : shown[activeIndex];

  const paste = (text: string) => {
    onPaste(text);
    onOpenChange(false);
  };

  const remove = async (texts: string[] | null) => {
    if (busy) return;
    setBusy(true);
    try {
      await dbRemoveHistory(sourceId, texts);
      if (!openRef.current) return;
      setEntries((list) =>
        texts ? (list ?? []).filter((entry) => !texts.includes(entry.text)) : []
      );
      setActive(0);
      setConfirmClear(false);
    } catch (error) {
      if (openRef.current) toast.error(describeFailure(error));
    } finally {
      if (openRef.current) setBusy(false);
    }
  };

  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setActive((index) =>
        Math.max(0, Math.min(shown.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))
      );
    } else if (event.key === "Enter" && current) {
      event.preventDefault();
      paste(current.text);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[820px]">
        <DialogHeader>
          <DialogTitle>{t("database.history.title")}</DialogTitle>
        </DialogHeader>

        <div className="flex h-[min(70vh,560px)] min-h-0 flex-col gap-3">
          {failure !== null && (
            <p className="text-destructive text-xs">{describeFailure(failure)}</p>
          )}

          <div className="flex min-h-0 flex-1 gap-3">
            <div className="flex w-[300px] shrink-0 flex-col gap-2 border-r pr-3">
              <div className="flex gap-2">
                <Input
                  autoFocus
                  value={query}
                  placeholder={t("database.history.search")}
                  aria-label={t("database.history.search")}
                  spellCheck={false}
                  onChange={(event) => {
                    setQuery(event.target.value);
                    setActive(0);
                  }}
                  onKeyDown={onSearchKeyDown}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  disabled={!current || busy}
                  aria-label={t("database.history.remove")}
                  title={t("database.history.remove")}
                  onClick={() => current && void remove([current.text])}
                >
                  <Trash2 />
                </Button>
              </div>

              <div className="min-h-0 flex-1 overflow-auto">
                {entries === null ? (
                  <p className="text-muted-foreground flex items-center gap-2 p-2 text-xs">
                    <Loader2 className="size-3 animate-spin" />
                    {t("database.history.loading")}
                  </p>
                ) : shown.length === 0 ? (
                  <p className="text-muted-foreground p-2 text-xs">{t("database.history.empty")}</p>
                ) : (
                  <ul
                    role="listbox"
                    aria-label={t("database.history.title")}
                    className="flex flex-col gap-0.5"
                  >
                    {shown.map((entry, index) => (
                      <li key={entry.text}>
                        <button
                          type="button"
                          role="option"
                          aria-selected={index === activeIndex}
                          className={cn(
                            "hover:bg-accent/60 w-full rounded-md px-2 py-1.5 text-left",
                            index === activeIndex && "bg-accent text-accent-foreground"
                          )}
                          title={new Date(entry.time).toLocaleString()}
                          onClick={() => setActive(index)}
                          onDoubleClick={() => paste(entry.text)}
                        >
                          <span className="line-clamp-2 font-mono text-xs break-all">
                            {entry.text.replace(/\s+/g, " ")}
                          </span>
                          <span className="text-muted-foreground mt-1 block text-[11px]">
                            {new Date(entry.time).toLocaleString()}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>

            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="text-muted-foreground text-xs font-medium">
                {t("database.history.preview")}
              </span>
              <pre
                className="bg-muted/40 min-h-0 flex-1 overflow-auto rounded-md border p-2 font-mono text-xs leading-5 whitespace-pre-wrap"
                aria-label={t("database.history.preview")}
              >
                {current?.text ?? ""}
              </pre>
            </div>
          </div>
        </div>

        <DialogFooter className="items-center gap-2 sm:justify-between">
          {confirmClear ? (
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground text-xs">
                {t("database.history.clearConfirm")}
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => setConfirmClear(false)}
              >
                {t("database.form.cancel")}
              </Button>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                disabled={busy}
                onClick={() => void remove(null)}
              >
                {t("database.history.clear")}
              </Button>
            </div>
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={!entries?.length || busy}
              onClick={() => setConfirmClear(true)}
            >
              <Eraser />
              {t("database.history.clear")}
            </Button>
          )}

          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t("database.history.close")}
            </Button>
            <Button
              type="button"
              disabled={!current}
              onClick={() => current && paste(current.text)}
            >
              {t("database.history.paste")}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
