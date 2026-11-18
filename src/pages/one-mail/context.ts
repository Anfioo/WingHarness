// Part of the one-mail module, adapted from OneMail
// (https://github.com/zhihui-hu/one-mail), AGPL-3.0-only.
// See `src-tauri/one-mail-core/UPSTREAM.md` for the porting record.

import { createContext, useContext } from "react";
import type { OneMailPageState } from "@/hooks/use-one-mail-page";

/**
 * The page state shared with every one-mail component.
 *
 * The page owns the one `useOneMailPage()` call and provides it here; a
 * component reads it instead of calling the hook again, so there is exactly one
 * subscriber for the backend events.
 */
export const OneMailPageContext = createContext<OneMailPageState | null>(null);

export function useOneMailPageContext(): OneMailPageState {
  const value = useContext(OneMailPageContext);
  if (!value) {
    throw new Error("useOneMailPageContext must be used inside the one-mail page.");
  }
  return value;
}

export const OneMailPageProvider = OneMailPageContext.Provider;
