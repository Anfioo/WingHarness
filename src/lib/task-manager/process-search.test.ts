// Ported from Argus (https://github.com/Ray-lea/Argus), AGPL-3.0-or-later.
// See docs/UPSTREAM_PROJECTS.md for the porting record.

import { describe, expect, it } from "vitest";
import type { ProcessRow } from "@/commands";
import { createProcessMatcher } from "./process-search";

function makeProcess(pid: number, overrides: Partial<ProcessRow> = {}): ProcessRow {
  return {
    pid,
    ppid: 0,
    createTime: pid * 100,
    name: `app-${pid}.exe`,
    path: `C:\\Apps\\app-${pid}.exe`,
    description: null,
    company: null,
    icon: null,
    cpu: 0,
    cpuTime: 0,
    privateWs: 0,
    workingSet: 0,
    commit: 0,
    ioRead: 0,
    ioWrite: 0,
    ioOther: 0,
    diskRead: null,
    diskWrite: null,
    gpu: 0,
    gpuEngine: null,
    gpuDedicated: 0,
    gpuShared: 0,
    netSent: 0,
    netReceived: 0,
    threads: 0,
    handles: 0,
    sessionId: 1,
    basePriority: 8,
    suspended: false,
    efficiency: false,
    appWindow: false,
    windowsProcess: false,
    ...overrides,
  };
}

describe("createProcessMatcher", () => {
  it("returns null for an empty or blank query", () => {
    expect(createProcessMatcher("")).toBeNull();
    expect(createProcessMatcher("   ")).toBeNull();
  });

  it("matches the process name case-insensitively", () => {
    const match = createProcessMatcher("NOTEPAD");
    expect(match).not.toBeNull();
    expect(match?.(makeProcess(1, { name: "notepad.exe" }))).toBe(true);
    expect(match?.(makeProcess(2, { name: "explorer.exe" }))).toBe(false);
  });

  it("matches a substring of the image path", () => {
    const match = createProcessMatcher("program files");
    expect(match?.(makeProcess(1, { path: "C:\\Program Files\\App\\app.exe" }))).toBe(true);
    expect(match?.(makeProcess(2, { path: "C:\\Windows\\app.exe" }))).toBe(false);
  });

  it("matches a numeric query against the start of the PID", () => {
    const match = createProcessMatcher("123");
    expect(match?.(makeProcess(1234, { name: "unrelated.exe", path: null }))).toBe(true);
    expect(match?.(makeProcess(5123, { name: "unrelated.exe", path: null }))).toBe(false);
  });

  it("still matches text that contains the digits of a numeric query", () => {
    const match = createProcessMatcher("123");
    expect(match?.(makeProcess(9, { name: "app-123.exe", path: null }))).toBe(true);
  });

  it("tolerates a process without a path", () => {
    const match = createProcessMatcher("app");
    expect(match?.(makeProcess(9, { path: null }))).toBe(true);
  });
});
