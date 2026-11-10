// The persisted preview preferences, with defaults and normalisation.
//
// The backend owns `preview.json`; this module only wraps the two commands so
// callers never invoke them directly, and repairs values a damaged file or an
// older build may have left behind.

import {
  getPreviewPreferences,
  savePreviewPreferences as savePreferencesCommand,
} from "@/commands";
import type { PreviewPreferences, TextEncoding } from "@/commands";

export const previewDefaults: PreviewPreferences = {
  version: 1,
  spaceEnabled: true,
  readingWidth: 900,
  fontSize: 15,
  defaultEncoding: "auto",
  textPreviewThresholdKb: 500,
};

const encodings: TextEncoding[] = [
  "auto",
  "utf-8",
  "utf-16le",
  "utf-16be",
  "gb18030",
  "big5",
  "windows-1252",
  "shift_jis",
];

/** Clamp a stored preferences object to the values the UI can honour. */
export function normalizePreferences(value: Partial<PreviewPreferences>): PreviewPreferences {
  return {
    version: Number.isInteger(value.version) ? value.version! : previewDefaults.version,
    spaceEnabled:
      typeof value.spaceEnabled === "boolean" ? value.spaceEnabled : previewDefaults.spaceEnabled,
    readingWidth:
      typeof value.readingWidth === "number" &&
      Number.isInteger(value.readingWidth) &&
      value.readingWidth >= 360 &&
      value.readingWidth <= 2400
        ? value.readingWidth
        : previewDefaults.readingWidth,
    fontSize:
      typeof value.fontSize === "number" &&
      Number.isInteger(value.fontSize) &&
      value.fontSize >= 10 &&
      value.fontSize <= 40
        ? value.fontSize
        : previewDefaults.fontSize,
    defaultEncoding: encodings.includes(value.defaultEncoding as TextEncoding)
      ? value.defaultEncoding!
      : previewDefaults.defaultEncoding,
    textPreviewThresholdKb:
      typeof value.textPreviewThresholdKb === "number" &&
      Number.isInteger(value.textPreviewThresholdKb) &&
      value.textPreviewThresholdKb >= 1 &&
      value.textPreviewThresholdKb <= 65536
        ? value.textPreviewThresholdKb
        : previewDefaults.textPreviewThresholdKb,
  };
}

export async function loadPreferences(): Promise<PreviewPreferences> {
  return normalizePreferences(await getPreviewPreferences());
}

export async function savePreferences(
  value: Partial<PreviewPreferences>
): Promise<PreviewPreferences> {
  return normalizePreferences(await savePreferencesCommand(normalizePreferences(value)));
}
