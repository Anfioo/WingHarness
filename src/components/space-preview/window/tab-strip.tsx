// The tab strip above the viewer in the standalone window.

import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { stepTab } from "@/lib/space-preview/preview-tabs";
import type { PreviewEntry } from "@/lib/space-preview/window-session";

interface PreviewTabStripProps {
  tabs: PreviewEntry[];
  activePath: string | null;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
}

export function PreviewTabStrip({ tabs, activePath, onSelect, onClose }: PreviewTabStripProps) {
  const { t } = useAppTranslation();

  return (
    <div
      className="border-border bg-card flex h-8 shrink-0 items-stretch gap-0 overflow-x-auto border-b"
      role="tablist"
      aria-label={t("spacePreview.window.tabs", { defaultValue: "Preview tabs" })}
      onKeyDown={(event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        event.stopPropagation();
        const nextPath =
          event.key === "Home"
            ? tabs[0].path
            : event.key === "End"
              ? tabs[tabs.length - 1].path
              : stepTab(tabs, activePath, event.key === "ArrowRight" ? 1 : -1);
        if (!nextPath) return;
        const next = tabs.findIndex((tab) => tab.path === nextPath);
        onSelect(nextPath);
        requestAnimationFrame(() =>
          event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus()
        );
      }}
    >
      {tabs.map((tab) => {
        const selected = tab.path === activePath;
        return (
          <div
            key={tab.path}
            className={cn(
              "group border-border flex max-w-56 min-w-0 shrink-0 items-center border-r",
              selected ? "bg-background" : "hover:bg-accent/60"
            )}
          >
            <button
              type="button"
              role="tab"
              aria-selected={selected}
              tabIndex={selected ? 0 : -1}
              title={tab.path}
              className={cn(
                "min-w-0 truncate px-3 text-xs",
                selected ? "text-foreground" : "text-muted-foreground"
              )}
              onClick={() => onSelect(tab.path)}
            >
              {tab.name}
            </button>
            <button
              type="button"
              aria-label={t("spacePreview.window.closeTab", {
                defaultValue: "Close {{name}}",
                name: tab.name,
              })}
              title={t("spacePreview.window.closeTab", {
                defaultValue: "Close {{name}}",
                name: tab.name,
              })}
              className="hover:bg-accent mr-1 rounded p-0.5 opacity-60 group-hover:opacity-100"
              onClick={() => onClose(tab.path)}
            >
              <X className="size-3" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
