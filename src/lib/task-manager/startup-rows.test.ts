import { describe, expect, it } from "vitest";
import type { StartupItem } from "@/commands";
import { filterStartupItems, sortStartupItems } from "./startup-rows";

function item(id: string, overrides: Partial<StartupItem> = {}): StartupItem {
  return {
    id: `hkcuRun|${id}`,
    name: id,
    entry: id,
    command: `"C:\\Apps\\${id}.exe"`,
    path: `C:\\Apps\\${id}.exe`,
    location: "hkcuRun",
    machine: false,
    enabled: true,
    blocked: null,
    exists: true,
    publisher: null,
    description: null,
    icon: null,
    ...overrides,
  };
}

describe("filterStartupItems", () => {
  const items = [
    item("Alpha", { publisher: "Contoso" }),
    item("beta", { description: "Background helper" }),
    item("Gamma", { command: '"C:\\Tools\\gamma.exe" --tray', entry: "Gamma Entry" }),
  ];

  it("returns a copy of every item for a blank query", () => {
    const result = filterStartupItems(items, "  ");
    expect(result).toEqual(items);
    expect(result).not.toBe(items);
  });

  it("matches name, entry, publisher, command and description case-insensitively", () => {
    expect(filterStartupItems(items, "contoso").map((entry) => entry.name)).toEqual(["Alpha"]);
    expect(filterStartupItems(items, "HELPER").map((entry) => entry.name)).toEqual(["beta"]);
    expect(filterStartupItems(items, "gamma entry").map((entry) => entry.name)).toEqual(["Gamma"]);
    expect(filterStartupItems(items, "tools\\gamma").map((entry) => entry.name)).toEqual(["Gamma"]);
  });

  it("has no matches for an absent query", () => {
    expect(filterStartupItems(items, "nothing-like-this")).toEqual([]);
  });
});

describe("sortStartupItems", () => {
  it("sorts names naturally without changing the input order", () => {
    const items = [item("item10"), item("Item2"), item("item1")];
    expect(sortStartupItems(items, "name").map((entry) => entry.name)).toEqual([
      "item1",
      "Item2",
      "item10",
    ]);
    expect(items.map((entry) => entry.name)).toEqual(["item10", "Item2", "item1"]);
  });

  it("sorts the status with enabled items before disabled ones", () => {
    const items = [
      item("on", { enabled: true }),
      item("off", { enabled: false }),
      item("also-on", { enabled: true }),
    ];
    expect(sortStartupItems(items, "enabled").map((entry) => entry.enabled)).toEqual([
      false,
      true,
      true,
    ]);
  });

  it("sorts the command column", () => {
    const items = [
      item("b", { command: "B.exe" }),
      item("a", { command: "A.exe" }),
      item("c", { command: "C.exe" }),
    ];
    expect(sortStartupItems(items, "command").map((entry) => entry.command)).toEqual([
      "A.exe",
      "B.exe",
      "C.exe",
    ]);
  });

  it("sorts publishers with the missing ones first and keeps their order", () => {
    const items = [
      item("b", { publisher: null }),
      item("a", { publisher: "Acme" }),
      item("none", { publisher: null }),
    ];
    expect(sortStartupItems(items, "publisher").map((entry) => entry.name)).toEqual([
      "b",
      "none",
      "a",
    ]);
  });
});
