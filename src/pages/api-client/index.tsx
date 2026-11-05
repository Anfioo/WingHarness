import { useCallback, useEffect, useMemo, useState } from "react";
import {
  FileJson2,
  FolderPlus,
  Loader2,
  MoreHorizontal,
  Pencil,
  Search,
  Send,
  Trash2,
  Upload,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmHost, confirmDialog } from "@/components/confirm";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { OpenApiImportDialog } from "@/features/api-client/import";
import { useApiClient } from "@/features/api-client/store";
import type { WorkspaceMeta } from "@/lib/api-core/types";
import {
  apiWorkspaceWindowLabel,
  openApiWorkspaceWindow,
  openApiWorkspaceWindowLabels,
} from "@/lib/api-windows";
import { cn } from "@/lib/utils";

/** RFC 3339 timestamp as a locale-aware "3 hours ago". */
function relativeTime(iso: string, language: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const deltaSeconds = Math.round((then - Date.now()) / 1000);
  const abs = Math.abs(deltaSeconds);
  const format = new Intl.RelativeTimeFormat(language, { numeric: "auto" });
  if (abs < 60) return format.format(deltaSeconds, "second");
  if (abs < 3600) return format.format(Math.round(deltaSeconds / 60), "minute");
  if (abs < 86_400) return format.format(Math.round(deltaSeconds / 3600), "hour");
  if (abs < 86_400 * 30) return format.format(Math.round(deltaSeconds / 86_400), "day");
  if (abs < 86_400 * 365) return format.format(Math.round(deltaSeconds / (86_400 * 30)), "month");
  return format.format(Math.round(deltaSeconds / (86_400 * 365)), "year");
}

type NameDialogState = { mode: "create" | "rename"; id: string | null; value: string } | null;

/**
 * The API client's page of the main window: the workspace picker. Like the Git
 * picker it is a page of the shell, so it draws no frame of its own; opening a
 * workspace hands it to a window of its own (`@/lib/api-windows`).
 */
export default function ApiClientPage() {
  const { t, i18n } = useTranslation("translation", { keyPrefix: "apiClient.welcome" });
  const language = i18n.resolvedLanguage ?? i18n.language;

  const workspaces = useApiClient((state) => state.workspaces);
  const listLoading = useApiClient((state) => state.listLoading);
  const loadWorkspaces = useApiClient((state) => state.loadWorkspaces);
  const createWorkspace = useApiClient((state) => state.createWorkspace);
  const renameWorkspace = useApiClient((state) => state.renameWorkspace);
  const deleteWorkspace = useApiClient((state) => state.deleteWorkspace);

  const [query, setQuery] = useState("");
  const [openLabels, setOpenLabels] = useState<Set<string>>(new Set());
  const [nameDialog, setNameDialog] = useState<NameDialogState>(null);
  const [nameBusy, setNameBusy] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  // Which workspaces already have a window open. Nothing announces a window
  // closing, so the list is re-scanned whenever this window comes back to the
  // front — the only moment it can change without this page doing it.
  const refreshOpenLabels = useCallback(() => {
    void openApiWorkspaceWindowLabels().then((labels) => setOpenLabels(new Set(labels)));
  }, []);

  useEffect(() => {
    void loadWorkspaces().catch(() => undefined);
    refreshOpenLabels();
    window.addEventListener("focus", refreshOpenLabels);
    document.addEventListener("visibilitychange", refreshOpenLabels);
    return () => {
      window.removeEventListener("focus", refreshOpenLabels);
      document.removeEventListener("visibilitychange", refreshOpenLabels);
    };
  }, [loadWorkspaces, refreshOpenLabels]);

  const openWorkspaceWindow = useCallback(
    (workspace: WorkspaceMeta) => {
      void openApiWorkspaceWindow(workspace.id, workspace.name).then(refreshOpenLabels);
    },
    [refreshOpenLabels]
  );

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return workspaces;
    return workspaces.filter((workspace) => workspace.name.toLowerCase().includes(needle));
  }, [workspaces, query]);

  const submitName = useCallback(async () => {
    const dialog = nameDialog;
    const name = dialog?.value.trim() ?? "";
    if (!dialog || !name || nameBusy) return;
    setNameBusy(true);
    try {
      if (dialog.mode === "create") {
        const meta = await createWorkspace(name);
        openWorkspaceWindow(meta);
      } else if (dialog.id) {
        await renameWorkspace(dialog.id, name);
      }
      setNameDialog(null);
    } catch (error) {
      toast.error(t(dialog.mode === "create" ? "toast.createFailed" : "toast.renameFailed"));
      console.error("Workspace name action failed:", error);
    } finally {
      setNameBusy(false);
    }
  }, [createWorkspace, nameBusy, nameDialog, openWorkspaceWindow, renameWorkspace, t]);

  const removeWorkspace = useCallback(
    async (workspace: WorkspaceMeta) => {
      const confirmed = await confirmDialog({
        title: t("delete.title"),
        description: t("delete.description", { name: workspace.name }),
        confirmLabel: t("delete.confirm"),
        destructive: true,
      });
      if (!confirmed) return;
      try {
        await deleteWorkspace(workspace.id);
        toast.success(t("toast.deleted", { name: workspace.name }));
      } catch (error) {
        toast.error(t("toast.deleteFailed"));
        console.error("Failed to delete workspace:", error);
      }
    },
    [deleteWorkspace, t]
  );

  return (
    <div className="flex flex-1 flex-col overflow-y-auto">
      <div className="animate-fade-in w-full px-6 py-8">
        <header className="mb-6 flex items-center gap-3">
          <span className="bg-primary/10 text-primary flex size-12 shrink-0 items-center justify-center rounded-xl">
            <Send className="size-6" />
          </span>
          <div className="min-w-0">
            <h1 className="text-primary text-xl font-semibold tracking-tight">
              {t("header.brand")}
            </h1>
            <p className="text-muted-foreground text-sm">{t("header.tagline")}</p>
          </div>
        </header>

        <section className="border-border bg-card shadow-soft rounded-lg border">
          <div className="border-border flex flex-wrap items-center gap-2 border-b px-4 py-3">
            <h2 className="text-sm font-medium">{t("list.title")}</h2>
            <span className="text-faint text-xs">{visible.length}</span>
            <div className="relative ml-auto w-52">
              <Search className="text-faint pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t("list.searchPlaceholder")}
                aria-label={t("list.searchLabel")}
                className="h-7 pl-8 text-xs"
              />
            </div>
            <Button variant="secondary" size="sm" onClick={() => setImportOpen(true)}>
              <Upload className="size-3.5" />
              {t("actions.import")}
            </Button>
            <Button
              size="sm"
              onClick={() => setNameDialog({ mode: "create", id: null, value: "" })}
            >
              <FolderPlus className="size-3.5" />
              {t("actions.create")}
            </Button>
          </div>

          {listLoading && workspaces.length === 0 ? (
            <div className="text-muted-foreground flex items-center justify-center gap-2 px-6 py-12 text-sm">
              <Loader2 className="size-4 animate-spin" />
              {t("list.loading")}
            </div>
          ) : workspaces.length === 0 ? (
            <div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
              <span className="bg-muted text-muted-foreground flex size-12 items-center justify-center rounded-full">
                <FileJson2 className="size-6" />
              </span>
              <div>
                <p className="text-sm font-medium">{t("empty.title")}</p>
                <p className="text-muted-foreground mx-auto mt-1 max-w-md text-xs">
                  {t("empty.description")}
                </p>
              </div>
              <div className="flex flex-wrap justify-center gap-2">
                <Button variant="secondary" size="sm" onClick={() => setImportOpen(true)}>
                  <Upload className="size-3.5" />
                  {t("empty.import")}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setNameDialog({ mode: "create", id: null, value: "" })}
                >
                  <FolderPlus className="size-3.5" />
                  {t("empty.create")}
                </Button>
              </div>
            </div>
          ) : visible.length === 0 ? (
            <p className="text-muted-foreground px-4 py-8 text-center text-xs">
              {t("list.noMatch", { query })}
            </p>
          ) : (
            <ul className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-3">
              {visible.map((workspace) => (
                <WorkspaceCard
                  key={workspace.id}
                  workspace={workspace}
                  updatedAt={relativeTime(workspace.updatedAt, language)}
                  isOpen={openLabels.has(apiWorkspaceWindowLabel(workspace.id))}
                  labels={{
                    requests: (count) => t("card.requests", { count }),
                    alreadyOpen: t("card.alreadyOpen"),
                    menuAria: t("card.menuAria", { name: workspace.name }),
                    open: t("card.open"),
                    rename: t("card.rename"),
                    remove: t("card.remove"),
                  }}
                  onOpen={() => openWorkspaceWindow(workspace)}
                  onRename={() =>
                    setNameDialog({ mode: "rename", id: workspace.id, value: workspace.name })
                  }
                  onRemove={() => void removeWorkspace(workspace)}
                />
              ))}
            </ul>
          )}
        </section>
      </div>

      <NameDialog
        dialog={nameDialog}
        busy={nameBusy}
        onChange={(value) =>
          setNameDialog((current) => (current ? { ...current, value } : current))
        }
        onCancel={() => setNameDialog(null)}
        onSubmit={() => void submitName()}
        labels={{
          createTitle: t("nameDialog.createTitle"),
          renameTitle: t("nameDialog.renameTitle"),
          createDescription: t("nameDialog.createDescription"),
          renameDescription: t("nameDialog.renameDescription"),
          nameLabel: t("nameDialog.nameLabel"),
          namePlaceholder: t("nameDialog.namePlaceholder"),
          cancel: t("nameDialog.cancel"),
          confirm: t("nameDialog.confirm"),
        }}
      />

      <OpenApiImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        onCreated={openWorkspaceWindow}
      />

      <ConfirmHost />
    </div>
  );
}

interface WorkspaceCardLabels {
  requests: (count: number) => string;
  alreadyOpen: string;
  menuAria: string;
  open: string;
  rename: string;
  remove: string;
}

function WorkspaceCard({
  workspace,
  updatedAt,
  isOpen,
  labels,
  onOpen,
  onRename,
  onRemove,
}: {
  workspace: WorkspaceMeta;
  updatedAt: string;
  isOpen: boolean;
  labels: WorkspaceCardLabels;
  onOpen: () => void;
  onRename: () => void;
  onRemove: () => void;
}) {
  return (
    <li className="group border-border bg-background hover:border-primary/40 relative flex flex-col gap-3 rounded-lg border p-3 transition-colors">
      <button type="button" onClick={onOpen} className="flex min-w-0 items-start gap-3 text-left">
        <span
          className={cn(
            "flex size-9 shrink-0 items-center justify-center rounded-md",
            isOpen ? "bg-primary text-primary-foreground" : "bg-primary/10 text-primary"
          )}
        >
          <FileJson2 className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-sm font-medium">{workspace.name}</span>
            {isOpen ? (
              <Badge variant="secondary" className="shrink-0 px-1.5 text-[10px]">
                {labels.alreadyOpen}
              </Badge>
            ) : null}
          </span>
          <span className="text-muted-foreground mt-0.5 block truncate text-xs">
            {labels.requests(workspace.requestCount)}
          </span>
        </span>
      </button>

      <div className="flex items-center justify-between gap-2">
        <span className="text-faint text-[11px]">{updatedAt}</span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
              aria-label={labels.menuAria}
            >
              <MoreHorizontal className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuItem onSelect={onOpen}>
              <Send className="size-3.5" />
              {labels.open}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onRename}>
              <Pencil className="size-3.5" />
              {labels.rename}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={onRemove}>
              <Trash2 className="size-3.5" />
              {labels.remove}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </li>
  );
}

interface NameDialogLabels {
  createTitle: string;
  renameTitle: string;
  createDescription: string;
  renameDescription: string;
  nameLabel: string;
  namePlaceholder: string;
  cancel: string;
  confirm: string;
}

function NameDialog({
  dialog,
  busy,
  labels,
  onChange,
  onCancel,
  onSubmit,
}: {
  dialog: NameDialogState;
  busy: boolean;
  labels: NameDialogLabels;
  onChange: (value: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const creating = dialog?.mode === "create";
  return (
    <Dialog open={dialog !== null} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{creating ? labels.createTitle : labels.renameTitle}</DialogTitle>
          <DialogDescription>
            {creating ? labels.createDescription : labels.renameDescription}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <label className="text-xs font-medium" htmlFor="api-workspace-name">
            {labels.nameLabel}
          </label>
          <Input
            id="api-workspace-name"
            value={dialog?.value ?? ""}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") onSubmit();
            }}
            placeholder={labels.namePlaceholder}
            autoFocus
          />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel}>
            {labels.cancel}
          </Button>
          <Button onClick={onSubmit} disabled={busy || !(dialog?.value.trim() ?? "")}>
            {labels.confirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// (Import flow lives in `@/features/api-client/import`.)
