// Shared export actions for the toolbar menu and the context menus.

import { useState } from "react";
import { save as saveFile } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { isMdEditorError } from "@/commands";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { useMdEditorStore } from "@/pages/md-editor/store";
import type { MdTabState } from "@/pages/md-editor/types";
import type { MdEditorSettings } from "@/commands/services/md-editor/types";
import { extractHeadings } from "../outline/extract";
import { exportHtml } from "./html";
import { LongImageExportError, exportLongImage } from "./image";
import { exportPdf } from "./pdf";

export type ExportKind = "html" | "image" | "pdf";

type Translate = ReturnType<typeof useAppTranslation>["t"];

const FILES: Record<ExportKind, { label: string; extension: string }> = {
  html: { label: "HTML", extension: "html" },
  image: { label: "PNG", extension: "png" },
  pdf: { label: "PDF", extension: "pdf" },
};

/** `notes.md` → `notes`; keeps names without a Markdown extension unchanged. */
function stripExtension(name: string): string {
  return name.replace(/\.(md|markdown)$/i, "") || name;
}

/** Default export path: next to the document, or the bare name for an untitled tab. */
function suggestedPath(tab: MdTabState, extension: string): string {
  const base = stripExtension(tab.name) || "untitled";
  const index = tab.path ? Math.max(tab.path.lastIndexOf("/"), tab.path.lastIndexOf("\\")) : -1;
  const directory = tab.path && index >= 0 ? tab.path.slice(0, index + 1) : "";
  return `${directory}${base}.${extension}`;
}

function describeError(error: unknown, t: Translate): string {
  if (error instanceof LongImageExportError) {
    return t(
      error.code === "too-large"
        ? "mdEditor.export.imageTooLarge"
        : "mdEditor.export.imageRenderFailed"
    );
  }
  if (isMdEditorError(error)) return error.message;
  return error instanceof Error ? error.message : String(error);
}

async function performExport(
  kind: ExportKind,
  tab: MdTabState,
  settings: MdEditorSettings,
  t: Translate,
  setBusy: (value: boolean) => void
): Promise<void> {
  setBusy(true);
  const toastId = toast.loading(t("mdEditor.export.exporting"));

  try {
    const file = FILES[kind];
    const target = await saveFile({
      defaultPath: suggestedPath(tab, file.extension),
      filters: [{ name: file.label, extensions: [file.extension] }],
    });
    if (!target) {
      toast.dismiss(toastId);
      return;
    }

    let scaleNote: string | null = null;
    const title = stripExtension(tab.name);

    if (kind === "html") {
      await exportHtml(
        {
          source: tab.content,
          docPath: tab.path,
          title,
          inlineStyles: settings.export.htmlInlineStyles,
          includeTitle: settings.export.htmlIncludeTitle,
        },
        target
      );
    } else if (kind === "image") {
      const requested = settings.export.imageScale;
      const result = await exportLongImage(
        {
          source: tab.content,
          docPath: tab.path,
          width: settings.appearance.contentWidth,
          scale: requested,
          includeOutline: settings.export.imageIncludeOutline,
          headings: extractHeadings(tab.content),
        },
        target
      );
      if (result.scale < requested) {
        scaleNote = t("mdEditor.export.scaleReduced", { scale: result.scale });
      }
    } else {
      await exportPdf(
        {
          source: tab.content,
          docPath: tab.path,
          title,
          page: settings.export.pdfPage === "letter" ? "letter" : "a4",
          marginMm: settings.export.pdfMarginMm,
        },
        target
      );
    }

    toast.success(t("mdEditor.export.success", { path: target }), { id: toastId });
    if (scaleNote) toast.info(scaleNote);
  } catch (error: unknown) {
    toast.error(t("mdEditor.export.failed", { message: describeError(error, t) }), {
      id: toastId,
    });
  } finally {
    setBusy(false);
  }
}

/** Export actions bound to the active tab; `runExport` is a no-op without one. */
export function useExportActions(): {
  busy: boolean;
  canExport: boolean;
  runExport(kind: ExportKind): void;
} {
  const { t } = useAppTranslation();
  const tabs = useMdEditorStore((state) => state.tabs);
  const activeId = useMdEditorStore((state) => state.activeId);
  const settings = useMdEditorStore((state) => state.settings);
  const [busy, setBusy] = useState(false);

  const tab = tabs.find((item) => item.id === activeId) ?? null;

  const runExport = (kind: ExportKind) => {
    if (!tab || busy) return;
    void performExport(kind, tab, settings, t, setBusy);
  };

  return { busy, canExport: tab !== null, runExport };
}
