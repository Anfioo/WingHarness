import { useEffect, useState } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { Copy, Info, RotateCw, Settings, TextSelect, Wrench } from "lucide-react";
import { toast } from "sonner";
import { openDevtools } from "@/commands";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { createWindow } from "@/lib/window";

type MenuState = {
  x: number;
  y: number;
  /**
   * Captured when the right-click lands: the menu takes focus, so by the time
   * an item is clicked the live selection is gone.
   */
  selection: string;
};

// Dev-only extras: release builds ship without the inspector, and windows hold
// editing state (commit plan, working copy, SVN changes) that a stray reload
// would throw away. Packagers can opt a release build in by setting BUILD_DEV=1
// at build time (scripts/build.ps1 -DevBuild).
const SHOW_DEV_MENU = import.meta.env.DEV || import.meta.env.BUILD_DEV === "1";

/**
 * Replaces WebView2's own right-click menu with a themed one.
 *
 * Mounted once by `WindowFrame`, which every window shares, so this covers all
 * of them. Feature menus that claim a right-click — the git blame row, the SVN
 * changes row, the API-client collection nodes — keep working, see below.
 */
export function WindowContextMenu() {
  const { t } = useAppTranslation();
  const [menu, setMenu] = useState<MenuState | null>(null);

  useEffect(() => {
    const onContextMenu = (event: MouseEvent) => {
      // A feature already claimed this right-click: a Radix trigger, or a
      // handler that called preventDefault. React delegates to the root
      // container, a descendant of `document`, so those handlers have run by
      // the time this listener fires and the flag is already set.
      if (event.defaultPrevented) return;

      // Inside a text field the native cut/copy/paste is worth more than a
      // consistent look, and rebuilding it would need a clipboard plugin.
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, [contenteditable]:not([contenteditable='false'])")) {
        return;
      }

      event.preventDefault();
      setMenu({
        x: event.clientX,
        y: event.clientY,
        selection: window.getSelection()?.toString() ?? "",
      });
    };

    document.addEventListener("contextmenu", onContextMenu);
    return () => document.removeEventListener("contextmenu", onContextMenu);
  }, []);

  if (!menu) return null;

  // Unmount first, then act: the menu closing hands focus back to the page,
  // and an action run before that would have it taken away again.
  const run = (action: () => void) => {
    setMenu(null);
    window.setTimeout(action, 0);
  };

  const copy = () => {
    void navigator.clipboard.writeText(menu.selection).catch(() => {
      toast.error(t("windowMenu.copyFailed"));
    });
  };

  // Positioned against the window the right-click happened in, not `main`.
  const owner = getCurrentWebviewWindow().label;

  const openSettings = () => {
    void createWindow("settings", {
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
      parent: owner,
    });
  };

  const openAbout = () => {
    void createWindow("about", {
      title: t("about.title"),
      url: "/about",
      width: 520,
      height: 640,
      resizable: false,
      maximizable: false,
      minimizable: false,
      decorations: false,
      transparent: true,
      shadow: false,
      parent: owner,
    });
  };

  return (
    <DropdownMenu open onOpenChange={(open) => !open && setMenu(null)}>
      <DropdownMenuTrigger asChild>
        <span style={{ position: "fixed", left: menu.x, top: menu.y }} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="bottom">
        <DropdownMenuItem disabled={!menu.selection} onClick={() => run(copy)}>
          <Copy className="text-muted-foreground size-4" />
          {t("windowMenu.copy")}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => run(() => document.execCommand("selectAll"))}>
          <TextSelect className="text-muted-foreground size-4" />
          {t("windowMenu.selectAll")}
        </DropdownMenuItem>

        {/* Reload is dev-only on purpose: many windows hold editing state
            (commit plan, working copy, SVN changes) and a stray click would
            throw the draft away. */}
        {SHOW_DEV_MENU && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => run(() => window.location.reload())}>
              <RotateCw className="text-muted-foreground size-4" />
              {t("windowMenu.reload")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => run(() => void openDevtools())}>
              <Wrench className="text-muted-foreground size-4" />
              {t("windowMenu.devtools")}
            </DropdownMenuItem>
          </>
        )}

        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => run(openSettings)}>
          <Settings className="text-muted-foreground size-4" />
          {t("windowMenu.settings")}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => run(openAbout)}>
          <Info className="text-muted-foreground size-4" />
          {t("windowMenu.about")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
