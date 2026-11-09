// The registry's core set: every family the preview dispatches to, and the
// refinement by first bytes that `inspectKind` adds for generic extensions.
import { describe, expect, it } from "vitest";
import {
  detectKind,
  inspectKind,
  isPreviewExtension,
  previewMime,
  unsupportedFormatHint,
} from "@/lib/space-preview/registry";

const text = (value: string) => new TextEncoder().encode(value);
const bytes = (...values: number[]) => new Uint8Array(values);
const pdf = bytes(0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37);
const zip = bytes(0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00);
const binary = bytes(0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07);

describe("detectKind", () => {
  it.each([
    ["photo.PNG", "image"],
    ["manual.pdf", "pdf"],
    ["invoice.ofd", "ofd"],
    ["scan.tiff", "tiff"],
    ["logo.wmf", "metafile"],
    ["design.psd", "psd"],
    ["map.xmind", "xmind"],
    ["font.ttf", "font"],
    ["cache.sqlite", "database"],
    ["mail.eml", "mail"],
    ["book.xls", "legacy-xlsx"],
    ["guide.adoc", "asciidoc"],
    ["flow.mmd", "diagram"],
    ["ui.lottie.json", "animation"],
    ["readme.md", "markdown"],
    ["report.docx", "docx"],
    ["old.doc", "legacy-doc"],
    ["old.ppt", "legacy-ppt"],
    ["page.html", "html"],
    ["saved.mht", "web-archive"],
    ["doc.rtf", "rtf"],
    ["sheet.xlsx", "xlsx"],
    ["deck.pptx", "pptx"],
    ["data.csv", "csv"],
    ["doc.odt", "odt"],
    ["book.epub", "epub"],
    ["story.fb2", "fb2"],
    ["analysis.ipynb", "notebook"],
    ["clip.mp4", "video"],
    ["track.flac", "audio"],
    ["bundle.zip", "archive"],
    ["main.ts", "text"],
    ["unknown.qqq", "binary"],
  ])("maps %s to %s", (name, kind) => {
    expect(detectKind(name)).toBe(kind);
  });

  it("reads the extension case-insensitively", () => {
    expect(detectKind("README.MD")).toBe("markdown");
    expect(detectKind("Photo.JpEg")).toBe("image");
  });
});

describe("inspectKind", () => {
  it("keeps the name's engine when one exists", () => {
    expect(inspectKind("notes.md", binary)).toBe("markdown");
    expect(inspectKind("archive.zip", text("not a zip"))).toBe("archive");
    expect(inspectKind("photo.png")).toBe("image");
  });

  it("refines an unknown extension from the first bytes", () => {
    expect(inspectKind("data.bin", text("plain words\n"))).toBe("text");
    expect(inspectKind("data.bin", pdf)).toBe("pdf");
    expect(inspectKind("data.bin", zip)).toBe("archive");
    expect(inspectKind("data.bin", binary)).toBe("binary");
  });

  it("treats .mdc as Markdown only when the content decodes as text", () => {
    expect(inspectKind("note.mdc", text("# Heading\n\nBody\n"))).toBe("markdown");
    expect(inspectKind("note.mdc", binary)).toBe("binary");
    expect(inspectKind("note.mdc")).toBe("markdown");
  });
});

describe("previewMime", () => {
  it("maps the formats the DOM cares about", () => {
    expect(previewMime("a.JPG")).toBe("image/jpeg");
    expect(previewMime("a.svg")).toBe("image/svg+xml");
    expect(previewMime("a.mp3")).toBe("audio/mpeg");
    expect(previewMime("a.mov")).toBe("video/quicktime");
    expect(previewMime("a.pdf")).toBe("application/pdf");
    expect(previewMime("a.html")).toBe("text/html");
    expect(previewMime("a.md")).toBe("text/plain");
    expect(previewMime("a.zip")).toBe("application/octet-stream");
  });

  it("falls back to a family MIME for an unlisted image type", () => {
    expect(previewMime("a.avif")).toBe("image/avif");
  });
});

describe("isPreviewExtension", () => {
  it("ignores case and dots", () => {
    expect(isPreviewExtension("md")).toBe(true);
    expect(isPreviewExtension("MD")).toBe(true);
    expect(isPreviewExtension("qqq")).toBe(false);
  });
});

describe("unsupportedFormatHint", () => {
  it("explains only the families that have no engine", () => {
    expect(unsupportedFormatHint("photo.raw")).toBeTruthy();
    expect(unsupportedFormatHint("part.max")).toBeTruthy();
    expect(unsupportedFormatHint("photo.png")).toBeUndefined();
  });
});
