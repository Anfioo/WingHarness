import { useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  FilePlus2,
  Folder,
  FolderPlus,
  FolderTree,
  Pencil,
  Plus,
  Search,
  SearchX,
  Trash2,
} from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { EmptyPane } from "@/components/api-client/empty-pane";
import { FileTree, type FileTreeItemMeta } from "@/components/api-client/file-tree";
import { MethodBadge } from "@/components/api-client/method-badge";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Input } from "@/components/ui/input";
import { useApiClient } from "@/features/api-client/store";
import { createEmptyRequest } from "@/lib/api-core/request-model";
import { cn } from "@/lib/utils";
import { ConfirmDeleteDialog, NodeNameDialog } from "./dialogs";
import { buildTreeEntries, collectNodeIds, entryChildren, type TreeEntry } from "./tree";
import { useExpandedNodes } from "./use-expanded";

/** The in-progress name prompt: creating under `parentId`, or renaming `id`. */
type NameDialogState =
  | { mode: "create"; parentId: string; value: string }
  | { mode: "rename"; id: string; value: string; original: string }
  | null;

/** The row awaiting delete confirmation, so the copy can name what is removed. */
type DeleteTarget = { id: string; name: string; kind: "node" | "request" } | null;

/**
 * The collection tree: the left column of the workspace. It renders the open
 * workspace's `collections` as an expandable tree of folders and requests,
 * filters it by name, and offers create/rename/delete through a row context
 * menu. All mutations go through the store; this pane only wires the UI to it.
 */
export function CollectionPane() {
  const { t } = useTranslation("translation", { keyPrefix: "apiClient.collection" });
  const { t: tCommon } = useTranslation("translation", { keyPrefix: "apiClient.common" });

  const tree = useApiClient((state) => state.tree);
  const selectedRequestId = useApiClient((state) => state.selectedRequestId);
  const selectRequest = useApiClient((state) => state.selectRequest);
  const addRequest = useApiClient((state) => state.addRequest);
  const addFolder = useApiClient((state) => state.addFolder);
  const renameNode = useApiClient((state) => state.renameNode);
  const deleteNode = useApiClient((state) => state.deleteNode);
  const deleteRequest = useApiClient((state) => state.deleteRequest);

  const [query, setQuery] = useState("");
  const [nameDialog, setNameDialog] = useState<NameDialogState>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget>(null);

  const collections = tree?.collections ?? null;
  const topLevelIds = useMemo(() => (collections ?? []).map((node) => node.id), [collections]);
  const { expanded, toggle, expand } = useExpandedNodes(tree?.id ?? "", topLevelIds);

  const filtering = query.trim() !== "";
  const entries = useMemo(() => buildTreeEntries(collections ?? [], query), [collections, query]);
  // While filtering, reveal every surviving branch so matches are visible.
  const expandedForRender = useMemo(
    () => (filtering ? new Set(collectNodeIds(entries)) : expanded),
    [filtering, entries, expanded]
  );

  const openCreateDialog = (parentId: string, value: string) =>
    setNameDialog({ mode: "create", parentId, value });

  const openCollectionDialog = () => openCreateDialog("", t("defaults.collection"));

  const createRequest = (parentId: string) => {
    const request = createEmptyRequest(t("defaults.request"));
    addRequest(parentId, request);
    expand(parentId);
    selectRequest(request.id);
  };

  const submitName = () => {
    const dialog = nameDialog;
    const name = dialog?.value.trim() ?? "";
    if (!dialog || name === "") return;
    if (dialog.mode === "create") {
      const id = addFolder(dialog.parentId, name);
      if (dialog.parentId !== "") expand(dialog.parentId);
      else expand(id);
    } else {
      renameNode(dialog.id, name);
    }
    setNameDialog(null);
  };

  const confirmDelete = () => {
    const target = deleteTarget;
    if (!target) return;
    if (target.kind === "node") deleteNode(target.id);
    else deleteRequest(target.id);
    setDeleteTarget(null);
    toast.success(t("toast.deleted", { name: target.name }));
  };

  const renderRow = (entry: TreeEntry, meta: FileTreeItemMeta): ReactNode => {
    const node = entry.kind === "node" ? entry.node : null;
    const request = entry.kind === "request" ? entry.request : null;
    const selected = request !== null && entry.id === selectedRequestId;
    const Chevron = meta.expanded ? ChevronDown : ChevronRight;

    return (
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            role="button"
            tabIndex={0}
            aria-label={entry.name}
            aria-expanded={node ? meta.expanded : undefined}
            data-selected={selected || undefined}
            onClick={() => (node ? meta.toggle() : selectRequest(entry.id))}
            onKeyDown={(event) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              if (node) meta.toggle();
              else selectRequest(entry.id);
            }}
            style={{ paddingLeft: 6 + meta.depth * 12 }}
            className={cn(
              "flex h-7 min-w-0 cursor-default items-center gap-1.5 rounded pr-2 text-xs outline-none",
              selected
                ? "bg-accent text-accent-foreground"
                : "hover:bg-accent/50 focus-visible:bg-accent/60"
            )}
          >
            {meta.hasChildren ? (
              <button
                type="button"
                tabIndex={-1}
                aria-hidden
                onClick={(event) => {
                  event.stopPropagation();
                  meta.toggle();
                }}
                className="text-muted-foreground hover:text-foreground -ml-0.5 flex size-4 shrink-0 items-center justify-center rounded"
              >
                <Chevron className="size-3.5" />
              </button>
            ) : (
              <span aria-hidden className="size-4 shrink-0" />
            )}
            {node ? (
              <Folder className="text-muted-foreground size-3.5 shrink-0" />
            ) : (
              <MethodBadge method={request?.method ?? "GET"} />
            )}
            <span className="truncate" title={entry.name}>
              {entry.name}
            </span>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-44">
          {node ? (
            <>
              <ContextMenuItem onSelect={() => createRequest(entry.id)}>
                <FilePlus2 className="size-3.5" />
                {t("menu.newRequest")}
              </ContextMenuItem>
              <ContextMenuItem onSelect={() => openCreateDialog(entry.id, t("defaults.folder"))}>
                <FolderPlus className="size-3.5" />
                {t("menu.newFolder")}
              </ContextMenuItem>
              <ContextMenuSeparator />
            </>
          ) : null}
          <ContextMenuItem
            onSelect={() =>
              setNameDialog({
                mode: "rename",
                id: entry.id,
                value: entry.name,
                original: entry.name,
              })
            }
          >
            <Pencil className="size-3.5" />
            {tCommon("actions.rename")}
          </ContextMenuItem>
          <ContextMenuItem
            variant="destructive"
            onSelect={() => setDeleteTarget({ id: entry.id, name: entry.name, kind: entry.kind })}
          >
            <Trash2 className="size-3.5" />
            {tCommon("actions.delete")}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    );
  };

  const hasCollections = (collections?.length ?? 0) > 0;

  let body: ReactNode;
  if (tree === null) {
    body = (
      <EmptyPane
        icon={<FolderTree className="size-5" />}
        title={t("empty.noWorkspace.title")}
        description={t("empty.noWorkspace.description")}
      />
    );
  } else if (!hasCollections) {
    body = (
      <EmptyPane
        icon={<FolderTree className="size-5" />}
        title={t("empty.noCollections.title")}
        description={t("empty.noCollections.description")}
        action={
          <Button variant="secondary" size="sm" onClick={openCollectionDialog}>
            <FolderPlus className="size-3.5" />
            {t("newCollection")}
          </Button>
        }
      />
    );
  } else if (filtering && entries.length === 0) {
    body = (
      <EmptyPane
        icon={<SearchX className="size-5" />}
        title={t("empty.noMatch.title")}
        description={t("empty.noMatch.description", { query: query.trim() })}
      />
    );
  } else {
    body = (
      <FileTree
        items={entries}
        getKey={(entry) => entry.id}
        getChildren={entryChildren}
        expanded={expandedForRender}
        onToggle={toggle}
        selectedKey={selectedRequestId}
        renderItem={renderRow}
        className="py-1"
        aria-label={t("title")}
      />
    );
  }

  const dialogTitle =
    nameDialog?.mode === "rename"
      ? t("nameDialog.renameTitle")
      : nameDialog?.mode === "create" && nameDialog.parentId === ""
        ? t("nameDialog.newCollectionTitle")
        : t("nameDialog.newFolderTitle");
  const dialogDescription =
    nameDialog?.mode === "rename"
      ? t("nameDialog.renameDescription", { name: nameDialog.original })
      : t("nameDialog.newDescription");
  const deleteDescription =
    deleteTarget?.kind === "node"
      ? t("delete.nodeDescription", { name: deleteTarget.name })
      : t("delete.requestDescription", { name: deleteTarget?.name ?? "" });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-border flex h-9 shrink-0 items-center gap-2 border-b px-3">
        <span className="text-muted-foreground truncate text-[11px] font-semibold tracking-wide uppercase">
          {t("title")}
        </span>
        <Button
          variant="ghost"
          size="icon-xs"
          className="ml-auto"
          onClick={openCollectionDialog}
          disabled={tree === null}
          aria-label={t("newCollection")}
        >
          <Plus className="size-3.5" />
        </Button>
      </div>

      <div className="border-border shrink-0 border-b px-3 py-2">
        <div className="relative">
          <Search className="text-faint pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("searchPlaceholder")}
            aria-label={t("searchLabel")}
            className="h-7 pl-8 text-xs"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">{body}</div>

      <NodeNameDialog
        open={nameDialog !== null}
        value={nameDialog?.value ?? ""}
        title={dialogTitle}
        description={dialogDescription}
        onChange={(value) =>
          setNameDialog((current) => (current ? { ...current, value } : current))
        }
        onCancel={() => setNameDialog(null)}
        onSubmit={submitName}
      />

      <ConfirmDeleteDialog
        open={deleteTarget !== null}
        title={t("delete.title")}
        description={deleteDescription}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={confirmDelete}
      />
    </div>
  );
}

export default CollectionPane;
