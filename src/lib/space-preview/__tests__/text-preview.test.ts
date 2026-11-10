import { describe, expect, it } from "vitest";
import { MAX_HIGHLIGHT_CHARS, previewText } from "@/lib/space-preview/text-preview";

describe("previewText", () => {
  it("highlights a source file with the editor's grammars", () => {
    const result = previewText("const answer = 42;\n", "answer.ts");
    expect(result.language).toBe("typescript");
    expect(result.html).toContain("hljs-");
  });

  it("leaves a plain text file unhighlighted", () => {
    expect(previewText("hello", "notes.txt")).toEqual({ html: null, language: null });
  });

  it("skips the highlight pass above the character cap", () => {
    const text = "a".repeat(MAX_HIGHLIGHT_CHARS + 1);
    expect(previewText(text, "answer.ts")).toEqual({ html: null, language: "typescript" });
  });
});
