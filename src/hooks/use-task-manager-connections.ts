// Connection polling and filtering for the connections tab.
//
// The list comes from `argus_connections_list` on its own 2 s timer: it is
// independent of the 1 s process snapshot, and it stops while the tab is not
// the active one or the page is hidden.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  argusConnectionsClose,
  argusConnectionsList,
  argusErrorKey,
  isArgusError,
  type Connection,
  type ProcessRow,
} from "@/commands";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { useTaskManager } from "@/hooks/use-task-manager";

export type ConnectionFilter = "all" | "listen" | "established" | "udp";

export type ConnectionStats = {
  listening: number;
  established: number;
  udp: number;
  total: number;
};

const POLL_INTERVAL_MS = 2_000;

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
 * The connections tab's data: the endpoint list, its 2 s poll, the filter and
 * search state, and the reset behind "Close connection".
 *
 * Polling only runs while `active` is true and the document is visible. The
 * list keeps its last value while paused, so switching back is immediate.
 */
export function useTaskManagerConnections(active: boolean) {
  const { t } = useAppTranslation();
  const page = useTaskManager();
  const [connections, setConnections] = useState<Connection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ConnectionFilter>("all");
  const mounted = useRef(true);
  const inFlight = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    try {
      const next = await argusConnectionsList();
      if (!mounted.current) return;
      setConnections(next);
      setError(null);
    } catch (cause) {
      if (!mounted.current) return;
      setError(cause);
    } finally {
      inFlight.current = false;
      if (mounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    void load();
    const refresh = () => {
      if (document.visibilityState === "visible") void load();
    };
    const timer = window.setInterval(refresh, POLL_INTERVAL_MS);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [active, load]);

  const processes = useMemo(() => {
    const map = new Map<number, ProcessRow>();
    for (const process of page.snapshot?.processes ?? []) map.set(process.pid, process);
    return map;
  }, [page.snapshot]);

  // Filters and search are pure front-end work. A number is almost always a
  // port or a PID, so it matches exactly; anything else matches as a substring
  // of the addresses or the owning process's name and description.
  const rows = useMemo(() => {
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
  }, [connections, filter, query, processes]);

  const stats = useMemo<ConnectionStats>(
    () => ({
      listening: connections.filter((connection) => connection.state === "listen").length,
      established: connections.filter((connection) => connection.state === "established").length,
      udp: connections.filter((connection) => connection.protocol === "udp").length,
      total: connections.length,
    }),
    [connections]
  );

  // Resetting a connection of another user needs the privileged service; the
  // menu disables the action rather than letting the call fail.
  const service = page.service;
  const serviceReady = Boolean(
    service &&
    service.state === "running" &&
    service.authorized &&
    !service.incompatible &&
    !service.error
  );

  const close = useCallback(
    async (connection: Connection) => {
      if (connection.remoteAddress === null || connection.remotePort === null) return;
      try {
        await argusConnectionsClose(
          connection.localAddress,
          connection.localPort,
          connection.remoteAddress,
          connection.remotePort
        );
        toast.success(t("taskManager.connections.toast.closed"));
      } catch (failure) {
        toast.error(t("taskManager.connections.toast.closeFailed"));
        if (isArgusError(failure)) toast.error(t(argusErrorKey(failure.code)));
      }
      await load();
    },
    [load, t]
  );

  return {
    connections,
    rows,
    stats,
    processes,
    loading,
    error,
    query,
    setQuery,
    filter,
    setFilter,
    serviceReady,
    load,
    close,
  };
}
