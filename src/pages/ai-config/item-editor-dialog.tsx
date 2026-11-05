import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { shaicItemSource, shaicItemTemplate, shaicSaveItem, type ItemKind } from "@/commands";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { cn } from "@/lib/utils";

export type EditorTarget =
  | { mode: "new"; kind: ItemKind }
  | { mode: "edit"; kind: ItemKind; name: string };

/**
 * The TUI opens item text in `$EDITOR`; in-app we edit the same
 * frontmatter+body source in a textarea. The name comes from the item's
 * frontmatter — for a new item it is prefilled into the template, and a rename
 * is refused on save (as the TUI does).
 */
export function ItemEditorDialog({
  target,
  onClose,
  onSaved,
}: {
  target: EditorTarget | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useAppTranslation();
  const [name, setName] = useState("");
  const [source, setSource] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const isNew = target?.mode === "new";

  useEffect(() => {
    if (!target) return;
    setSource("");
    setName("");
    setLoading(true);
    if (target.mode === "edit") {
      setName(target.name);
      shaicItemSource(target.kind, target.name)
        .then(setSource)
        .catch((error) => {
          console.error("shaic item source:", error);
          toast.error(t("aiConfig.items.loadFailed"));
        })
        .finally(() => setLoading(false));
    } else {
      // A new item's name is part of its frontmatter; ask for it first, then
      // load the template. Default name keeps the template loadable.
      const defaultName = target.kind === "skill" ? "new-skill" : "new-item";
      setName(defaultName);
      shaicItemTemplate(target.kind, defaultName)
        .then(setSource)
        .catch((error) => {
          console.error("shaic item template:", error);
          toast.error(t("aiConfig.items.loadFailed"));
        })
        .finally(() => setLoading(false));
    }
  }, [target, t]);

  const reloadTemplate = (next: string) => {
    if (!target || target.mode !== "new" || !next) return;
    shaicItemTemplate(target.kind, next)
      .then(setSource)
      .catch((error) => console.error("shaic item template:", error));
  };

  const handleSave = async () => {
    if (!target) return;
    setSaving(true);
    try {
      const result = await shaicSaveItem(
        target.kind,
        source,
        target.mode === "edit" ? target.name : undefined
      );
      toast.success(result.text);
      onSaved();
      onClose();
    } catch (error) {
      console.error("shaic save item:", error);
      toast.error(String(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>
            {isNew ? t("aiConfig.items.newTitle") : t("aiConfig.items.editTitle")}
            {target && <span className="text-muted-foreground ml-2 text-sm">{target.kind}</span>}
          </DialogTitle>
          <DialogDescription>{t("aiConfig.items.editorHint")}</DialogDescription>
        </DialogHeader>

        {isNew && (
          <div className="flex items-center gap-2">
            <label className="text-muted-foreground text-sm">{t("aiConfig.items.name")}</label>
            <input
              value={name}
              onChange={(e) => {
                const next = e.target.value;
                setName(next);
                reloadTemplate(next);
              }}
              className="border-input bg-background focus-visible:ring-ring h-8 w-64 rounded-md border px-2 font-mono text-sm focus-visible:ring-1 focus-visible:outline-none"
            />
          </div>
        )}

        {loading ? (
          <div className="flex h-64 items-center justify-center gap-2 text-sm">
            <Loader2 className="size-4 animate-spin" />
            {t("aiConfig.loading")}
          </div>
        ) : (
          <Textarea
            value={source}
            onChange={(e) => setSource(e.target.value)}
            spellCheck={false}
            className={cn("h-80 resize-none font-mono text-xs leading-5")}
          />
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            {t("aiConfig.cancel")}
          </Button>
          <Button onClick={() => void handleSave()} disabled={loading || saving}>
            {saving && <Loader2 className="size-4 animate-spin" />}
            {t("aiConfig.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
