import type { ReactNode } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useGitActions } from "./actions";

export interface MenuPoint {
  x: number;
  y: number;
}

export interface ProjectMenuItem {
  id: string;
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
  disabled?: boolean;
  /** Already-translated reason the item is unavailable; shown as its tooltip. */
  disabledReason?: string;
  destructive?: boolean;
  separatorBefore?: boolean;
  checked?: boolean;
  shortcut?: string;
}

/**
 * The project page's right-click menu: a Radix dropdown anchored at the pointer
 * and closed by any pick. Items are described as data so the three panes only
 * decide what to offer, while busy handling and separator drawing stay here.
 */
export function ProjectContextMenu({
  point,
  title,
  items,
  onClose,
}: {
  point: MenuPoint | null;
  title?: ReactNode;
  items: Array<ProjectMenuItem | null | false>;
  onClose: () => void;
}) {
  const busy = useGitActions((state) => state.busy);
  if (!point) return null;
  return (
    <DropdownMenu open onOpenChange={(open) => !open && onClose()}>
      <DropdownMenuTrigger asChild>
        <span style={{ position: "fixed", left: point.x, top: point.y }} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="bottom" className="max-w-72 min-w-56">
        {title && (
          <DropdownMenuLabel className="truncate font-mono text-xs">{title}</DropdownMenuLabel>
        )}
        {items.map((item, index) => {
          if (!item) return null;
          return (
            <ProjectMenuRow
              key={item.id}
              item={item}
              busy={busy !== null}
              first={index === 0}
              onClose={onClose}
            />
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ProjectMenuRow({
  item,
  busy,
  first,
  onClose,
}: {
  item: ProjectMenuItem;
  busy: boolean;
  first: boolean;
  onClose: () => void;
}) {
  return (
    <>
      {item.separatorBefore && !first && <DropdownMenuSeparator />}
      <DropdownMenuItem
        disabled={busy || item.disabled}
        variant={item.destructive ? "destructive" : "default"}
        title={item.disabled ? item.disabledReason : undefined}
        onSelect={() => {
          onClose();
          item.onSelect();
        }}
      >
        {item.checked ? <span aria-hidden>✓</span> : item.icon}
        <span className="min-w-0 flex-1 truncate">{item.label}</span>
        {item.shortcut && <DropdownMenuShortcut>{item.shortcut}</DropdownMenuShortcut>}
      </DropdownMenuItem>
    </>
  );
}
