// Adapted from moin (MIT), https://github.com/exxvius/moin at 79e7587.
// See `src-tauri/moin-core/UPSTREAM.md` for the porting record.

import { useEffect, useRef, useState, type FormEvent } from "react";
import { ChevronDown, LoaderCircle, Plus, Sparkles, X } from "lucide-react";
import { toast } from "sonner";
import {
  isMoinError,
  moinAddDownload,
  moinErrorKey,
  moinSuggestCategory,
  type MoinCategory,
} from "@/commands";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
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
import { useAppTranslation } from "@/hooks/use-app-translation";

/**
 * "Add a download" dialog.
 *
 * The category is suggested by the engine: once the URL stops changing for
 * 400 ms, `moinSuggestCategory` fills the field in — unless the user already
 * picked a category by hand, which must never be overwritten.
 */
export interface AddDownloadDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  categories: MoinCategory[];
  onAdded: () => Promise<void> | void;
}

interface HeaderRow {
  id: number;
  name: string;
  value: string;
}

const AUTO_CATEGORY = "__auto__";

const SUGGEST_DEBOUNCE_MS = 400;

export function AddDownloadDialog({
  open,
  onOpenChange,
  categories,
  onAdded,
}: AddDownloadDialogProps) {
  const { t } = useAppTranslation();
  const [url, setUrl] = useState("");
  const [filename, setFilename] = useState("");
  const [categoryId, setCategoryId] = useState(AUTO_CATEGORY);
  const [headers, setHeaders] = useState<HeaderRow[]>([]);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Set as soon as the user picks a category, so the debounced suggestion
  // stops writing over a deliberate choice.
  const categoryPicked = useRef(false);
  const nextHeaderId = useRef(1);

  useEffect(() => {
    if (!open) return;
    setUrl("");
    setFilename("");
    setCategoryId(AUTO_CATEGORY);
    setHeaders([]);
    setAdvancedOpen(false);
    setFormError(null);
    setSubmitting(false);
    categoryPicked.current = false;
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const trimmed = url.trim();
    if (!trimmed) return;
    const handle = window.setTimeout(() => {
      void moinSuggestCategory(trimmed)
        .then((suggestion) => {
          if (suggestion && !categoryPicked.current) setCategoryId(suggestion);
        })
        .catch(() => undefined);
    }, SUGGEST_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [url, open]);

  const suggest = async () => {
    const trimmed = url.trim();
    if (!trimmed) return;
    try {
      const suggestion = await moinSuggestCategory(trimmed);
      if (suggestion) setCategoryId(suggestion);
    } catch (failure) {
      toast.error(isMoinError(failure) ? t(moinErrorKey(failure.code)) : String(failure));
    }
  };

  const addHeader = () => {
    setHeaders((current) => [...current, { id: nextHeaderId.current++, name: "", value: "" }]);
  };

  const updateHeader = (id: number, field: "name" | "value", next: string) => {
    setHeaders((current) =>
      current.map((row) => (row.id === id ? { ...row, [field]: next } : row))
    );
  };

  const removeHeader = (id: number) => {
    setHeaders((current) => current.filter((row) => row.id !== id));
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFormError(null);

    let parsed: URL;
    try {
      parsed = new URL(url.trim());
    } catch {
      setFormError("moin.add.invalidUrl");
      return;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      setFormError("moin.add.invalidUrl");
      return;
    }

    const headerMap: Record<string, string> = {};
    for (const row of headers) {
      const name = row.name.trim();
      const value = row.value.trim();
      if (!name && !value) continue;
      if (!name || !value) {
        setFormError("moin.add.invalidHeaders");
        return;
      }
      headerMap[name] = value;
    }

    setSubmitting(true);
    try {
      await moinAddDownload({
        url: parsed.toString(),
        category: categoryId === AUTO_CATEGORY ? null : categoryId,
        filename: filename.trim() || null,
        ...(Object.keys(headerMap).length > 0 ? { headers: headerMap } : {}),
      });
      toast.success(t("moin.add.success"));
      onOpenChange(false);
      await onAdded();
    } catch (failure) {
      toast.error(isMoinError(failure) ? t(moinErrorKey(failure.code)) : String(failure));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={(event) => void submit(event)} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{t("moin.add.title")}</DialogTitle>
          </DialogHeader>

          <div className="grid gap-2">
            <Label htmlFor="moin-add-url">{t("moin.add.url")}</Label>
            <Input
              id="moin-add-url"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder={t("moin.add.urlPlaceholder")}
              autoComplete="url"
              autoFocus
              disabled={submitting}
              required
            />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="moin-add-category">{t("moin.add.category")}</Label>
            <div className="flex min-w-0 items-center gap-2">
              <Select
                value={categoryId}
                onValueChange={(value) => {
                  categoryPicked.current = true;
                  setCategoryId(value);
                }}
                disabled={submitting}
              >
                <SelectTrigger id="moin-add-category" className="min-w-0 flex-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={AUTO_CATEGORY}>{t("moin.add.autoCategory")}</SelectItem>
                  {categories.map((category) => (
                    <SelectItem key={category.id} value={category.id}>
                      {category.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={submitting || url.trim().length === 0}
                onClick={() => void suggest()}
              >
                <Sparkles />
                {t("moin.add.suggest")}
              </Button>
            </div>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="moin-add-filename">{t("moin.add.filename")}</Label>
            <Input
              id="moin-add-filename"
              value={filename}
              onChange={(event) => setFilename(event.target.value)}
              placeholder={t("moin.add.filenamePlaceholder")}
              disabled={submitting}
            />
          </div>

          <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
            <CollapsibleTrigger asChild>
              <Button type="button" variant="ghost" size="sm" className="w-full justify-between">
                {t("moin.add.advanced")}
                <ChevronDown
                  className={
                    advancedOpen ? "rotate-180 transition-transform" : "transition-transform"
                  }
                />
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="grid gap-2 pt-2">
              <span className="text-sm font-medium">{t("moin.add.headers")}</span>
              {headers.length === 0 && (
                <p className="text-muted-foreground text-xs">{t("moin.add.headersPlaceholder")}</p>
              )}
              {headers.map((row) => (
                <div key={row.id} className="flex min-w-0 items-center gap-2">
                  <Input
                    value={row.name}
                    onChange={(event) => updateHeader(row.id, "name", event.target.value)}
                    placeholder={t("moin.add.headers")}
                    aria-label={t("moin.add.headers")}
                    disabled={submitting}
                    className="min-w-0 flex-1"
                  />
                  <Input
                    value={row.value}
                    onChange={(event) => updateHeader(row.id, "value", event.target.value)}
                    placeholder={t("moin.add.headersPlaceholder")}
                    aria-label={t("moin.add.headers")}
                    disabled={submitting}
                    className="min-w-0 flex-1"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t("moin.common.delete")}
                    disabled={submitting}
                    onClick={() => removeHeader(row.id)}
                  >
                    <X />
                  </Button>
                </div>
              ))}
              <div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={submitting}
                  onClick={addHeader}
                >
                  <Plus />
                  {t("moin.common.add")}
                </Button>
              </div>
            </CollapsibleContent>
          </Collapsible>

          {formError && (
            <p role="alert" className="text-destructive text-sm">
              {t(formError)}
            </p>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={submitting}
              onClick={() => onOpenChange(false)}
            >
              {t("moin.common.cancel")}
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? <LoaderCircle className="animate-spin" /> : <Plus />}
              {submitting ? t("moin.add.adding") : t("moin.add.submit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
