// Normalisation of the persisted preview preferences: what the UI may show and
// what a damaged or older `preview.json` falls back to.
import { describe, expect, it, vi } from "vitest";

vi.mock("@/commands", () => ({
  getPreviewPreferences: vi.fn(),
  savePreviewPreferences: vi.fn(),
}));

import { normalizePreferences, previewDefaults } from "@/lib/space-preview/preferences";

describe("normalizePreferences", () => {
  it("fills every field an older preview.json lacks", () => {
    expect(normalizePreferences({ spaceEnabled: false })).toEqual({
      ...previewDefaults,
      spaceEnabled: false,
    });
  });

  it("keeps the stored values that are still valid", () => {
    expect(
      normalizePreferences({
        readingWidth: 720,
        fontSize: 18,
        defaultEncoding: "gb18030",
        textPreviewThresholdKb: 2048,
        font: "serif",
        wrap: false,
        html: "web",
        maxPreviewMiB: 1024,
        maxArchiveEntryMiB: 128,
        tabs: true,
        previewKey: "altSpace",
      })
    ).toEqual({
      ...previewDefaults,
      readingWidth: 720,
      fontSize: 18,
      defaultEncoding: "gb18030",
      textPreviewThresholdKb: 2048,
      font: "serif",
      wrap: false,
      html: "web",
      maxPreviewMiB: 1024,
      maxArchiveEntryMiB: 128,
      tabs: true,
      previewKey: "altSpace",
    });
  });

  it.each([
    ["readingWidth", 100],
    ["readingWidth", 3000],
    ["fontSize", 8],
    ["fontSize", 64],
    ["textPreviewThresholdKb", 0],
    ["maxPreviewMiB", 8],
    ["maxPreviewMiB", 4096],
    ["maxArchiveEntryMiB", 8],
    ["maxArchiveEntryMiB", 2048],
  ] as const)("resets an out-of-range %s of %s", (field, value) => {
    expect(normalizePreferences({ [field]: value })).toEqual({
      ...previewDefaults,
      [field]: previewDefaults[field],
    });
  });

  it.each([
    ["font", "comic"],
    ["html", "print"],
    ["previewKey", "ctrlSpace"],
    ["defaultEncoding", "latin1"],
  ] as const)("resets the unknown %s %s", (field, value) => {
    expect(normalizePreferences({ [field]: value } as never)).toEqual(previewDefaults);
  });

  it("resets fields of the wrong type", () => {
    expect(
      normalizePreferences({
        wrap: "yes" as never,
        tabs: 1 as never,
        readingWidth: "900" as never,
      })
    ).toEqual(previewDefaults);
  });
});
