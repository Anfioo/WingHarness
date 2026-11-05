import { ChevronDown, FileText, Plus, X } from "lucide-react";
import type { ReactNode } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useAppTranslation } from "@/hooks/use-app-translation";
import type { MdRecentEntry, MdTabState } from "./types";

export interface TabBarProps {
  tabs: MdTabState[];
  activeId: string | null;
  recent: MdRecentEntry[];
  onSelect(id: string): void;
  onClose(id: string): void;
  onNew(): void;
  onOpen(): void;
  onOpenRecent(path: string): void;
  /** Trailing controls, e.g. the view-mode switch. */
  children?: ReactNode;
}

export function TabBar(props: TabBarProps) {
  const { tabs, activeId, recent, onSelect, onClose, onNew, onOpen, onOpenRecent, children } =
    props;
  const { t } = useAppTranslation();

  return (
    <div className="flex h-9 shrink-0 items-center gap-1 border-b px-1">
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        {tabs.map((tab) => {
          const active = tab.id === activeId;
          const dirty = tab.content !== tab.savedContent;
          return (
            <div
              key={tab.id}
              role="tab"
              aria-selected={active}
              tabIndex={0}
              title={tab.path ?? tab.name}
              onClick={() => onSelect(tab.id)}
              onAuxClick={(event) => {
                if (event.button === 1) {
                  event.preventDefault();
                  onClose(tab.id);
                }
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSelect(tab.id);
                }
              }}
              className={cn(
                "group flex h-7 max-w-48 min-w-0 shrink-0 cursor-default items-center gap-1.5 rounded-sm px-2 text-xs select-none",
                active
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:bg-accent/50"
              )}
            >
              <span className="truncate">{tab.name}</span>
              {dirty && (
                <span
                  aria-hidden
                  className="bg-foreground size-1.5 shrink-0 rounded-full opacity-70 group-hover:hidden"
                />
              )}
              <button
                type="button"
                aria-label={t("mdEditor.tab.close")}
                title={t("mdEditor.tab.close")}
                onClick={(event) => {
                  event.stopPropagation();
                  onClose(tab.id);
                }}
                className={cn(
                  "hover:bg-foreground/10 flex size-4 shrink-0 items-center justify-center rounded-sm",
                  dirty ? "hidden group-hover:flex" : "opacity-60 hover:opacity-100"
                )}
              >
                <X className="size-3" />
              </button>
            </div>
          );
        })}

        <button
          type="button"
          aria-label={t("mdEditor.empty.new")}
          title={t("mdEditor.empty.new")}
          onClick={onNew}
          className="text-muted-foreground hover:bg-accent/50 hover:text-foreground flex size-6 shrink-0 items-center justify-center rounded-sm"
        >
          <Plus className="size-3.5" />
        </button>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={t("mdEditor.empty.open")}
              title={t("mdEditor.empty.open")}
              className="text-muted-foreground hover:bg-accent/50 hover:text-foreground flex size-6 shrink-0 items-center justify-center rounded-sm"
            >
              <ChevronDown className="size-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-64">
            <DropdownMenuItem onSelect={onOpen}>
              <FileText />
              {t("mdEditor.empty.open")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>{t("mdEditor.empty.recent")}</DropdownMenuLabel>
            {recent.length === 0 ? (
              <div className="text-muted-foreground px-2 py-1.5 text-xs">
                {t("mdEditor.empty.description")}
              </div>
            ) : (
              recent.map((entry) => (
                <DropdownMenuItem
                  key={entry.path}
                  disabled={entry.missing}
                  title={
                    entry.missing ? t("mdEditor.error.notFound", { path: entry.path }) : entry.path
                  }
                  onSelect={() => onOpenRecent(entry.path)}
                  className={cn(entry.missing && "opacity-50")}
                >
                  <FileText />
                  <span className="truncate">{entry.name}</span>
                </DropdownMenuItem>
              ))
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {children && <div className="flex shrink-0 items-center gap-1">{children}</div>}
    </div>
  );
}
