// The standalone preview window's tab arithmetic.
import { describe, expect, it } from "vitest";
import { closeTab, stepTab, visibleTabs } from "@/lib/space-preview/preview-tabs";

const entry = (path: string) => ({ path, name: path.toUpperCase() });
const tabs = [entry("a"), entry("b"), entry("c")];
const paths = (list: { path: string }[]) => list.map((tab) => tab.path);

describe("visibleTabs", () => {
  it("keeps the hand-off order and drops the closed paths", () => {
    expect(paths(visibleTabs(tabs, new Set(["b"])))).toEqual(["a", "c"]);
  });

  it("keeps every tab when nothing was closed", () => {
    expect(paths(visibleTabs(tabs, new Set()))).toEqual(["a", "b", "c"]);
  });
});

describe("stepTab", () => {
  it("moves one tab and wraps at both ends", () => {
    expect(stepTab(tabs, "a", 1)).toBe("b");
    expect(stepTab(tabs, "c", 1)).toBe("a");
    expect(stepTab(tabs, "a", -1)).toBe("c");
    expect(stepTab(tabs, "b", -1)).toBe("a");
  });

  it("falls back to the edge matching the direction when the active path is gone", () => {
    expect(stepTab(tabs, "gone", 1)).toBe("a");
    expect(stepTab(tabs, null, -1)).toBe("c");
  });

  it("has nowhere to go without tabs", () => {
    expect(stepTab([], "a", 1)).toBeNull();
  });
});

describe("closeTab", () => {
  it("leaves the selection alone when another tab closes", () => {
    const result = closeTab(tabs, "a", "c");
    expect(paths(result.tabs)).toEqual(["a", "b"]);
    expect(result.activePath).toBe("a");
  });

  it("hands the active tab to its right neighbour", () => {
    const result = closeTab(tabs, "b", "b");
    expect(paths(result.tabs)).toEqual(["a", "c"]);
    expect(result.activePath).toBe("c");
  });

  it("hands the last active tab to its left neighbour", () => {
    const result = closeTab(tabs, "c", "c");
    expect(paths(result.tabs)).toEqual(["a", "b"]);
    expect(result.activePath).toBe("b");
  });

  it("reports no active tab when the last one closes", () => {
    expect(closeTab([entry("a")], "a", "a")).toEqual({ tabs: [], activePath: null });
  });

  it("ignores a path that is not a tab", () => {
    const result = closeTab(tabs, "a", "gone");
    expect(paths(result.tabs)).toEqual(["a", "b", "c"]);
    expect(result.activePath).toBe("a");
  });
});
