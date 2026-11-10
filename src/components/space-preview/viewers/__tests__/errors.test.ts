import { describe, expect, it } from "vitest";
import strings from "@/i18n/locales/space-preview/en";
import { errorText, previewErrorCodeKey, previewErrorKey } from "../errors";

function lookup(key: string): unknown {
  return key
    .replace(/^spacePreview\./, "")
    .split(".")
    .reduce<unknown>((node, part) => {
      if (node && typeof node === "object") return (node as Record<string, unknown>)[part];
      return undefined;
    }, strings);
}

describe("errorText", () => {
  it("unwraps an Error and a plain string", () => {
    expect(errorText(new Error("boom"))).toBe("boom");
    expect(errorText("boom")).toBe("boom");
  });

  it("unwraps the backend's serialized error", () => {
    expect(errorText({ code: "not-found", message: "The file no longer exists." })).toBe(
      "The file no longer exists."
    );
    expect(errorText({ code: "internal", message: "", detail: "stack" })).toBe("stack");
  });

  it("returns an empty string rather than a placeholder for an unknown value", () => {
    expect(errorText(null)).toBe("");
    expect(errorText(undefined)).toBe("");
    expect(errorText(42)).toBe("");
  });
});

describe("previewErrorKey", () => {
  it.each([
    ["not-authorized", "spacePreview.error.notAuthorized"],
    ["not-found", "spacePreview.error.notFound"],
    ["too-large", "spacePreview.error.tooLarge"],
    ["invalid-input", "spacePreview.error.invalidInput"],
    ["unsupported", "spacePreview.error.unsupported"],
    ["internal", "spacePreview.error.internal"],
  ])("maps %s to a key that exists", (code, key) => {
    expect(previewErrorKey(code)).toBe(key);
    expect(typeof lookup(key)).toBe("string");
  });

  it("returns null for a code the UI has no wording for", () => {
    expect(previewErrorKey("something-new")).toBeNull();
    expect(previewErrorKey(null)).toBeNull();
    expect(previewErrorKey(undefined)).toBeNull();
  });
});

describe("previewErrorCodeKey", () => {
  it("reads the code off a serialized backend error", () => {
    expect(previewErrorCodeKey({ code: "too-large", message: "Too large." })).toBe(
      "spacePreview.error.tooLarge"
    );
  });

  it("returns null for anything that did not come from a backend command", () => {
    expect(previewErrorCodeKey(new Error("boom"))).toBeNull();
    expect(previewErrorCodeKey("boom")).toBeNull();
    expect(previewErrorCodeKey(null)).toBeNull();
    expect(previewErrorCodeKey({ code: 42 })).toBeNull();
    expect(previewErrorCodeKey({ message: "no code" })).toBeNull();
  });
});
