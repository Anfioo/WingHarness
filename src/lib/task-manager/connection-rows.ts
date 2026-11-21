// Filtering, stats and endpoint formatting for the connections tab.

import type { Connection, ProcessRow } from "@/commands";

export type ConnectionFilter = "all" | "listen" | "established" | "udp";

export type ConnectionStats = {
  listening: number;
  established: number;
  udp: number;
  total: number;
};

/** `address:port`, with brackets around an IPv6 address. */
export function connectionEndpoint(address: string, port: number | null, ipv6: boolean): string {
  if (port === null) return address;
  return ipv6 ? `[${address}]:${port}` : `${address}:${port}`;
}

/** One connection is one endpoint pair owned by one PID. */
export function connectionKey(connection: Connection): string {
  return [
    connection.protocol,
    connection.localAddress,
    connection.localPort,
    connection.remoteAddress ?? "",
    connection.remotePort ?? "",
    connection.pid,
  ].join("|");
}

/**
 * The rows the tab shows. A number is almost always a port or a PID, so it
 * matches exactly; anything else matches as a substring of the addresses or
 * the owning process's name and description.
 */
export function filterConnections(
  connections: readonly Connection[],
  filter: ConnectionFilter,
  query: string,
  processes: ReadonlyMap<number, ProcessRow>
): Connection[] {
  const needle = query.trim().toLocaleLowerCase();
  const number = /^\d+$/.test(needle) ? Number(needle) : null;
  return connections.filter((connection) => {
    if (filter === "listen" && connection.state !== "listen") return false;
    if (filter === "established" && connection.state !== "established") return false;
    if (filter === "udp" && connection.protocol !== "udp") return false;
    if (!needle) return true;
    if (number !== null) {
      return (
        connection.localPort === number ||
        connection.remotePort === number ||
        connection.pid === number
      );
    }
    const process = processes.get(connection.pid);
    return (
      connection.localAddress.toLocaleLowerCase().includes(needle) ||
      (connection.remoteAddress?.toLocaleLowerCase().includes(needle) ?? false) ||
      (process?.name.toLocaleLowerCase().includes(needle) ?? false) ||
      (process?.description?.toLocaleLowerCase().includes(needle) ?? false)
    );
  });
}

/** Per-filter counts over the full list, not the filtered rows. */
export function connectionStats(connections: readonly Connection[]): ConnectionStats {
  return {
    listening: connections.filter((connection) => connection.state === "listen").length,
    established: connections.filter((connection) => connection.state === "established").length,
    udp: connections.filter((connection) => connection.protocol === "udp").length,
    total: connections.length,
  };
}
