import { useEffect, useState, ReactNode } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { Minus, Maximize2, Minimize2, Pin, X } from "lucide-react";
import { useMaximized } from "@/hooks/use-maximized";
import { cn } from "@/lib/utils";

interface TitleBarProps {
  title?: string;
  showMinimize?: boolean;
  showMaximize?: boolean;
  showPin?: boolean;
  showClose?: boolean;
  /**
   * Whether Escape closes the window. On by default, and off for windows that
   * use Escape for their own content (the repository window steps out of a
   * selection, a diff or a dialog first), where closing outright would race
   * that handling.
   */
  closeOnEscape?: boolean;
  leftActions?: ReactNode;
  rightActions?: ReactNode;
  onDoubleClick?: () => void;
}

export function TitleBar({
  title,
  showMinimize = true,
  showMaximize = true,
  showPin = false,
  showClose = true,
  closeOnEscape = true,
  leftActions,
  rightActions,
  onDoubleClick,
}: TitleBarProps) {
  const isMaximized = useMaximized(showMaximize);
  const [isPinned, setIsPinned] = useState(false);

  useEffect(() => {
    if (!showPin) return;

    getCurrentWebviewWindow().isAlwaysOnTop().then(setIsPinned);
  }, [showPin]);

  const handleMinimize = async () => {
    const appWindow = getCurrentWebviewWindow();
    await appWindow.minimize();
  };

  const handleToggleMaximize = async () => {
    const appWindow = getCurrentWebviewWindow();
    await appWindow.toggleMaximize();
  };

  const handleClose = async () => {
    const appWindow = getCurrentWebviewWindow();
    await appWindow.close();
  };

  const handleTogglePin = async () => {
    const appWindow = getCurrentWebviewWindow();
    const pinned = !(await appWindow.isAlwaysOnTop());
    await appWindow.setAlwaysOnTop(pinned);
    setIsPinned(pinned);
  };

  useEffect(() => {
    if (!showClose || !closeOnEscape) {
      return;
    }

    const appWindow = getCurrentWebviewWindow();
    if (appWindow.label === "main") {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }

      void handleClose();
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [showClose, closeOnEscape]);

  const handleDragRegionDoubleClick = () => {
    if (onDoubleClick) {
      onDoubleClick();
    } else if (showMaximize) {
      handleToggleMaximize();
    }
  };

  return (
    <div
      className={cn(
        "bg-background/95 supports-backdrop-filter:bg-background/60 border-border/40 flex h-8 items-center justify-between border-b backdrop-blur select-none",
        showMaximize && isMaximized ? "" : "rounded-t-lg"
      )}
    >
      {/* Left: Title + Drag region */}
      <div
        data-tauri-drag-region
        onDoubleClick={handleDragRegionDoubleClick}
        className="flex grow items-center gap-2 pl-2"
      >
        {title && <span className="text-sm font-medium text-slate-400">{title}</span>}
        {leftActions}
      </div>

      {/* Right: Control buttons */}
      <div className="flex items-center">
        {rightActions}

        {rightActions && (showPin || showMinimize || showMaximize || showClose) && (
          <div className="bg-border/40 mx-1 h-4 w-px" />
        )}

        {showPin && (
          <button
            onClick={handleTogglePin}
            className="title-bar-control"
            aria-label={isPinned ? "Unpin" : "Pin on top"}
            aria-pressed={isPinned}
            tabIndex={-1}
          >
            {/* Pinned fills the icon in rather than tinting the button: the
                control keeps its hover/background behaviour either way, so the
                state reads from the glyph alone. Lucide defaults `fill` to
                none, and takes a passed prop over it. */}
            <Pin className="h-4 w-4" fill={isPinned ? "currentColor" : "none"} />
          </button>
        )}

        {showMinimize && (
          <button
            onClick={handleMinimize}
            className="title-bar-control"
            aria-label="Minimize"
            tabIndex={-1}
          >
            <Minus className="h-4 w-4" />
          </button>
        )}

        {showMaximize && (
          <button
            onClick={handleToggleMaximize}
            className="title-bar-control"
            aria-label={isMaximized ? "Restore" : "Maximize"}
            tabIndex={-1}
          >
            {isMaximized ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
          </button>
        )}

        {showClose && (
          <button
            onClick={handleClose}
            className="title-bar-control hover:bg-destructive hover:text-destructive-foreground"
            aria-label="Close"
            tabIndex={-1}
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
    </div>
  );
}
