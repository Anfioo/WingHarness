import { describe, expect, it } from "vitest";
import type { Connection, ProcessRow } from "@/commands";
import {
  connectionEndpoint,
  connectionKey,
  connectionStats,
  filterConnections,
} from "./connection-rows";

function connection(overrides: Partial<Connection> = {}): Connection {
  return {
    protocol: "tcp",
    ipv6: false,
    localAddress: "127.0.0.1",
    localPort: 5000,
    remoteAddress: "1.2.3.4",
    remotePort: 443,
    state: "established",
    pid: 42,
    ...overrides,
  };
}

function process(name: string, description: string | null = null): ProcessRow {
  return { name, description } as ProcessRow;
}

describe("connectionEndpoint", () => {
  it("brackets IPv6 addresses and omits a missing port", () => {
    expect(connectionEndpoint("127.0.0.1", 80, false)).toBe("127.0.0.1:80");
    expect(connectionEndpoint("::1", 80, true)).toBe("[::1]:80");
    expect(connectionEndpoint("0.0.0.0", null, false)).toBe("0.0.0.0");
  });
});

describe("connectionKey", () => {
  it("separates endpoints of different PIDs", () => {
    expect(connectionKey(connection())).toBe("tcp|127.0.0.1|5000|1.2.3.4|443|42");
    expect(connectionKey(connection({ remoteAddress: null, remotePort: null }))).toBe(
      "tcp|127.0.0.1|5000|||42"
    );
  });
});

describe("filterConnections", () => {
  const processes = new Map<number, ProcessRow>([
    [42, process("browser.exe", "Web browser")],
    [7, process("dns.exe")],
  ]);
  const listening = connection({ state: "listen", remoteAddress: null, remotePort: null });
  const browser = connection();
  const udp = connection({
    protocol: "udp",
    state: null,
    localAddress: "0.0.0.0",
    localPort: 53,
    remoteAddress: null,
    remotePort: null,
    pid: 7,
  });
  const dns = connection({
    localAddress: "10.0.0.5",
    localPort: 8080,
    remoteAddress: "8.8.8.8",
    remotePort: 53,
    pid: 7,
  });
  const connections = [listening, browser, udp, dns];

  it("keeps everything for the all filter and a blank query", () => {
    expect(filterConnections(connections, "all", " ", processes)).toHaveLength(4);
  });

  it("filters by state and protocol", () => {
    expect(filterConnections(connections, "listen", "", processes)).toEqual([listening]);
    expect(filterConnections(connections, "established", "", processes)).toEqual([browser, dns]);
    expect(filterConnections(connections, "udp", "", processes)).toEqual([udp]);
  });

  it("matches a numeric query against ports and PIDs exactly", () => {
    expect(filterConnections(connections, "all", "8080", processes)).toEqual([dns]);
    expect(filterConnections(connections, "all", "443", processes)).toEqual([browser]);
    expect(filterConnections(connections, "all", "7", processes)).toEqual([udp, dns]);
    // A prefix of a port is not an exact port match.
    expect(filterConnections(connections, "all", "44", processes)).toEqual([]);
  });

  it("matches text against addresses, process names and descriptions", () => {
    expect(filterConnections(connections, "all", "1.2.3", processes)).toEqual([browser]);
    expect(filterConnections(connections, "all", "10.0.0", processes)).toEqual([dns]);
    expect(filterConnections(connections, "all", "BROWSER", processes)).toEqual([
      listening,
      browser,
    ]);
    expect(filterConnections(connections, "all", "web", processes)).toEqual([listening, browser]);
    expect(filterConnections(connections, "all", "missing", processes)).toEqual([]);
  });
});

describe("connectionStats", () => {
  it("counts over the full list, not the filtered rows", () => {
    const stats = connectionStats([
      connection({ state: "listen" }),
      connection(),
      connection({ protocol: "udp", state: null }),
    ]);
    expect(stats).toEqual({ listening: 1, established: 1, udp: 1, total: 3 });
  });
});
