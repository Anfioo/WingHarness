import { ThemeProvider } from "@/components/theme-provider";
import { WindowContextMenu } from "@/components/window-context-menu";
import { useMaximized } from "@/hooks/use-maximized";
import { cn } from "@/lib/utils";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { type PointerEvent, type ReactNode, useEffect, useState } from "react";
import { Toaster } from "@/components/ui/sonner";

type WindowFrameProps = {
  titleBar: ReactNode;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
};

/** The API declares this union without exporting it. */
type ResizeDirection = Parameters<ReturnType<typeof getCurrentWindow>["startResizeDragging"]>[0];

/**
 * The window is frameless, so its only native resize target is the 4-6 physical
 * pixel ring Tauri lays over the outermost pixels, and that ring is empty while
 * the window is maximized. These strips start the same native drag from a band
 * that stays reachable on a scaled display.
 */
const RESIZE_STRIPS: { direction: ResizeDirection; className: string }[] = [
  { direction: "North", className: "inset-x-2.5 top-0 h-1.5 cursor-ns-resize" },
  { direction: "South", className: "inset-x-2.5 bottom-0 h-1.5 cursor-ns-resize" },
  { direction: "West", className: "inset-y-2.5 left-0 w-1.5 cursor-ew-resize" },
  // Below the title bar, so the window controls keep their side of the edge.
  { direction: "East", className: "top-8 bottom-2.5 right-0 w-1.5 cursor-ew-resize" },
  { direction: "NorthWest", className: "left-0 top-0 size-2.5 cursor-nwse-resize" },
  { direction: "NorthEast", className: "right-0 top-0 size-2.5 cursor-nesw-resize" },
  { direction: "SouthWest", className: "bottom-0 left-0 size-2.5 cursor-nesw-resize" },
  { direction: "SouthEast", className: "bottom-0 right-0 size-2.5 cursor-nwse-resize" },
];

export function WindowFrame({ titleBar, children, className, contentClassName }: WindowFrameProps) {
  const isMaximized = useMaximized();
  const [isResizable, setIsResizable] = useState(false);

  useEffect(() => {
    let alive = true;

    getCurrentWindow()
      .isResizable()
      .then((resizable) => {
        if (alive) setIsResizable(resizable);
      })
      .catch((error: unknown) => {
        console.error("Failed to read the window's resizable state:", error);
      });

    return () => {
      alive = false;
    };
  }, []);

  const startResizing = (direction: ResizeDirection) => (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) {
      return;
    }

    event.preventDefault();
    void getCurrentWindow()
      .startResizeDragging(direction)
      .catch((error: unknown) => {
        console.error("Failed to start resizing the window:", error);
      });
  };

  return (
    <ThemeProvider defaultTheme="system" storageKey="tauri-ui-theme">
      <div
        className={cn(
          "bg-background relative flex h-screen w-screen flex-col overflow-hidden",
          isMaximized ? "" : "border-border rounded-lg border",
          className
        )}
      >
        {titleBar}
        <main className={contentClassName}>{children}</main>
        {isResizable &&
          !isMaximized &&
          RESIZE_STRIPS.map(({ direction, className: stripClassName }) => (
            <div
              key={direction}
              aria-hidden
              className={cn("pointer-events-auto absolute z-40 touch-none", stripClassName)}
              onPointerDown={startResizing(direction)}
            />
          ))}
        <WindowContextMenu />
        <Toaster />
      </div>
    </ThemeProvider>
  );
}
