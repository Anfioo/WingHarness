import type { MiseErrorCode } from "@/commands";

/** The i18n key for a rejected mise command, used by toasts and error rows. */
export function miseErrorKey(code: MiseErrorCode | "unknown"): string {
  switch (code) {
    case "mise-not-found":
      return "mise.error.miseNotFound";
    case "not-found":
      return "mise.error.notFound";
    case "invalid-input":
      return "mise.error.invalidInput";
    case "unsafe-command":
      return "mise.error.unsafeCommand";
    case "busy":
      return "mise.error.busy";
    case "timeout":
      return "mise.error.timeout";
    case "io":
      return "mise.error.io";
    case "cancelled":
      return "mise.error.cancelled";
    case "not-implemented":
      return "mise.error.notImplemented";
    default:
      return "mise.error.internal";
  }
}
