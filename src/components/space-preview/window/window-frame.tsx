// The frameless chrome around the standalone preview window: a drag strip with
// the selection controls, then the viewer.

import type { ReactNode } from "react";
import { X } from "lucide-react";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/sonner";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { cn } from "@/lib/utils";

interface PreviewWindowFrameProps {
  /** The selection bar; the frame only positions it. */
  bar?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  className?: string;
}

export function PreviewWindowFrame({ bar, onClose, children, className }: PreviewWindowFrameProps) {
  const { t } = useAppTranslation();
  const closeLabel = t("spacePreview.window.close", { defaultValue: "Close" });

  return (
    <ThemeProvider defaultTheme="system" storageKey="tauri-ui-theme">
      <div
        className={cn(
          "bg-background text-foreground border-border relative flex h-screen w-screen flex-col overflow-hidden rounded-lg border",
          className
        )}
      >
        <div
          data-tauri-drag-region
          className="border-border bg-card flex h-10 shrink-0 items-center gap-2 border-b px-2 select-none"
        >
          {bar}
          <button
            type="button"
            aria-label={closeLabel}
            title={closeLabel}
            className="hover:bg-accent ml-auto shrink-0 rounded-md p-1.5"
            onClick={onClose}
          >
            <X className="size-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1">{children}</div>
        <Toaster />
      </div>
    </ThemeProvider>
  );
}
