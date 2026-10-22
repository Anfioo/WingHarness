import { useEffect } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { LogOut, Settings, SquareArrowOutUpRight, type LucideIcon } from "lucide-react";
import { quitApp } from "@/commands";
import { ThemeProvider } from "@/components/theme-provider";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { createWindow, showWindow } from "@/lib/window";

/**
 * The tray's right-click menu, shown in its own frameless, transparent window.
 *
 * Rust owns the window: it sizes it to the row geometry below, positions it
 * against the tray icon, and hides it on blur (`tray_popup.rs`).
 * All this page does is draw the rows and run their actions.
 */
export default function TrayMenuPage() {
  const { t } = useAppTranslation();
  const appWindow = getCurrentWebviewWindow();

  useEffect(() => {
    // Rust never sees this keystroke — the window has no native menu to absorb
    // it — so Escape is handled here.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") void appWindow.hide();
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [appWindow]);

  // Hide first, then act: the other way round leaves the popup painted over
  // whatever the action just opened.
  const run = (action: () => void | Promise<void>) => {
    void appWindow.hide().then(action);
  };

  const openSettings = () =>
    createWindow("settings", {
      title: t("settings.title"),
      url: "/settings",
      width: 720,
      height: 600,
      minWidth: 560,
      minHeight: 480,
      resizable: true,
      maximizable: true,
      minimizable: false,
      decorations: false,
      transparent: true,
      shadow: false,
      center: true,
    });

  return (
    <ThemeProvider defaultTheme="system" storageKey="tauri-ui-theme">
      <div
        // The window is transparent and the app has no native context menu for
        // this page, so the card *is* the menu — a right-click here must not
        // paint WebView2's own.
        onContextMenu={(event) => event.preventDefault()}
        className="bg-popover text-popover-foreground border-border h-full w-full rounded-md border"
      >
        <div className="flex flex-col p-1 select-none">
          <MenuItem
            icon={SquareArrowOutUpRight}
            label={t("tray.show")}
            onSelect={() => run(() => showWindow("main"))}
          />
          <MenuItem icon={Settings} label={t("tray.settings")} onSelect={() => run(openSettings)} />

          {/* my-1 + h-px — the 9px the Rust-side height arithmetic accounts for. */}
          <div className="bg-border my-1 h-px" />

          <MenuItem icon={LogOut} label={t("tray.quit")} onSelect={() => run(() => quitApp())} />
        </div>
      </div>
    </ThemeProvider>
  );
}

/**
 * One row. `h-8` is not cosmetic: the window is sized to these rows from
 * constants rather than measured, so the height has to stay exactly 32px.
 */
function MenuItem({
  icon: Icon,
  label,
  onSelect,
}: {
  icon: LucideIcon;
  label: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className="hover:bg-accent hover:text-accent-foreground flex h-8 shrink-0 items-center gap-2 rounded-sm px-2 text-sm"
    >
      <Icon className="text-muted-foreground size-4" />
      {label}
    </button>
  );
}
