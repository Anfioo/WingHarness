import { useEffect, useState } from "react";
import { toast } from "sonner";
import { editorOpen, editorsDetect } from "@/commands";
import type { EditorInfo } from "@/commands";
import i18n from "@/i18n";

let cache: Promise<EditorInfo[]> | null = null;
const listeners = new Set<(editors: EditorInfo[]) => void>();

export function loadEditors(force = false): Promise<EditorInfo[]> {
  if (!cache || force) {
    cache = editorsDetect()
      .catch(() => [] as EditorInfo[])
      .then((editors) => {
        for (const listener of listeners) listener(editors);
        return editors;
      });
  }
  return cache;
}

export function useEditors(): { editors: EditorInfo[]; loading: boolean; rescan: () => void } {
  const [editors, setEditors] = useState<EditorInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [epoch, setEpoch] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const listener = (next: EditorInfo[]) => {
      if (cancelled) return;
      setEditors(next);
      setLoading(false);
    };
    listeners.add(listener);
    void loadEditors(epoch > 0).then((next) => {
      if (cancelled) return;
      setEditors(next);
      setLoading(false);
    });
    return () => {
      cancelled = true;
      listeners.delete(listener);
    };
  }, [epoch]);

  return { editors, loading, rescan: () => setEpoch((value) => value + 1) };
}

export function preferredEditor(
  editors: readonly EditorInfo[],
  editorId: string | null
): EditorInfo | null {
  return editors.find((editor) => editor.id === editorId) ?? editors[0] ?? null;
}

export function openInEditor(editorId: string, target: string): void {
  void editorOpen(editorId, target).catch((error) => {
    toast.error(
      i18n.t("gitRepo.extras.editor.openFailed", {
        error: (error as { message?: string }).message ?? error,
      })
    );
    void loadEditors(true);
  });
}
