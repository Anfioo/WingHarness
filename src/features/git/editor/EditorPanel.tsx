import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2, Pencil, Save, X } from "lucide-react";
import { readFile, writeFile } from "@/commands";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { confirmDialog } from "@/components/confirm";
import { useRepo } from "@/features/git/repository-store";
import { useUi } from "@/features/git/ui-store";
import { Hint, Kbd } from "@/features/git/diff/diff-ui";
import { modKey } from "@/features/git/utils";
import i18n from "@/i18n";

export const editorCloseShortcut = { current: null as (() => void) | null };

export function EditorPanel({ file }: { file: string }) {
  const repo = useRepo((s) => s.repo);
  const refreshStatus = useRepo((s) => s.refreshStatus);
  const closeEditor = useUi((s) => s.closeEditor);
  const [content, setContent] = useState<string | null>(null);
  const [savedContent, setSavedContent] = useState<string>("");
  const [saving, setSaving] = useState(false);

  const path = repo?.path ?? "";
  const dirty = content !== null && content !== savedContent;

  useEffect(() => {
    let cancelled = false;
    void readFile(path, file)
      .then((text) => {
        if (!cancelled) {
          setContent(text);
          setSavedContent(text);
        }
      })
      .catch((error) => {
        toast.error(
          i18n.t("gitRepo.editor.couldNotOpen", {
            file,
            error: (error as { message?: string }).message ?? String(error),
          })
        );
        closeEditor();
      });
    return () => {
      cancelled = true;
    };
  }, [path, file, closeEditor]);

  const save = async () => {
    if (content === null || saving) return;
    setSaving(true);
    try {
      await writeFile(path, file, content);
      setSavedContent(content);
      toast.success(i18n.t("gitRepo.editor.saved", { file }));
      await refreshStatus();
    } catch (error) {
      toast.error(
        i18n.t("gitRepo.editor.saveFailed", {
          error: (error as { message?: string }).message ?? String(error),
        })
      );
    } finally {
      setSaving(false);
    }
  };

  const requestClose = () => {
    if (!dirty) {
      closeEditor();
      return;
    }
    void confirmDialog({
      title: i18n.t("gitRepo.editor.discardTitle"),
      description: i18n.t("gitRepo.editor.discardDescription"),
      path: file,
      confirmLabel: i18n.t("gitRepo.editor.discardConfirm"),
      destructive: true,
    }).then((ok) => {
      if (ok) closeEditor();
    });
  };

  useEffect(() => {
    editorCloseShortcut.current = requestClose;
    return () => {
      editorCloseShortcut.current = null;
    };
  });

  return (
    <section
      className="animate-fade-in bg-background flex h-full flex-col"
      aria-label={i18n.t("gitRepo.editor.editing", { file })}
    >
      <div className="border-border bg-card flex h-10 shrink-0 items-center gap-2 border-b px-3">
        <Hint
          label={
            <span className="flex items-center gap-1">
              {i18n.t("gitRepo.editor.close")} <Kbd>Esc</Kbd>
            </span>
          }
        >
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={i18n.t("gitRepo.editor.close")}
            onClick={requestClose}
          >
            <X className="size-4" />
          </Button>
        </Hint>
        <Pencil className="text-primary size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate font-mono text-xs">{file}</span>
        {dirty && (
          <Badge className="bg-primary/15 text-primary border-transparent">
            {i18n.t("gitRepo.editor.unsaved")}
          </Badge>
        )}
        <Hint
          label={
            <span className="flex items-center gap-1">
              {i18n.t("gitRepo.editor.save")} <Kbd>{modKey()}</Kbd>
              <Kbd>S</Kbd>
            </span>
          }
        >
          <Button size="sm" disabled={!dirty || saving} onClick={() => void save()}>
            {saving ? <Loader2 className="animate-spin" /> : <Save />}
            {i18n.t("gitRepo.editor.save")}
          </Button>
        </Hint>
      </div>

      {content === null ? (
        <div className="flex flex-1 items-center justify-center">
          <Loader2 className="size-5 animate-spin" />
        </div>
      ) : (
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          spellCheck={false}
          autoFocus
          aria-label={i18n.t("gitRepo.editor.contentsOf", { file })}
          className="text-foreground min-h-0 flex-1 resize-none bg-transparent px-4 py-3 font-mono text-xs leading-5 focus:outline-none"
          style={{ tabSize: 4 }}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
              e.preventDefault();
              void save();
            } else if (e.key === "Escape") {
              e.preventDefault();
              requestClose();
            } else if (e.key === "Tab") {
              e.preventDefault();
              const el = e.currentTarget;
              const { selectionStart, selectionEnd, value } = el;
              const next = `${value.slice(0, selectionStart)}\t${value.slice(selectionEnd)}`;
              setContent(next);
              requestAnimationFrame(() => {
                el.selectionStart = el.selectionEnd = selectionStart + 1;
              });
            }
          }}
        />
      )}
    </section>
  );
}
