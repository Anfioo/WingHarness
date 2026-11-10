import type { PortsErrorCode } from "@/commands";

/** The i18n key for a rejected ports command, used by toasts and the error row. */
export function portsErrorKey(code: PortsErrorCode | "unknown"): string {
  switch (code) {
    case "not-found":
      return "ports.error.notFound";
    case "invalid-input":
      return "ports.error.invalidInput";
    case "access-denied":
      return "ports.error.accessDenied";
    case "elevation-cancelled":
      return "ports.error.elevationCancelled";
    case "elevation-failed":
      return "ports.error.elevationFailed";
    default:
      return "ports.error.internal";
  }
}
