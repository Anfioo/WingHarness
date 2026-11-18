// Part of the one-mail module, adapted from OneMail
// (https://github.com/zhihui-hu/one-mail), AGPL-3.0-only.
// See `src-tauri/one-mail-core/UPSTREAM.md` for the porting record.

import type { OneMailErrorCode } from "@/commands";

/** The i18n key for a rejected one-mail command, used by toasts and error rows. */
export function oneMailErrorKey(code: OneMailErrorCode | "unknown"): string {
  switch (code) {
    case "not-found":
      return "oneMail.errors.notFound";
    case "invalid-input":
      return "oneMail.errors.invalidInput";
    case "auth-failed":
      return "oneMail.errors.authFailed";
    case "network":
      return "oneMail.errors.network";
    case "tls":
      return "oneMail.errors.tls";
    case "protocol":
      return "oneMail.errors.protocol";
    case "database":
      return "oneMail.errors.database";
    case "busy":
      return "oneMail.errors.busy";
    case "not-configured":
      return "oneMail.errors.notConfigured";
    case "not-implemented":
      return "oneMail.errors.notImplemented";
    default:
      return "oneMail.errors.internal";
  }
}
