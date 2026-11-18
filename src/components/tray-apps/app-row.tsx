import { Pin } from "lucide-react";
import type { TrayApp } from "@/commands";
import { TrayAppIcon } from "./app-icon";

/**
 * One app of the second-level menu, as both the tray popup and its settings
 * preview draw it. `h-8` matches the popup's other rows, whose heights the
 * Rust side adds up to size the window.
 */
export function TrayAppRow({
  app,
  pinned,
  onSelect,
}: {
  app: TrayApp;
  pinned?: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      title={app.displayName}
      className="hover:bg-accent hover:text-accent-foreground flex h-8 w-full items-center gap-2 rounded-sm px-2 text-sm"
    >
      <TrayAppIcon app={app} size={16} />
      <span className="min-w-0 flex-1 truncate text-left">{app.displayName}</span>
      {pinned && <Pin className="text-muted-foreground/70 size-3 shrink-0" />}
    </button>
  );
}
