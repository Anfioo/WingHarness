// Pure display helpers for the FRP console.
//
// Everything here is side-effect free so the lanes can reuse it from both
// tables and dialogs, and so the output is easy to check by hand.

import {
  frpErrorCode,
  isFrpError,
  type FrpErrorCode,
  type LogLevel,
  type Tunnel,
} from "@/commands/services/frp/types";

const ERROR_KEYS: Record<FrpErrorCode, string> = {
  "not-found": "frp.error.notFound",
  "invalid-input": "frp.error.invalidInput",
  conflict: "frp.error.conflict",
  "runtime-missing": "frp.error.runtimeMissing",
  "runtime-in-use": "frp.error.runtimeInUse",
  "config-invalid": "frp.error.configInvalid",
  "spawn-failed": "frp.error.spawnFailed",
  "not-implemented": "frp.error.notImplemented",
  internal: "frp.error.internal",
};

/** i18n key describing one engine error code. */
export function frpErrorKey(code: FrpErrorCode): string {
  return ERROR_KEYS[code];
}

/** i18n key for a rejected command, or `null` when it is not an engine error. */
export function frpFailureKey(failure: unknown): string | null {
  const code = frpErrorCode(failure);
  return code ? ERROR_KEYS[code] : null;
}

/**
 * The text frpc itself printed when it rejected a configuration, if any.
 *
 * The translated code alone says nothing about *why* the file was rejected, so
 * the `rawOutput` detail is the only actionable part of a `config-invalid`.
 */
export function frpErrorOutput(failure: unknown): string | null {
  if (!isFrpError(failure) || failure.code !== "config-invalid") return null;
  const raw = failure.detail?.rawOutput;
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
}

/** `host:port`, bracketing IPv6 literals so the result stays unambiguous. */
export function formatEndpoint(host: string, port: number): string {
  const value = host.trim();
  if (!value) return `:${port}`;
  const wrapped = value.includes(":") && !value.startsWith("[") ? `[${value}]` : value;
  return `${wrapped}:${port}`;
}

/**
 * The address a client would use to reach this tunnel, following the rules in
 * plan §7.3. Returns `null` when the tunnel's options do not determine one —
 * an STCP server entry, for instance, is only reachable through a visitor.
 */
export function formatPublicAddress(
  tunnel: Pick<Tunnel, "options" | "localIp" | "localPort">,
  serverAddr: string
): string | null {
  switch (tunnel.options.kind) {
    case "port":
      return formatEndpoint(serverAddr, tunnel.options.remotePort);
    case "domain": {
      const domains = tunnel.options.customDomains.filter((domain) => domain.trim().length > 0);
      if (domains.length > 0) return domains.join(", ");
      // The server's own subdomain host is not part of the workspace; show the
      // subdomain alone rather than inventing a parent domain.
      return tunnel.options.subdomain?.trim() || null;
    }
    case "secret":
      if (tunnel.options.role === "visitor") {
        return formatEndpoint(tunnel.localIp, tunnel.localPort);
      }
      return tunnel.options.serverName?.trim() || null;
  }
}

/** Human-readable byte count with one decimal place above 1 KiB. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

/** Round-trip latency, with an explicit placeholder when it is unknown. */
export function formatLatency(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  if (ms < 1) return "<1 ms";
  return `${Math.round(ms)} ms`;
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

/** `HH:MM:SS.mmm` for a log line. */
export function formatLogTime(timestamp: number): string {
  const date = new Date(timestamp);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(
    date.getMilliseconds(),
    3
  )}`;
}

/** `YYYY-MM-DD HH:MM` in local time, for "added at" style fields. */
export function formatTimestamp(timestamp: number | null | undefined): string {
  if (timestamp === null || timestamp === undefined) return "—";
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}`;
}

/** Normalizes a version string to `vX.Y.Z`, or `—` when absent. */
export function formatVersion(version: string | null | undefined): string {
  const value = version?.trim();
  if (!value) return "—";
  return /^v/i.test(value) ? value : `v${value}`;
}

/** Severity order used by the log filter, lowest first. */
export const LOG_LEVEL_ORDER: LogLevel[] = ["trace", "debug", "info", "warn", "error"];

export function logLevelRank(level: LogLevel): number {
  return LOG_LEVEL_ORDER.indexOf(level);
}

/** True when `level` is at least as severe as `minimum`. */
export function isLogLevelAtLeast(level: LogLevel, minimum: LogLevel): boolean {
  return logLevelRank(level) >= logLevelRank(minimum);
}
