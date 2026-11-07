// The toolbar above the object tree: IDEA's seven actions. The New dropdown is
// shared with the tree's context menu.

import { useEffect, useState, type ReactNode } from "react";
import {
  ChevronDown,
  FileCode2,
  Loader2,
  Plus,
  RefreshCw,
  Settings2,
  Table2,
  Terminal,
  Unplug,
} from "lucide-react";
import { toast } from "sonner";
import { dbQueries, type QueryFile } from "@/commands";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { newMenu } from "./tree-menu";
import { useDatabaseStore } from "./store";

export type TreeToolbarProps = {
  disabled: boolean;
  connected: boolean;
  onNewQuery(): void;
  onOpenQuery(): void;
  onNewTable(): void;
  onProperties(): void;
  onRefresh(): void;
  onDisconnect(): void;
  onJumpToConsole(): void;
  onEditData(): void;
  onShowDdl(): void;
  canEditData: boolean;
  canShowDdl: boolean;
};

function ToolbarButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick(): void;
  children: ReactNode;
}) {
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      disabled={disabled}
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

function ToolbarSeparator() {
  return <span className="bg-border mx-1 h-4 w-px shrink-0" aria-hidden />;
}

/**
 * The action row of the object tree. It is presentation only: which nodes the
 * selection-dependent actions apply to arrives as `canEditData` / `canShowDdl`.
 */
export function TreeToolbar({
  disabled,
  connected,
  onNewQuery,
  onOpenQuery,
  onNewTable,
  onProperties,
  onRefresh,
  onDisconnect,
  onJumpToConsole,
  onEditData,
  onShowDdl,
  canEditData,
  canShowDdl,
}: TreeToolbarProps): ReactNode {
  const { t } = useAppTranslation();
  const items = newMenu((key) => t(key), {
    newQuery: onNewQuery,
    openQuery: onOpenQuery,
    newTable: onNewTable,
  });
  const offline = disabled || !connected;

  return (
    <div
      role="toolbar"
      aria-label={t("database.tree.title")}
      className="flex shrink-0 items-center gap-0.5 border-b px-2 py-1"
    >
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            disabled={disabled}
            aria-label={t("database.tree.toolbar.new")}
            title={t("database.tree.toolbar.new")}
          >
            <Plus />
            <ChevronDown className="size-2.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-52">
          {items.map((item) =>
            item.separator ? (
              <DropdownMenuSeparator key={item.id} />
            ) : (
              <DropdownMenuItem
                key={item.id}
                disabled={item.disabled || (item.id === "new.table" && offline)}
                onSelect={() => item.run()}
              >
                {item.label}
              </DropdownMenuItem>
            )
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <ToolbarButton
        label={t("database.tree.toolbar.properties")}
        disabled={disabled}
        onClick={onProperties}
      >
        <Settings2 />
      </ToolbarButton>

      <ToolbarSeparator />

      <ToolbarButton
        label={t("database.tree.toolbar.refresh")}
        disabled={offline}
        onClick={onRefresh}
      >
        <RefreshCw />
      </ToolbarButton>
      <ToolbarButton
        label={t("database.tree.toolbar.disconnect")}
        disabled={!connected}
        onClick={onDisconnect}
      >
        <Unplug />
      </ToolbarButton>

      <ToolbarSeparator />

      <ToolbarButton
        label={t("database.tree.toolbar.jumpToConsole")}
        disabled={disabled}
        onClick={onJumpToConsole}
      >
        <Terminal />
      </ToolbarButton>
      <ToolbarButton
        label={t("database.tree.toolbar.editData")}
        disabled={offline || !canEditData}
        onClick={onEditData}
      >
        <Table2 />
      </ToolbarButton>
      <ToolbarButton
        label={t("database.tree.toolbar.ddl")}
        disabled={offline || !canShowDdl}
        onClick={onShowDdl}
      >
        <FileCode2 />
      </ToolbarButton>
    </div>
  );
}

export type OpenQueryDialogProps = {
  open: boolean;
  onOpenChange(open: boolean): void;
  /** The query files to list, and how a chosen one opens. Give both or neither. */
  listFiles?: () => Promise<QueryFile[]>;
  onChoose?: (name: string) => Promise<void>;
};

/**
 * The picker the toolbar's "Open query…" and the empty workspace both use: it
 * lists the query directory and opens the chosen file in a tab.
 */
export function OpenQueryDialog(props: OpenQueryDialogProps): ReactNode {
  // The project page passes both callbacks and has no data source window behind
  // it, so the window store — which needs its provider — is never read there.
  if (props.listFiles && props.onChoose) {
    return (
      <OpenQueryDialogView
        open={props.open}
        onOpenChange={props.onOpenChange}
        listFiles={props.listFiles}
        onChoose={props.onChoose}
      />
    );
  }
  return <WindowOpenQueryDialog open={props.open} onOpenChange={props.onOpenChange} />;
}

/** The window's own query directory and tab opener. */
function WindowOpenQueryDialog(props: {
  open: boolean;
  onOpenChange(open: boolean): void;
}): ReactNode {
  const openQuery = useDatabaseStore((state) => state.openQuery);
  return (
    <OpenQueryDialogView
      open={props.open}
      onOpenChange={props.onOpenChange}
      listFiles={dbQueries}
      onChoose={openQuery}
    />
  );
}

type ResolvedOpenQueryDialogProps = {
  open: boolean;
  onOpenChange(open: boolean): void;
  listFiles: () => Promise<QueryFile[]>;
  onChoose: (name: string) => Promise<void>;
};

function OpenQueryDialogView({
  open,
  onOpenChange,
  listFiles,
  onChoose,
}: ResolvedOpenQueryDialogProps): ReactNode {
  const { t } = useAppTranslation();
  const [files, setFiles] = useState<QueryFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let live = true;
    setFiles(null);
    setError(null);
    listFiles()
      .then((list) => {
        if (live) setFiles([...list].sort((a, b) => a.name.localeCompare(b.name)));
      })
      .catch((failure: unknown) => {
        if (live) setError(failure instanceof Error ? failure.message : String(failure));
      });
    return () => {
      live = false;
    };
  }, [open, listFiles]);

  const choose = (name: string) => {
    onChoose(name)
      .then(() => onOpenChange(false))
      .catch((failure: unknown) =>
        toast.error(failure instanceof Error ? failure.message : String(failure))
      );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t("database.workspace.openQueryTitle")}</DialogTitle>
        </DialogHeader>
        <div className="max-h-72 overflow-auto">
          {error ? (
            <p className="text-destructive text-xs">{error}</p>
          ) : files === null ? (
            <p className="text-muted-foreground flex items-center gap-2 text-xs">
              <Loader2 className="animate-spin" />
              {t("database.tree.loading")}
            </p>
          ) : files.length === 0 ? (
            <p className="text-muted-foreground text-xs">
              {t("database.workspace.openQueryEmpty")}
            </p>
          ) : (
            <ul className="flex flex-col">
              {files.map((file) => (
                <li key={file.name}>
                  <button
                    type="button"
                    className="hover:bg-accent/60 flex w-full items-center gap-2 rounded-sm px-2 py-1 text-left text-xs"
                    onClick={() => choose(file.name)}
                  >
                    <FileCode2 className="text-muted-foreground size-3.5 shrink-0" />
                    <span className="truncate">{file.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
