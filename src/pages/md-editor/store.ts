// Module-level store for the Markdown editor.
//
// It lives outside React on purpose: the page can be unmounted (navigating
// away, or closing the window's page) and come back to the same buffers,
// cursors and view modes. Every piece of persisted data goes through the
// `md_editor_*` commands — nothing here touches localStorage.

import { open as openFileDialog, save as saveFileDialog } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { create } from "zustand";
import {
  mdEditorErrorCode,
  mdEditorOpenFile,
  mdEditorRecentAdd,
  mdEditorRecentList,
  mdEditorSaveFile,
  mdEditorSessionGet,
  mdEditorSessionSet,
  mdEditorSettingsGet,
  mdEditorSettingsSet,
} from "@/commands";
import { clearAssetsCache } from "@/features/md-editor/preview/assets";
import i18n from "@/i18n";
import type {
  MdCursor,
  MdEditorSettings,
  MdEditorStore,
  MdRecentEntry,
  MdReadResult,
  MdSession,
  MdTabState,
  ViewMode,
} from "./types";

export const DEFAULT_SETTINGS: MdEditorSettings = {
  version: 1,
  appearance: {
    fontFamily: "",
    fontSize: 14,
    lineHeight: 1.7,
    contentWidth: 860,
    codeFontFamily: "",
  },
  behavior: {
    lineWrap: true,
    lineNumbers: true,
    tabSize: 2,
    autoSave: false,
    autoSaveIntervalSec: 30,
  },
  view: {
    defaultMode: "split",
    splitRatio: 0.5,
    outlineVisible: true,
    outlineWidth: 240,
  },
  export: {
    htmlInlineStyles: true,
    htmlIncludeTitle: true,
    imageScale: 2,
    imageIncludeOutline: false,
    pdfPage: "a4",
    pdfMarginMm: 15,
  },
};

export type MdUnsavedChoice = "save" | "discard" | "cancel";
export type MdConflictChoice = "overwrite" | "discard" | "saveAs";
export type MdPromptChoice = MdUnsavedChoice | MdConflictChoice;

export type MdPromptRequest =
  | { id: string; kind: "unsaved"; name: string; resolve(choice: MdUnsavedChoice): void }
  | { id: string; kind: "conflict"; name: string; resolve(choice: MdConflictChoice): void };

export interface MdEditorState extends MdEditorStore {
  settings: MdEditorSettings;
  settingsLoaded: boolean;
  recent: MdRecentEntry[];
  /** Ids of tabs whose write is in flight, for the status bar. */
  savingIds: Record<string, boolean>;
  /** The confirmation the page should render, if any. */
  prompt: MdPromptRequest | null;

  active(): MdTabState | null;
  isDirty(id: string): boolean;
  setActive(id: string): void;

  bootstrap(): Promise<void>;
  loadSettings(): Promise<void>;
  refreshRecent(): Promise<void>;
  restoreSession(): Promise<void>;
  flushSession(): Promise<void>;
  setSettings(next: MdEditorSettings): void;
  setSplitRatio(ratio: number): void;
  setCursor(id: string, cursor: MdCursor): void;
  setScrollTop(id: string, top: number): void;
  openPicker(): Promise<void>;
  answerPrompt(choice: MdPromptChoice): void;
}

const SESSION_DEBOUNCE_MS = 2000;
const SETTINGS_DEBOUNCE_MS = 400;

let tabCounter = 0;
let sessionTimer: ReturnType<typeof setTimeout> | null = null;
let settingsTimer: ReturnType<typeof setTimeout> | null = null;
let autoSaveTimer: ReturnType<typeof setInterval> | null = null;
let sessionReady = false;
let bootstrapped = false;

/** Scroll offsets are view state, not document state: they stay out of `tabs`. */
const scrollTops = new Map<string, number>();
const promptQueue: MdPromptRequest[] = [];

export function getTabScrollTop(id: string): number {
  return scrollTops.get(id) ?? 0;
}

function createId(): string {
  tabCounter += 1;
  return `md-tab-${Date.now().toString(36)}-${tabCounter}`;
}

function errorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

function samePath(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function readErrorText(error: unknown, path: string): string {
  switch (mdEditorErrorCode(error)) {
    case "not-found":
      return i18n.t("mdEditor.error.notFound", { path });
    case "binary-file":
      return i18n.t("mdEditor.error.binary");
    case "encoding-failed":
      return i18n.t("mdEditor.error.notUtf8");
    default:
      return errorMessage(error);
  }
}

function nextUntitledName(tabs: MdTabState[]): string {
  const label = i18n.t("mdEditor.tab.untitled");
  const used = new Set(tabs.map((tab) => tab.name));
  let index = 1;
  while (used.has(`${label} ${index}`)) index += 1;
  return `${label} ${index}`;
}

function defaultSavePath(tab: MdTabState): string {
  if (tab.path) return tab.path;
  return /\.(md|markdown)$/i.test(tab.name) ? tab.name : `${tab.name}.md`;
}

function setSaving(id: string, saving: boolean): void {
  useMdEditorStore.setState((state) => {
    if (saving) return { savingIds: { ...state.savingIds, [id]: true } };
    if (!state.savingIds[id]) return state;
    const next = { ...state.savingIds };
    delete next[id];
    return { savingIds: next };
  });
}

function scheduleSessionSave(): void {
  if (!sessionReady) return;
  if (sessionTimer !== null) clearTimeout(sessionTimer);
  sessionTimer = setTimeout(() => {
    sessionTimer = null;
    void useMdEditorStore.getState().flushSession();
  }, SESSION_DEBOUNCE_MS);
}

function scheduleSettingsSave(): void {
  if (settingsTimer !== null) clearTimeout(settingsTimer);
  settingsTimer = setTimeout(() => {
    settingsTimer = null;
    const { settings } = useMdEditorStore.getState();
    mdEditorSettingsSet(settings).catch((error: unknown) => {
      console.warn("markdown editor: failed to save settings", error);
    });
  }, SETTINGS_DEBOUNCE_MS);
}

function rescheduleAutoSave(settings: MdEditorSettings): void {
  if (autoSaveTimer !== null) {
    clearInterval(autoSaveTimer);
    autoSaveTimer = null;
  }
  if (!settings.behavior.autoSave) return;

  const seconds = Math.max(5, settings.behavior.autoSaveIntervalSec);
  autoSaveTimer = setInterval(() => {
    void autoSaveTick();
  }, seconds * 1000);
}

async function autoSaveTick(): Promise<void> {
  const { tabs } = useMdEditorStore.getState();
  const targets = tabs.filter((tab) => tab.path !== null && tab.content !== tab.savedContent);
  for (const tab of targets) {
    try {
      await writeTab(tab.id, tab.mtimeMs);
    } catch (error) {
      // Auto save never interrupts typing; a conflict is reported and retried
      // on the next tick only after the user saves by hand.
      if (mdEditorErrorCode(error) === "conflict-external-change") {
        toast.warning(i18n.t("mdEditor.error.conflictExternalChange"));
      } else {
        toast.error(errorMessage(error));
      }
    }
  }
}

/** Writes a tab that already has a path. Throws the engine's error untouched. */
async function writeTab(id: string, expectedMtimeMs: number | null): Promise<void> {
  const tab = useMdEditorStore.getState().tabs.find((entry) => entry.id === id);
  if (!tab?.path) throw new Error("markdown tab has no path");

  const path = tab.path;
  const snapshot = tab.content;
  const { encoding, eol } = tab;

  setSaving(id, true);
  try {
    const result = await mdEditorSaveFile(path, snapshot, encoding, eol, expectedMtimeMs);
    useMdEditorStore.setState((state) => ({
      tabs: state.tabs.map((entry) =>
        entry.id === id ? { ...entry, savedContent: snapshot, mtimeMs: result.mtimeMs } : entry
      ),
    }));
  } finally {
    setSaving(id, false);
  }
}

/** Saves a tab under a new path, then renames it and records it as recent. */
async function writeTabAs(id: string, path: string): Promise<boolean> {
  const tab = useMdEditorStore.getState().tabs.find((entry) => entry.id === id);
  if (!tab) return false;

  const snapshot = tab.content;
  const { encoding, eol } = tab;

  setSaving(id, true);
  try {
    const result = await mdEditorSaveFile(path, snapshot, encoding, eol, null);
    useMdEditorStore.setState((state) => ({
      tabs: state.tabs.map((entry) =>
        entry.id === id
          ? {
              ...entry,
              path,
              name: baseName(path),
              mtimeMs: result.mtimeMs,
              savedContent: snapshot,
            }
          : entry
      ),
    }));
  } catch (error) {
    toast.error(errorMessage(error));
    return false;
  } finally {
    setSaving(id, false);
  }

  try {
    const list = await mdEditorRecentAdd(path);
    useMdEditorStore.setState({ recent: list.entries });
  } catch (error) {
    console.warn("markdown editor: failed to record the recent file", error);
  }
  return true;
}

function enqueuePrompt(request: MdPromptRequest): void {
  promptQueue.push(request);
  if (promptQueue.length === 1) useMdEditorStore.setState({ prompt: request });
}

function askUnsaved(name: string): Promise<MdUnsavedChoice> {
  return new Promise((resolve) => {
    enqueuePrompt({ id: createId(), kind: "unsaved", name, resolve });
  });
}

function askConflict(name: string): Promise<MdConflictChoice> {
  return new Promise((resolve) => {
    enqueuePrompt({ id: createId(), kind: "conflict", name, resolve });
  });
}

/**
 * Asks about every dirty tab without closing any of them. Used when the window
 * is about to close: the tabs are about to disappear either way, so cancelling
 * has to leave the buffers untouched.
 */
export async function confirmDiscardAll(): Promise<boolean> {
  const { tabs } = useMdEditorStore.getState();
  for (const tab of tabs) {
    if (tab.content === tab.savedContent) continue;
    const choice = await askUnsaved(tab.name);
    if (choice === "cancel") return false;
    if (choice !== "save") continue;
    await useMdEditorStore.getState().save(tab.id);
    const after = useMdEditorStore.getState().tabs.find((entry) => entry.id === tab.id);
    if (!after || after.content !== after.savedContent) return false;
  }
  return true;
}

export const useMdEditorStore = create<MdEditorState>((set, get) => ({
  tabs: [],
  activeId: null,
  settings: DEFAULT_SETTINGS,
  settingsLoaded: false,
  recent: [],
  savingIds: {},
  prompt: null,

  active(): MdTabState | null {
    const { tabs, activeId } = get();
    return tabs.find((tab) => tab.id === activeId) ?? null;
  },

  isDirty(id: string): boolean {
    const tab = get().tabs.find((entry) => entry.id === id);
    return tab ? tab.content !== tab.savedContent : false;
  },

  setActive(id: string): void {
    if (get().activeId === id) return;
    set({ activeId: id });
    scheduleSessionSave();
  },

  async bootstrap(): Promise<void> {
    if (bootstrapped) return;
    bootstrapped = true;
    // Settings first: the default view mode applies to the restored tabs.
    await Promise.all([get().loadSettings(), get().refreshRecent()]);
    await get().restoreSession();
    sessionReady = true;
  },

  async loadSettings(): Promise<void> {
    try {
      const settings = await mdEditorSettingsGet();
      set({ settings, settingsLoaded: true });
      rescheduleAutoSave(settings);
    } catch (error) {
      console.warn("markdown editor: failed to load settings", error);
      set({ settingsLoaded: true });
      rescheduleAutoSave(get().settings);
    }
  },

  async refreshRecent(): Promise<void> {
    try {
      const list = await mdEditorRecentList();
      set({ recent: list.entries });
    } catch (error) {
      console.warn("markdown editor: failed to load recent files", error);
    }
  },

  async openFile(path: string): Promise<void> {
    const existing = get().tabs.find((tab) => tab.path !== null && samePath(tab.path, path));
    if (existing) {
      set({ activeId: existing.id });
      scheduleSessionSave();
      return;
    }

    let result: MdReadResult;
    try {
      result = await mdEditorOpenFile(path);
    } catch (error) {
      toast.error(readErrorText(error, path));
      return;
    }

    const tab: MdTabState = {
      id: createId(),
      path,
      name: baseName(path),
      content: result.content,
      savedContent: result.content,
      encoding: result.encoding,
      eol: result.eol,
      mtimeMs: result.mtimeMs,
      viewMode: get().settings.view.defaultMode,
      cursor: { line: 1, column: 1 },
    };
    set((state) => ({ tabs: [...state.tabs, tab], activeId: tab.id }));
    scheduleSessionSave();
  },

  newUntitled(): void {
    const tabs = get().tabs;
    const tab: MdTabState = {
      id: createId(),
      path: null,
      name: nextUntitledName(tabs),
      content: "",
      savedContent: "",
      encoding: "utf-8",
      eol: "\n",
      mtimeMs: null,
      viewMode: get().settings.view.defaultMode,
      cursor: { line: 1, column: 1 },
    };
    set((state) => ({ tabs: [...state.tabs, tab], activeId: tab.id }));
    scheduleSessionSave();
  },

  async closeTab(id: string): Promise<boolean> {
    const tab = get().tabs.find((entry) => entry.id === id);
    if (!tab) return true;

    if (tab.content !== tab.savedContent) {
      const choice = await askUnsaved(tab.name);
      if (choice === "cancel") return false;
      if (choice === "save") {
        await get().save(id);
        const after = get().tabs.find((entry) => entry.id === id);
        // Untitled tabs close only after a save actually produced a path.
        if (!after) return true;
        if (after.content !== after.savedContent) return false;
      }
    }

    set((state) => {
      const index = state.tabs.findIndex((entry) => entry.id === id);
      const tabs = state.tabs.filter((entry) => entry.id !== id);
      const activeId =
        state.activeId === id
          ? (tabs[Math.min(Math.max(index, 0), tabs.length - 1)]?.id ?? null)
          : state.activeId;
      return { tabs, activeId };
    });
    scrollTops.delete(id);
    clearAssetsCache();
    scheduleSessionSave();
    return true;
  },

  async save(id: string): Promise<void> {
    const tab = get().tabs.find((entry) => entry.id === id);
    if (!tab) return;
    if (!tab.path) {
      await get().saveAs(id);
      return;
    }

    try {
      await writeTab(id, tab.mtimeMs);
      return;
    } catch (error) {
      if (mdEditorErrorCode(error) !== "conflict-external-change") {
        toast.error(errorMessage(error));
        return;
      }
    }

    const choice = await askConflict(tab.name);
    if (choice === "overwrite") {
      try {
        await writeTab(id, null);
      } catch (error) {
        toast.error(errorMessage(error));
      }
    } else if (choice === "saveAs") {
      await get().saveAs(id);
    }
  },

  async saveAs(id: string): Promise<void> {
    const tab = get().tabs.find((entry) => entry.id === id);
    if (!tab) return;

    let path: string | null = null;
    try {
      path = await saveFileDialog({
        defaultPath: defaultSavePath(tab),
        filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
      });
    } catch (error) {
      toast.error(errorMessage(error));
      return;
    }
    if (!path) return;

    await writeTabAs(id, path);
  },

  setContent(id: string, content: string): void {
    set((state) => {
      const tab = state.tabs.find((entry) => entry.id === id);
      if (!tab || tab.content === content) return state;
      return {
        tabs: state.tabs.map((entry) => (entry.id === id ? { ...entry, content } : entry)),
      };
    });
  },

  setViewMode(id: string, mode: ViewMode): void {
    const tab = get().tabs.find((entry) => entry.id === id);
    if (!tab || tab.viewMode === mode) return;
    set((state) => ({
      tabs: state.tabs.map((entry) => (entry.id === id ? { ...entry, viewMode: mode } : entry)),
    }));
    scheduleSessionSave();
  },

  setCursor(id: string, cursor: MdCursor): void {
    const tab = get().tabs.find((entry) => entry.id === id);
    if (!tab) return;
    if (tab.cursor.line === cursor.line && tab.cursor.column === cursor.column) return;
    set((state) => ({
      tabs: state.tabs.map((entry) => (entry.id === id ? { ...entry, cursor } : entry)),
    }));
    scheduleSessionSave();
  },

  setScrollTop(id: string, top: number): void {
    if (scrollTops.get(id) === top) return;
    scrollTops.set(id, top);
    scheduleSessionSave();
  },

  async openPicker(): Promise<void> {
    let picked: string | string[] | null = null;
    try {
      picked = await openFileDialog({
        multiple: true,
        directory: false,
        filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
      });
    } catch (error) {
      toast.error(errorMessage(error));
      return;
    }
    if (!picked) return;

    const paths = Array.isArray(picked) ? picked : [picked];
    for (const path of paths) await get().openFile(path);
  },

  async restoreSession(): Promise<void> {
    let session: MdSession;
    try {
      session = await mdEditorSessionGet();
    } catch (error) {
      console.warn("markdown editor: failed to load the session", error);
      return;
    }

    for (const entry of session.tabs ?? []) {
      await get().openFile(entry.path);
      const tab = get().tabs.find((item) => item.path !== null && samePath(item.path, entry.path));
      // Missing files were reported by `openFile`; the rest of the session still restores.
      if (!tab) continue;

      scrollTops.set(tab.id, entry.scrollTop ?? 0);
      set((state) => ({
        tabs: state.tabs.map((item) =>
          item.id === tab.id
            ? {
                ...item,
                cursor: entry.cursor ?? item.cursor,
                viewMode: entry.viewMode ?? item.viewMode,
              }
            : item
        ),
      }));
    }

    if (session.activePath) {
      const activePath = session.activePath;
      const active = get().tabs.find(
        (item) => item.path !== null && samePath(item.path, activePath)
      );
      if (active) set({ activeId: active.id });
    }
  },

  async flushSession(): Promise<void> {
    if (sessionTimer !== null) {
      clearTimeout(sessionTimer);
      sessionTimer = null;
    }
    if (!sessionReady) return;

    const { tabs, activeId } = get();
    const session: MdSession = {
      tabs: tabs
        .filter((tab) => tab.path !== null)
        .map((tab) => ({
          path: tab.path as string,
          cursor: tab.cursor,
          scrollTop: scrollTops.get(tab.id) ?? 0,
          viewMode: tab.viewMode,
        })),
      activePath: tabs.find((tab) => tab.id === activeId)?.path ?? null,
    };

    try {
      await mdEditorSessionSet(session);
    } catch (error) {
      console.warn("markdown editor: failed to save the session", error);
    }
  },

  setSettings(next: MdEditorSettings): void {
    set({ settings: next });
    rescheduleAutoSave(next);
    scheduleSettingsSave();
  },

  setSplitRatio(ratio: number): void {
    const clamped = Math.min(0.95, Math.max(0.05, ratio));
    const { settings } = get();
    if (settings.view.splitRatio === clamped) return;
    get().setSettings({ ...settings, view: { ...settings.view, splitRatio: clamped } });
  },

  answerPrompt(choice: MdPromptChoice): void {
    const current = promptQueue.shift();
    if (current?.kind === "unsaved") {
      if (choice === "save" || choice === "discard") current.resolve(choice);
      else current.resolve("cancel");
    } else if (current?.kind === "conflict") {
      if (choice === "overwrite" || choice === "saveAs") current.resolve(choice);
      else current.resolve("discard");
    }
    useMdEditorStore.setState({ prompt: promptQueue[0] ?? null });
  },
}));
