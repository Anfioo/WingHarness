import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import { ExternalLink, FolderOpen, Trash2 } from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { useAppTranslation } from "@/hooks/use-app-translation";

type FileEntryContextMenuProps = {
  /** Rendered as the right-click surface; must accept a ref (a single element). */
  children: ReactNode;
  /** Identity of the entry under the pointer; changing it closes the menu. */
  entryKey?: string | number;
  enabled?: boolean;
  openDisabled?: boolean;
  revealDisabled?: boolean;
  deleteDisabled?: boolean;
  onOpen: () => void;
  onReveal: () => void;
  onDelete: () => void;
  /**
   * Runs on the trigger before the menu opens. Charts use it to bind the tile
   * under the pointer and call `preventDefault()` on empty canvas.
   */
  onContextMenu?: (event: MouseEvent<HTMLElement>) => void;
  /** Lets the owner suppress chart tooltips while a menu is open. */
  onMenuStateChange?: (open: boolean) => void;
};

/**
 * Presentation-only entry menu shared by the analysis, large-file, and
 * duplicate-file surfaces. The owner maps these actions to its own entry model
 * and must route deletion through its confirmation flow.
 */
export function FileEntryContextMenu({
  children,
  entryKey,
  enabled = true,
  openDisabled = false,
  revealDisabled = false,
  deleteDisabled = false,
  onOpen,
  onReveal,
  onDelete,
  onContextMenu,
  onMenuStateChange,
}: FileEntryContextMenuProps) {
  const { t } = useAppTranslation();
  const openRef = useRef(false);
  const notifyRef = useRef(onMenuStateChange);
  const [resetToken, setResetToken] = useState(0);

  useLayoutEffect(() => {
    notifyRef.current = onMenuStateChange;
  });

  // Radix context menus are uncontrolled, so an open menu is closed by
  // remounting the root. Only remount when it is actually open: a recycled
  // virtual row changes identity while shut, and charts would lose their
  // state if every entryKey change tore the subtree down.
  useLayoutEffect(() => {
    if (!openRef.current) return;
    openRef.current = false;
    notifyRef.current?.(false);
    setResetToken((token) => token + 1);
  }, [entryKey, enabled]);

  useEffect(
    () => () => {
      if (!openRef.current) return;
      openRef.current = false;
      notifyRef.current?.(false);
    },
    []
  );

  if (!enabled) return <>{children}</>;

  const handleOpenChange = (next: boolean) => {
    openRef.current = next;
    notifyRef.current?.(next);
  };

  return (
    <ContextMenu key={resetToken} onOpenChange={handleOpenChange}>
      <ContextMenuTrigger asChild onContextMenu={onContextMenu}>
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem disabled={openDisabled} onSelect={onOpen}>
          <ExternalLink className="size-4" />
          {t("systools.common.open")}
        </ContextMenuItem>
        <ContextMenuItem disabled={revealDisabled} onSelect={onReveal}>
          <FolderOpen className="size-4" />
          {t("systools.common.showInFileManager")}
        </ContextMenuItem>
        <ContextMenuItem variant="destructive" disabled={deleteDisabled} onSelect={onDelete}>
          <Trash2 className="size-4" />
          {t("systools.common.deletePermanently")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
