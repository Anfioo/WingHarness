// The persisted preview preferences, with defaults and normalisation.
//
// The backend owns `preview.json`; this module only wraps the two commands so
// callers never invoke them directly, and repairs values a damaged file or an
// older build may have left behind.

import {
  getPreviewPreferences,
  savePreviewPreferences as savePreferencesCommand,
} from "@/commands";
import type {
  PreviewFont,
  PreviewHtmlView,
  PreviewKey,
  PreviewPreferences,
  TextEncoding,
} from "@/commands";

export const previewDefaults: PreviewPreferences = {
  version: 1,
  spaceEnabled: true,
  readingWidth: 900,
  fontSize: 15,
  defaultEncoding: "auto",
  textPreviewThresholdKb: 500,
  font: "auto",
  wrap: true,
  html: "source",
  maxPreviewMiB: 512,
  maxArchiveEntryMiB: 256,
  tabs: false,
  previewKey: "space",
};

/** The size choices offered for both resource limits. */
export const previewSizeOptions = [16, 32, 64, 128, 256, 512, 1024, 2048] as const;
/** The archive limit offers the same list without the two largest sizes. */
export const archiveSizeOptions = [16, 32, 64, 128, 256, 512, 1024] as const;

export const previewFonts: PreviewFont[] = ["auto", "sans", "serif", "mono"];
export const previewHtmlViews: PreviewHtmlView[] = ["source", "web"];
export const previewKeys: PreviewKey[] = ["space", "winSpace"];

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

function isSizeIn(value: unknown, minimum: number, maximum: number): value is number {
  return (
    typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum
  );
}

/** Clamp a stored preferences object to the values the UI can honour. */
export function normalizePreferences(value: Partial<PreviewPreferences>): PreviewPreferences {
  return {
    version: Number.isInteger(value.version) ? value.version! : previewDefaults.version,
    spaceEnabled:
      typeof value.spaceEnabled === "boolean" ? value.spaceEnabled : previewDefaults.spaceEnabled,
    readingWidth: isSizeIn(value.readingWidth, 360, 2400)
      ? value.readingWidth
      : previewDefaults.readingWidth,
    fontSize: isSizeIn(value.fontSize, 10, 40) ? value.fontSize : previewDefaults.fontSize,
    defaultEncoding: encodings.includes(value.defaultEncoding as TextEncoding)
      ? value.defaultEncoding!
      : previewDefaults.defaultEncoding,
    textPreviewThresholdKb: isSizeIn(value.textPreviewThresholdKb, 1, 65536)
      ? value.textPreviewThresholdKb
      : previewDefaults.textPreviewThresholdKb,
    font: previewFonts.includes(value.font as PreviewFont)
      ? (value.font as PreviewFont)
      : previewDefaults.font,
    wrap: typeof value.wrap === "boolean" ? value.wrap : previewDefaults.wrap,
    html: previewHtmlViews.includes(value.html as PreviewHtmlView)
      ? (value.html as PreviewHtmlView)
      : previewDefaults.html,
    maxPreviewMiB: isSizeIn(value.maxPreviewMiB, 16, 2048)
      ? value.maxPreviewMiB
      : previewDefaults.maxPreviewMiB,
    maxArchiveEntryMiB: isSizeIn(value.maxArchiveEntryMiB, 16, 1024)
      ? value.maxArchiveEntryMiB
      : previewDefaults.maxArchiveEntryMiB,
    tabs: typeof value.tabs === "boolean" ? value.tabs : previewDefaults.tabs,
    previewKey: previewKeys.includes(value.previewKey as PreviewKey)
      ? (value.previewKey as PreviewKey)
      : previewDefaults.previewKey,
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
