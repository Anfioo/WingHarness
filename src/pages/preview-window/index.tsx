// The standalone preview window: one file or folder at a time, following the
// file manager's selection, with the arrow keys stepping through a
// multi-selection and Space / Escape closing it.
//
// The window is declared hidden by `tauri.conf.json` and shown by the space
// agent; the viewer itself lives in `PreviewHost`.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { inspectFile } from "@/commands";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { useSpacePreviewPreferences } from "@/hooks/use-space-preview-preferences";
import { closeTab as dropTab, visibleTabs } from "@/lib/space-preview/preview-tabs";
import { usePreviewWindowSession } from "@/lib/space-preview/window-session";
import { PreviewHost } from "@/components/space-preview/host";
import { PreviewWindowFrame } from "@/components/space-preview/window/window-frame";
import { PreviewTabStrip } from "@/components/space-preview/window/tab-strip";
import { SelectionBar } from "@/components/space-preview/window/selection-bar";

// Keys typed into a field, a selector or a rich-text editor belong to it. The
// viewer's selects are Radix comboboxes rather than native <select> elements.
const EDITABLE_TARGET =
  "input, textarea, select, [role='combobox'], [role='listbox'], [role='option'], [contenteditable='true']";

export default function PreviewWindow() {
  const { t } = useAppTranslation();
  const { entries, current, index, text, showId, setCurrentPath, next, previous, close } =
    usePreviewWindowSession();
  const { preferences } = useSpacePreviewPreferences();
  const tabsEnabled = preferences.tabs;
  const [closed, setClosed] = useState<Set<string>>(() => new Set());
  const dirty = useRef(false);

  const handleDirtyChange = useCallback((value: boolean) => {
    dirty.current = value;
  }, []);

  const confirmDiscard = useCallback(
    () =>
      !dirty.current ||
      window.confirm(
        t("spacePreview.editor.discardConfirm", { defaultValue: "Discard the unsaved changes?" })
      ),
    [t]
  );

  // A new hand-off brings a fresh set of tabs.
  useEffect(() => {
    setClosed(new Set());
  }, [showId]);

  const tabs = useMemo(
    () => (tabsEnabled ? visibleTabs(entries, closed) : []),
    [tabsEnabled, entries, closed]
  );
  const activeEntry = tabsEnabled
    ? (tabs.find((tab) => tab.path === current?.path) ?? tabs[0] ?? null)
    : current;

  // The session owns the active index; a tab that closed itself hands the
  // viewer to its neighbour, so point the session there too.
  useEffect(() => {
    if (tabsEnabled && activeEntry && activeEntry.path !== current?.path) {
      setCurrentPath(activeEntry.path);
    }
  }, [tabsEnabled, activeEntry, current?.path, setCurrentPath]);

  const selectTab = useCallback(
    (path: string) => {
      if (path === current?.path || !confirmDiscard()) return;
      setCurrentPath(path);
    },
    [confirmDiscard, current?.path, setCurrentPath]
  );

  const closeTabAt = useCallback(
    (path: string) => {
      if (path === current?.path && !confirmDiscard()) return;
      const result = dropTab(tabs, current?.path ?? null, path);
      setClosed((previous) => new Set(previous).add(path));
      if (!result.activePath) {
        void close();
        return;
      }
      if (result.activePath !== current?.path) setCurrentPath(result.activePath);
    },
    [close, confirmDiscard, current?.path, setCurrentPath, tabs]
  );

  // Space and Escape put the window away; unsaved edits must be asked about
  // first, exactly like the host's own close button does.
  const requestClose = useCallback(async () => {
    if (!confirmDiscard()) return;
    await close();
  }, [close, confirmDiscard]);

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
        // A path that cannot be read is skipped.
        if (!info) continue;
        if (!confirmDiscard()) return;
        setCurrentPath(info.path);
        return;
      }
    },
    [confirmDiscard, setCurrentPath]
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
        <div className="flex h-full min-h-0 flex-col">
          {tabsEnabled && tabs.length > 1 && (
            <PreviewTabStrip
              tabs={tabs}
              activePath={activeEntry?.path ?? null}
              onSelect={selectTab}
              onClose={closeTabAt}
            />
          )}
          <div className="min-h-0 flex-1">
            <PreviewHost
              key={showId}
              mode="window"
              target={activeEntry}
              text={text}
              onDirtyChange={handleDirtyChange}
            />
          </div>
        </div>
      )}
    </PreviewWindowFrame>
  );
}
