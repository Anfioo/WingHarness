import { ThemeProvider } from "@/components/theme-provider";
import { WindowContextMenu } from "@/components/window-context-menu";
import { useMaximized } from "@/hooks/use-maximized";
import { cn } from "@/lib/utils";
import { type ReactNode } from "react";
import { Toaster } from "@/components/ui/sonner";

type WindowFrameProps = {
  titleBar: ReactNode;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
};

export function WindowFrame({ titleBar, children, className, contentClassName }: WindowFrameProps) {
  const isMaximized = useMaximized();

  return (
    <ThemeProvider defaultTheme="system" storageKey="tauri-ui-theme">
      <div
        className={cn(
          "bg-background flex h-screen w-screen flex-col overflow-hidden",
          isMaximized ? "" : "border-border rounded-lg border",
          className
        )}
      >
        {titleBar}
        <main className={contentClassName}>{children}</main>
        <WindowContextMenu />
        <Toaster />
      </div>
    </ThemeProvider>
  );
}
