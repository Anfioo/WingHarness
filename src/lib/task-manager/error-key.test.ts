import { describe, expect, it } from "vitest";
import en from "@/i18n/locales/task-manager/en";
import zh from "@/i18n/locales/task-manager/zh";
import { argusErrorKey, isArgusError, type ArgusErrorCode } from "@/commands/services/task-manager";

const CODES: ArgusErrorCode[] = [
  "not-found",
  "invalid-input",
  "access-denied",
  "service-unavailable",
  "internal",
];

describe("argusErrorKey", () => {
  it("maps every code onto the task manager error namespace", () => {
    for (const code of CODES) {
      expect(argusErrorKey(code)).toBe(`taskManager.error.${code}`);
    }
  });

  it("has a translation for every code in both languages", () => {
    for (const code of CODES) {
      expect(en.error[code]).toBeTruthy();
      expect(zh.error[code]).toBeTruthy();
    }
  });
});

describe("isArgusError", () => {
  it("accepts every known code", () => {
    for (const code of CODES) {
      expect(isArgusError({ code, message: "failed" })).toBe(true);
    }
  });

  it("keeps the optional detail", () => {
    const error = { code: "internal", message: "failed", detail: "exit 5" };
    expect(isArgusError(error)).toBe(true);
    if (isArgusError(error)) expect(error.detail).toBe("exit 5");
  });

  it("rejects values that are not engine errors", () => {
    expect(isArgusError(null)).toBe(false);
    expect(isArgusError(undefined)).toBe(false);
    expect(isArgusError("not-found")).toBe(false);
    expect(isArgusError({ message: "failed" })).toBe(false);
    expect(isArgusError({ code: "cancelled", message: "failed" })).toBe(false);
    expect(isArgusError({ code: 42, message: "failed" })).toBe(false);
  });
});
