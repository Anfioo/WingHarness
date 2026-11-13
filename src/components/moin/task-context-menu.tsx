// Adapted from moin (MIT), https://github.com/exxvius/moin at 79e7587.
// See `src-tauri/moin-core/UPSTREAM.md` for the porting record.

import type { ReactNode } from "react";
import { Copy, FolderInput, FolderOpen, Pause, Play, RotateCcw, Trash2, X } from "lucide-react";
import type { MoinCategory, MoinTask } from "@/commands";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { canCancel, canPause, canResume, canRetry, canReveal, isActiveStatus } from "./task-row";

/**
 * Every per-task command the list can fire. The tab owns the calls (so the
 * confirmations and the error toasts live in one place); this component only
 * decides which entries are reachable for a given status.
 */
export interface TaskActionHandlers {
  onPause: (task: MoinTask) => void;
  onResume: (task: MoinTask) => void;
  onRetry: (task: MoinTask) => void;
  onCancel: (task: MoinTask) => void;
  onReveal: (task: MoinTask) => void;
  onCopyUrl: (task: MoinTask) => void;
  onMoveToCategory: (task: MoinTask, category: string | null) => void;
  onDelete: (task: MoinTask) => void;
}

export interface TaskContextMenuProps {
  task: MoinTask;
  categories: MoinCategory[];
  handlers: TaskActionHandlers;
  children: ReactNode;
}

export function TaskContextMenu({ task, categories, handlers, children }: TaskContextMenuProps) {
  const { t } = useAppTranslation();
  // A running transfer cannot be deleted; the engine would answer `conflict`,
  // so the entry stays disabled until it reaches a final state.
  const settled = !isActiveStatus(task.status);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div>{children}</div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-56">
        <ContextMenuItem disabled={!canResume(task)} onSelect={() => handlers.onResume(task)}>
          <Play />
          {t("moin.action.resume")}
        </ContextMenuItem>
        <ContextMenuItem disabled={!canPause(task)} onSelect={() => handlers.onPause(task)}>
          <Pause />
          {t("moin.action.pause")}
        </ContextMenuItem>
        <ContextMenuItem disabled={!canRetry(task)} onSelect={() => handlers.onRetry(task)}>
          <RotateCcw />
          {t("moin.action.retry")}
        </ContextMenuItem>
        <ContextMenuItem disabled={!canCancel(task)} onSelect={() => handlers.onCancel(task)}>
          <X />
          {t("moin.action.cancel")}
        </ContextMenuItem>

        <ContextMenuSeparator />

        <ContextMenuItem disabled={!canReveal(task)} onSelect={() => handlers.onReveal(task)}>
          <FolderOpen />
          {t("moin.action.reveal")}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => handlers.onCopyUrl(task)}>
          <Copy />
          {t("moin.action.copyUrl")}
        </ContextMenuItem>
        <ContextMenuSub>
          <ContextMenuSubTrigger disabled={!settled}>
            <FolderInput />
            {t("moin.action.moveToCategory")}
          </ContextMenuSubTrigger>
          <ContextMenuSubContent className="w-52">
            <ContextMenuItem onSelect={() => handlers.onMoveToCategory(task, null)}>
              {t("moin.add.autoCategory")}
            </ContextMenuItem>
            {categories.map((category) => (
              <ContextMenuItem
                key={category.id}
                disabled={task.category === category.id}
                onSelect={() => handlers.onMoveToCategory(task, category.id)}
              >
                <span
                  aria-hidden
                  className="size-2 rounded-full"
                  style={{ backgroundColor: category.color || "var(--color-muted-foreground)" }}
                />
                {category.name}
              </ContextMenuItem>
            ))}
          </ContextMenuSubContent>
        </ContextMenuSub>

        <ContextMenuSeparator />

        <ContextMenuItem
          variant="destructive"
          disabled={!settled}
          onSelect={() => handlers.onDelete(task)}
        >
          <Trash2 />
          {t("moin.action.delete")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
