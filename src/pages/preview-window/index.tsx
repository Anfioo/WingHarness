// The standalone preview window: one file at a time, following the file
// manager's selection, with the arrow keys stepping through a multi-selection
// and Space / Escape closing it.
//
// The window is declared hidden by `tauri.conf.json` and shown by the space
// agent; the viewer itself lives in `PreviewHost`.

import { useCallback, useEffect, useRef } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { inspectFile } from "@/commands";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { usePreviewWindowSession } from "@/lib/space-preview/window-session";
import { PreviewHost } from "@/components/space-preview/host";
import { PreviewWindowFrame } from "@/components/space-preview/window/window-frame";
import { SelectionBar } from "@/components/space-preview/window/selection-bar";

// Keys typed into a field, a selector or a rich-text editor belong to it.
const EDITABLE_TARGET = "input, textarea, select, [contenteditable='true']";

export default function PreviewWindow() {
  const { t } = useAppTranslation();
  const { entries, current, index, text, showId, setCurrentPath, next, previous, close } =
    usePreviewWindowSession();
  const dirty = useRef(false);

  const handleDirtyChange = useCallback((value: boolean) => {
    dirty.current = value;
  }, []);

  // Space and Escape put the window away; unsaved edits must be asked about
  // first, exactly like the host's own close button does.
  const requestClose = useCallback(async () => {
    if (
      dirty.current &&
      !window.confirm(
        t("spacePreview.editor.discardConfirm", { defaultValue: "Discard the unsaved changes?" })
      )
    )
      return;
    await close();
  }, [close, t]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // A viewer widget or another handler already claimed this key.
      if (event.defaultPrevented || event.isComposing) return;
      if (event.ctrlKey || event.altKey || event.metaKey) return;
      if (event.target instanceof Element && event.target.closest(EDITABLE_TARGET)) return;

      switch (event.key) {
        case "Escape":
          event.preventDefault();
          void requestClose();
          return;
        case " ":
          event.preventDefault();
          if (!event.repeat) void requestClose();
          return;
        case "ArrowUp":
        case "ArrowLeft":
          event.preventDefault();
          void previous();
          return;
        case "ArrowDown":
        case "ArrowRight":
          event.preventDefault();
          void next();
          return;
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [next, previous, requestClose]);

  const openDropped = useCallback(
    async (paths: string[]) => {
      for (const path of paths) {
        const info = await inspectFile(path).catch(() => null);
        // Dropped folders and paths that cannot be read are skipped.
        if (!info || info.directory) continue;
        if (
          dirty.current &&
          !window.confirm(
            t("spacePreview.editor.discardConfirm", {
              defaultValue: "Discard the unsaved changes?",
            })
          )
        )
          return;
        setCurrentPath(info.path);
        return;
      }
    },
    [setCurrentPath, t]
  );

  // Drops arrive on the webview, not on a DOM element.
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let cancelled = false;

    void getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type === "drop") void openDropped(event.payload.paths);
      })
      .then((stop) => {
        if (cancelled) stop();
        else unlisten = stop;
      })
      .catch((error: unknown) => console.error("Failed to watch for dropped files:", error));

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [openDropped]);

  return (
    <PreviewWindowFrame
      onClose={() => void requestClose()}
      bar={
        <SelectionBar
          index={index}
          total={entries.length}
          disabled={!current}
          onPrevious={() => void previous()}
          onNext={() => void next()}
        />
      }
    >
      {/* The window is hidden until the agent hands files over, so the viewer
          only exists from the first hand-off on. */}
      {showId > 0 && (
        <PreviewHost
          key={showId}
          mode="window"
          target={current}
          text={text}
          onDirtyChange={handleDirtyChange}
        />
      )}
    </PreviewWindowFrame>
  );
}
