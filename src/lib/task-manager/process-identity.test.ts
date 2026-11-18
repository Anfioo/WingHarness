// Ported from Argus (https://github.com/Ray-lea/Argus), AGPL-3.0-or-later.
// See docs/UPSTREAM_PROJECTS.md for the porting record.

import { describe, expect, it } from "vitest";
import type { ProcessRow } from "@/commands";
import {
  applicationKey,
  canGroup,
  isOwnProcess,
  isSystemProcess,
  priorityOf,
  procKey,
  processLabel,
  processRowId,
} from "./process-identity";

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

describe("process identity", () => {
  it("keys a process by its PID and creation time", () => {
    expect(procKey({ pid: 42, createTime: 1000 })).toBe("42:1000");
    expect(procKey({ pid: 42, createTime: 2000 })).not.toBe(procKey({ pid: 42, createTime: 1000 }));
  });

  it("makes element ids safe for keys with separators", () => {
    const keys = ["g:image:c:\\a\\b.exe", "g:image:c:\\a_b.exe", "g:image:c:\\a%5cb.exe"];
    expect(new Set(keys.map(processRowId)).size).toBe(keys.length);
    for (const key of keys) {
      expect(decodeURIComponent(processRowId(key).slice("process-row-".length))).toBe(key);
    }
  });

  it("groups one executable reached through different spellings", () => {
    const first = makeProcess(1, { path: "C:\\Apps\\helper.exe" });
    const second = makeProcess(2, { path: "c:/apps/HELPER.EXE" });
    const third = makeProcess(3, { path: "\\\\?\\C:\\Apps\\helper.exe" });
    expect(applicationKey(first)).toBe(applicationKey(second));
    expect(applicationKey(first)).toBe(applicationKey(third));
  });

  it("keeps equal filenames from different installations apart", () => {
    const first = makeProcess(1, { path: "C:\\App A\\helper.exe" });
    const second = makeProcess(2, { path: "C:\\App B\\helper.exe" });
    expect(applicationKey(first)).not.toBe(applicationKey(second));
  });

  it("keeps shared hosts and missing paths per process instance", () => {
    const host = makeProcess(1, { name: "svchost.exe", path: "C:\\Windows\\svchost.exe" });
    const otherHost = makeProcess(2, { name: "svchost.exe", path: "C:\\Windows\\svchost.exe" });
    const noPath = makeProcess(3, { path: null });
    expect(canGroup(host)).toBe(false);
    expect(applicationKey(host)).not.toBe(applicationKey(otherHost));
    expect(canGroup(noPath)).toBe(false);
    expect(applicationKey(noPath)).not.toBe(applicationKey(makeProcess(3)));
  });

  it("groups WebView2 helpers by their browser instance", () => {
    const runtime = {
      browserPid: 10,
      browserCreateTime: 500,
      hostName: "app.exe",
      hostDescription: "Example app",
      hostIcon: null,
      role: "renderer" as const,
    };
    const renderer = makeProcess(11, { name: "msedgewebview2.exe", webView: runtime });
    const crashpad = makeProcess(12, {
      name: "msedgewebview2.exe",
      webView: { ...runtime, role: "crashpad" },
    });
    const otherBrowser = makeProcess(13, {
      name: "msedgewebview2.exe",
      webView: { ...runtime, browserPid: 20 },
    });
    expect(applicationKey(renderer)).toBe(applicationKey(crashpad));
    expect(applicationKey(renderer)).not.toBe(applicationKey(otherBrowser));
    expect(canGroup(renderer)).toBe(true);
  });

  it("shows a WebView2 host description as the label", () => {
    const process = makeProcess(11, {
      name: "msedgewebview2.exe",
      description: "Microsoft Edge WebView2",
      webView: {
        browserPid: 10,
        browserCreateTime: 500,
        hostName: "app.exe",
        hostDescription: "Example app",
        hostIcon: null,
        role: "renderer",
      },
    });
    expect(processLabel(process)).toBe("Example app");
  });

  it("recognizes this application's own executable without its extension or case", () => {
    const own = makeProcess(1, { name: "WingHarness.exe" });
    expect(isOwnProcess(own, ["wingharness"])).toBe(true);
    expect(isOwnProcess(own, ["WingHarness.exe"])).toBe(true);
    expect(isOwnProcess(makeProcess(2, { name: "not-ours.exe" }), ["wingharness"])).toBe(false);
  });

  it("treats session 0 as the system", () => {
    expect(isSystemProcess(makeProcess(1, { sessionId: 0 }))).toBe(true);
    expect(isSystemProcess(makeProcess(2, { sessionId: 1 }))).toBe(false);
  });

  it("maps base priorities to priority classes", () => {
    expect(priorityOf(4)).toBe("idle");
    expect(priorityOf(6)).toBe("belowNormal");
    expect(priorityOf(8)).toBe("normal");
    expect(priorityOf(10)).toBe("aboveNormal");
    expect(priorityOf(13)).toBe("high");
    expect(priorityOf(24)).toBe("realtime");
    expect(priorityOf(9)).toBeNull();
  });
});
