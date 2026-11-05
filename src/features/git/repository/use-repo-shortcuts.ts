import { useEffect } from "react";
import { open as pickDirectory } from "@tauri-apps/plugin-dialog";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { orderRepoTabs } from "@/lib/git-core";
import { gitStateStorage } from "@/features/git/persist-storage";
import { useRepo } from "@/features/git/repository-store";
import { useGitSettings } from "@/features/git/settings";
import { useUi } from "@/features/git/ui-store";
import { isMac } from "@/features/git/utils";
import { activateTab, useRepoTabs } from "./tabs";
import i18n from "@/i18n";

const TAB_DIGIT = /^Digit([1-9])$/;

export interface KeyChord {
  code: string;
  ctrl: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
}

export type ChordProblem = "no_modifier" | "reserved";

const IGNORED_CODES = new Set([
  "ShiftLeft",
  "ShiftRight",
  "ControlLeft",
  "ControlRight",
  "AltLeft",
  "AltRight",
  "MetaLeft",
  "MetaRight",
  "CapsLock",
  "Tab",
  "Escape",
  "Dead",
  "Unidentified",
]);

const RESERVED_CODES = ["KeyP", "KeyT", "KeyW", "KeyN", "KeyF", "KeyR", "Comma"];

function reservedIds(isMacPlatform: boolean): Set<string> {
  const mod = isMacPlatform ? { ctrl: false, meta: true } : { ctrl: true, meta: false };
  const ids = new Set<string>();
  for (const code of RESERVED_CODES) {
    ids.add(chordId({ code, alt: false, shift: false, ...mod }));
    ids.add(chordId({ code, alt: false, shift: true, ...mod }));
  }
  return ids;
}

export function chordId(chord: KeyChord): string {
  const parts: string[] = [];
  if (chord.ctrl) parts.push("ctrl");
  if (chord.meta) parts.push("meta");
  if (chord.alt) parts.push("alt");
  if (chord.shift) parts.push("shift");
  parts.push(chord.code);
  return parts.join("+");
}

export function parseChordId(id: string): KeyChord | null {
  const [code, ...mods] = id.split("+").reverse();
  if (!code) return null;
  return {
    code,
    ctrl: mods.includes("ctrl"),
    meta: mods.includes("meta"),
    alt: mods.includes("alt"),
    shift: mods.includes("shift"),
  };
}

function keyLabel(code: string): string {
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  if (code.startsWith("Numpad")) return `Num ${code.slice(6)}`;
  switch (code) {
    case "BracketLeft":
      return "[";
    case "BracketRight":
      return "]";
    case "Comma":
      return ",";
    case "Period":
      return ".";
    case "Slash":
      return "/";
    case "Backslash":
      return "\\";
    case "Semicolon":
      return ";";
    case "Quote":
      return "'";
    case "Minus":
      return "-";
    case "Equal":
      return "=";
    case "Backquote":
      return "`";
    case "Space":
      return "Space";
    case "ArrowUp":
      return "↑";
    case "ArrowDown":
      return "↓";
    case "ArrowLeft":
      return "←";
    case "ArrowRight":
      return "→";
    default:
      return code;
  }
}

export function chordLabels(chord: KeyChord, isMacPlatform: boolean): string[] {
  const labels: string[] = [];
  if (chord.ctrl) labels.push(isMacPlatform ? "⌃" : "Ctrl");
  if (chord.alt) labels.push(isMacPlatform ? "⌥" : "Alt");
  if (chord.shift) labels.push(isMacPlatform ? "⇧" : "Shift");
  if (chord.meta) labels.push(isMacPlatform ? "⌘" : "Win");
  labels.push(keyLabel(chord.code));
  return labels;
}

export function chordText(chord: KeyChord, isMacPlatform: boolean): string {
  return chordLabels(chord, isMacPlatform).join(isMacPlatform ? "" : "+");
}

export function chordFromEvent(event: KeyboardEvent): KeyChord | null {
  if (IGNORED_CODES.has(event.code)) return null;
  return {
    code: event.code,
    ctrl: event.ctrlKey,
    meta: event.metaKey,
    alt: event.altKey,
    shift: event.shiftKey,
  };
}

export function chordProblem(chord: KeyChord, isMacPlatform: boolean): ChordProblem | null {
  if (!chord.ctrl && !chord.meta && !chord.alt) return "no_modifier";
  if (reservedIds(isMacPlatform).has(chordId(chord))) return "reserved";
  return null;
}

export function repoForChord(
  shortcuts: Readonly<Record<string, string>>,
  event: KeyboardEvent
): string | null {
  const chord = chordFromEvent(event);
  if (!chord || chordProblem(chord, isMac)) return null;
  const id = chordId(chord);
  for (const [path, value] of Object.entries(shortcuts)) {
    if (value === id) return path;
  }
  return null;
}

interface RepoShortcutState {
  repoShortcuts: Record<string, string>;
  setRepoShortcut: (path: string, id: string | null) => void;
}

export const repoShortcutsStore = create<RepoShortcutState>()(
  persist(
    (set) => ({
      repoShortcuts: {},
      setRepoShortcut: (path, id) =>
        set((state) => {
          const repoShortcuts = { ...state.repoShortcuts };
          if (id) repoShortcuts[path] = id;
          else delete repoShortcuts[path];
          return { repoShortcuts };
        }),
    }),
    {
      name: "git-repo-shortcuts",
      storage: createJSONStorage(() => gitStateStorage),
    }
  )
);

export function switchToRepo(path: string): void {
  useUi.getState().setPaletteOpen(false);
  useUi.getState().setRepoSwitcherOpen(false);
  activateTab(path);
}

/** Ask for a folder and put it in the strip, the way the + button does. */
export async function openRepositoryInNewTab(): Promise<void> {
  const dir = await pickDirectory({
    directory: true,
    title: i18n.t("gitRepo.extras.tabs.openAnother"),
  });
  if (typeof dir !== "string") return;
  activateTab(dir);
}

function plainModKey(event: KeyboardEvent, code: string): boolean {
  const mod = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  return mod && !event.altKey && !event.shiftKey && event.code === code;
}

function tabForKey(event: KeyboardEvent, tabs: string[], activePath: string | null): string | null {
  const mod = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!mod || event.altKey) return null;
  const digit = TAB_DIGIT.exec(event.code);
  if (digit && !event.shiftKey) return tabs[Number(digit[1]) - 1] ?? null;
  if (!event.shiftKey || tabs.length < 2) return null;
  if (event.code !== "BracketLeft" && event.code !== "BracketRight") return null;
  const current = activePath ? tabs.indexOf(activePath) : -1;
  const step = event.code === "BracketRight" ? 1 : -1;
  return tabs[(current + step + tabs.length) % tabs.length] ?? null;
}

export function useRepoShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest(".xterm")) return;
      const ui = useUi.getState();
      if (ui.dialog || ui.conflictFile) return;
      if (plainModKey(event, "KeyP")) {
        event.preventDefault();
        ui.setRepoSwitcherOpen(!ui.repoSwitcherOpen);
        return;
      }
      if (plainModKey(event, "KeyT")) {
        event.preventDefault();
        ui.setPaletteOpen(false);
        ui.setRepoSwitcherOpen(false);
        void openRepositoryInNewTab();
        return;
      }
      const activePath = useRepo.getState().repo?.path ?? null;
      const settings = useGitSettings.getState();
      const tabs = useRepoTabs.getState();
      const ordered = orderRepoTabs(
        tabs.tabs,
        settings.repoGroups,
        settings.repoGroupOf,
        tabs.worktreeMains
      );
      const path =
        tabForKey(event, ordered, activePath) ??
        repoForChord(repoShortcutsStore.getState().repoShortcuts, event);
      if (!path) return;
      event.preventDefault();
      switchToRepo(path);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
