// The subset of the persisted preferences the viewers actually read.
// Upstream kept a larger object with per-session toggles; those are component
// state here, so only the durable values come from the host.

import { createContext, useContext, type ReactNode } from "react";
import type { PreviewFont, PreviewHtmlView, TextEncoding } from "@/commands";

export interface ViewerPreferences {
  readingWidth: number;
  fontSize: number;
  defaultEncoding: TextEncoding;
  textPreviewThresholdKb: number;
  font: PreviewFont;
  wrap: boolean;
  html: PreviewHtmlView;
  maxPreviewMiB: number;
  maxArchiveEntryMiB: number;
}

interface PreferencesValue {
  preferences: ViewerPreferences;
  update: (next: Partial<ViewerPreferences>) => void;
}

const ViewerPreferencesContext = createContext<PreferencesValue | null>(null);

export function ViewerPreferencesProvider({
  preferences,
  update,
  children,
}: PreferencesValue & { children: ReactNode }) {
  return (
    <ViewerPreferencesContext.Provider value={{ preferences, update }}>
      {children}
    </ViewerPreferencesContext.Provider>
  );
}

export function useViewerPreferences(): PreferencesValue {
  const value = useContext(ViewerPreferencesContext);
  if (!value) throw new Error("The preview preferences provider is missing.");
  return value;
}
