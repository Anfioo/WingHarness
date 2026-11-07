import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  Check,
  Download,
  Loader2,
  RefreshCw,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { toast } from "sonner";
import {
  shaicAgentDetail,
  shaicApply,
  shaicDashboard,
  shaicImportScope,
  shaicInit,
  shaicListItems,
  shaicPlan,
  shaicPull,
  shaicPush,
  shaicRemoveItem,
  shaicStatus,
  type AgentDetailView,
  type AgentRowView,
  type AxisView,
  type ItemKind,
  type ItemView,
  type MessageKind,
  type OpResult,
  type PlanView,
  type Scope,
  type StoreStatus,
  type SyncStatus,
} from "@/commands";
import { AppShell } from "@/components/app-shell";
import { ProjectPicker } from "@/components/project-picker";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { cn } from "@/lib/utils";
import { ItemEditorDialog, type EditorTarget } from "./item-editor-dialog";
import { HelpButton } from "./help-dialog";
import { PlanDialog } from "./plan-dialog";
import { StatusBadge } from "./status-badge";

type TabId = "agents" | "items";

const ITEM_KINDS: ItemKind[] = ["skill", "rule", "command", "subagent"];

/** A confirmation the UI must ask before a write (the TUI's y/N prompts). */
type Pending =
  | { kind: "import"; agent: string; scope: Scope; label: string }
  | { kind: "deleteItem"; item: ItemView }
  | { kind: "force"; action: "push" | "pull"; text: string };

export default function AiConfigPage() {
  const { t } = useAppTranslation();

  const [status, setStatus] = useState<StoreStatus | null>(null);
  const [root, setRoot] = useState("");
  const [rows, setRows] = useState<AgentRowView[]>([]);
  const [items, setItems] = useState<ItemView[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<TabId>("agents");

  const [remoteInput, setRemoteInput] = useState("");
  const [detail, setDetail] = useState<AgentDetailView | null>(null);
  const [plan, setPlan] = useState<PlanView | null>(null);
  const [applying, setApplying] = useState(false);
  const [editor, setEditor] = useState<EditorTarget | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);

  const loadAll = useCallback(
    async (announce = false) => {
      if (!root) {
        setStatus(null);
        setRows([]);
        setItems([]);
        setLoading(false);
        return;
      }
      try {
        const storeStatus = await shaicStatus(root);
        setStatus(storeStatus);
        if (storeStatus.exists) {
          const [dashboard, listed] = await Promise.all([shaicDashboard(root), shaicListItems()]);
          setRows(dashboard);
          setItems(listed.items);
        } else {
          setRows([]);
          setItems([]);
        }
        if (announce) toast.success(t("aiConfig.refreshed"));
      } catch (error) {
        console.error("shaic load:", error);
        toast.error(t("aiConfig.loadFailed"));
      } finally {
        setLoading(false);
      }
    },
    [root, t]
  );

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const announce = useCallback((result: OpResult) => {
    const map: Record<MessageKind, (text: string) => void> = {
      success: toast.success,
      info: toast.info,
      warning: toast.warning,
      error: toast.error,
    };
    map[result.kind](result.text);
  }, []);

  const runOp = useCallback(
    async (op: () => Promise<OpResult>) => {
      setBusy(true);
      try {
        announce(await op());
        await loadAll();
      } catch (error) {
        console.error("shaic op:", error);
        toast.error(String(error));
      } finally {
        setBusy(false);
      }
    },
    [announce, loadAll]
  );

  const handleInit = useCallback(async () => {
    setBusy(true);
    try {
      announce(await shaicInit(remoteInput));
      setRemoteInput("");
      await loadAll();
    } catch (error) {
      console.error("shaic init:", error);
      toast.error(String(error));
    } finally {
      setBusy(false);
    }
  }, [announce, loadAll, remoteInput]);

  const handlePush = useCallback(async () => {
    setBusy(true);
    try {
      const result = await shaicPush();
      announce(result);
      if (result.forceRequired) setPending({ kind: "force", action: "push", text: result.text });
      await loadAll();
    } catch (error) {
      console.error("shaic push:", error);
      toast.error(String(error));
    } finally {
      setBusy(false);
    }
  }, [announce, loadAll]);

  const handlePull = useCallback(async () => {
    setBusy(true);
    try {
      const result = await shaicPull();
      announce(result);
      if (result.forceRequired) setPending({ kind: "force", action: "pull", text: result.text });
      await loadAll();
    } catch (error) {
      console.error("shaic pull:", error);
      toast.error(String(error));
    } finally {
      setBusy(false);
    }
  }, [announce, loadAll]);

  const openDetail = useCallback(
    async (agent: string) => {
      try {
        setDetail(await shaicAgentDetail(agent, root));
      } catch (error) {
        console.error("shaic detail:", error);
        toast.error(String(error));
      }
    },
    [root]
  );

  const openPlan = useCallback(
    async (agent: string, scope: Scope, isMcp: boolean) => {
      try {
        setPlan(await shaicPlan(agent, scope, isMcp, root));
      } catch (error) {
        console.error("shaic plan:", error);
        toast.error(String(error));
      }
    },
    [root]
  );

  const applyPlan = useCallback(async () => {
    if (!plan) return;
    setApplying(true);
    try {
      announce(await shaicApply(plan.agent, plan.scope, plan.isMcp, root));
      setPlan(null);
      await loadAll();
      await openDetail(plan.agent);
    } catch (error) {
      console.error("shaic apply:", error);
      toast.error(String(error));
    } finally {
      setApplying(false);
    }
  }, [announce, loadAll, openDetail, plan, root]);

  const handleDeleteItem = useCallback(
    async (item: ItemView) => {
      await runOp(() => shaicRemoveItem(item.kind, item.name, root));
      setPending(null);
    },
    [root, runOp]
  );

  const handleForce = useCallback(async () => {
    if (!pending || pending.kind !== "force") return;
    const action = pending.action;
    setPending(null);
    await runOp(() => (action === "push" ? shaicPush(true) : shaicPull(true)));
  }, [pending, runOp]);

  if (loading) {
    return (
      <AppShell>
        <div className="flex h-full items-center justify-center gap-2 text-sm">
          <Loader2 className="size-4 animate-spin" />
          {t("aiConfig.loading")}
        </div>
      </AppShell>
    );
  }

  const tabs: Array<{ id: TabId; label: string }> = [
    { id: "agents", label: t("aiConfig.tabs.agents") },
    { id: "items", label: t("aiConfig.tabs.items") },
  ];

  return (
    <AppShell>
      <section className="flex h-full w-full flex-col gap-4">
        <ProjectPicker value={root} onChange={setRoot} />
        {/* Status / store card */}
        <div className="border-border bg-card text-card-foreground rounded-xl border p-5 shadow-sm">
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-3">
              <span
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium",
                  status?.exists
                    ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                    : "bg-muted text-muted-foreground"
                )}
              >
                <span
                  className={cn(
                    "size-1.5 rounded-full",
                    status?.exists ? "bg-emerald-500" : "bg-muted-foreground"
                  )}
                />
                {status?.exists ? t("aiConfig.storeExists") : t("aiConfig.storeMissing")}
              </span>

              {status?.remote ? (
                <code className="bg-muted truncate rounded px-1.5 py-0.5 font-mono text-xs">
                  {status.remote}
                </code>
              ) : (
                <span className="text-muted-foreground text-xs">{t("aiConfig.noRemote")}</span>
              )}

              <div className="ml-auto flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void handlePull()}
                  disabled={busy || !status?.exists}
                >
                  <Download className="size-4" />
                  {t("aiConfig.pull")}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void handlePush()}
                  disabled={busy || !status?.exists}
                >
                  <Upload className="size-4" />
                  {t("aiConfig.push")}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void loadAll(true)}
                  disabled={busy}
                >
                  <RefreshCw className={cn("size-4", busy && "animate-spin")} />
                </Button>
              </div>
            </div>

            <div className="border-border grid grid-cols-1 gap-2 border-t pt-4 text-xs sm:grid-cols-2">
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground">{t("aiConfig.storePath")}</span>
                <code className="truncate font-mono">{status?.storePath}</code>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground">{t("aiConfig.projectRoot")}</span>
                <code className="truncate font-mono">{status?.projectRoot}</code>
              </div>
            </div>
          </div>
        </div>

        {/* Setup wizard, shown until a store exists */}
        {!status?.exists && (
          <div className="border-border bg-card text-card-foreground rounded-xl border p-5 shadow-sm">
            <h3 className="text-sm font-semibold">{t("aiConfig.setup.title")}</h3>
            <p className="text-muted-foreground mt-1 text-xs">{t("aiConfig.setup.description")}</p>
            <div className="mt-3 flex items-center gap-2">
              <Input
                value={remoteInput}
                onChange={(e) => setRemoteInput(e.target.value)}
                placeholder="git@github.com:you/your-shaic-store.git"
                className="font-mono text-sm"
                onKeyDown={(e) => e.key === "Enter" && void handleInit()}
              />
              <Button onClick={() => void handleInit()} disabled={busy || !remoteInput.trim()}>
                {busy && <Loader2 className="size-4 animate-spin" />}
                {t("aiConfig.setup.init")}
              </Button>
            </div>
          </div>
        )}

        {/* Tabs */}
        <div className="border-border bg-card text-card-foreground flex min-h-0 flex-1 flex-col rounded-xl border shadow-sm">
          <div className="border-border flex h-11 shrink-0 items-center gap-1 border-b px-2">
            {tabs.map((tabDef) => (
              <button
                key={tabDef.id}
                type="button"
                onClick={() => setTab(tabDef.id)}
                className={cn(
                  "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                  tab === tabDef.id
                    ? "bg-primary/10 text-primary"
                    : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                )}
              >
                {tabDef.label}
              </button>
            ))}
            <div className="ml-auto flex items-center gap-1 pr-1">
              {tab === "items" && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setEditor({ mode: "new", kind: "skill" })}
                >
                  {t("aiConfig.items.add")}
                </Button>
              )}
              <HelpButton />
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-auto p-4">
            {tab === "agents" && (
              <AgentsTab
                rows={rows}
                storeExists={!!status?.exists}
                onOpenDetail={(agent) => void openDetail(agent)}
                onPlan={(agent, scope, isMcp) => void openPlan(agent, scope, isMcp)}
              />
            )}
            {tab === "items" && (
              <ItemsTab
                items={items}
                storeExists={!!status?.exists}
                onNew={(kind) => setEditor({ mode: "new", kind })}
                onEdit={(item) => setEditor({ mode: "edit", kind: item.kind, name: item.name })}
                onDelete={(item) => setPending({ kind: "deleteItem", item })}
              />
            )}
          </div>
        </div>
      </section>

      {/* Agent detail panels — the TUI dashboard's Enter drill-down */}
      {tab === "agents" && detail && (
        <DetailSheet
          detail={detail}
          onClose={() => setDetail(null)}
          onPlan={(scope, isMcp) => void openPlan(detail.agent, scope, isMcp)}
          onImport={(scope) =>
            setPending({
              kind: "import",
              agent: detail.agent,
              scope,
              label: `${detail.displayName} / ${scope}`,
            })
          }
        />
      )}

      <PlanDialog
        plan={plan}
        applying={applying}
        onClose={() => setPlan(null)}
        onApply={() => void applyPlan()}
      />

      <ItemEditorDialog
        target={editor}
        onClose={() => setEditor(null)}
        onSaved={() => void loadAll()}
      />

      {/* Confirmation dialog — the TUI's y/N prompts for write actions */}
      <ConfirmDialog
        pending={pending}
        onCancel={() => setPending(null)}
        onConfirm={() => {
          if (!pending) return;
          if (pending.kind === "deleteItem") void handleDeleteItem(pending.item);
          else if (pending.kind === "force") void handleForce();
          else if (pending.kind === "import") {
            const { agent, scope } = pending;
            setPending(null);
            void runOp(() => shaicImportScope(agent, scope, root));
          }
        }}
      />
    </AppShell>
  );
}

// ---------------------------------------------------------------------------
// Agents tab — the TUI dashboard
// ---------------------------------------------------------------------------

const AGENT_STATUSES: SyncStatus[] = ["in-sync", "drift", "unconfirmed", "error"];

function AgentsTab({
  rows,
  storeExists,
  onOpenDetail,
  onPlan,
}: {
  rows: AgentRowView[];
  storeExists: boolean;
  onOpenDetail: (agent: string) => void;
  onPlan: (agent: string, scope: Scope, isMcp: boolean) => void;
}) {
  const { t } = useAppTranslation();
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<SyncStatus | "all">("all");

  if (!storeExists) {
    return <p className="text-muted-foreground p-4 text-sm">{t("aiConfig.agents.noStore")}</p>;
  }

  const needle = query.trim().toLowerCase();
  const visible = rows.filter((row) => {
    if (statusFilter !== "all" && row.status !== statusFilter) return false;
    if (
      needle &&
      !row.name.toLowerCase().includes(needle) &&
      !row.id.toLowerCase().includes(needle)
    ) {
      return false;
    }
    return true;
  });

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("aiConfig.agents.search")}
          className="h-8 w-56 text-sm"
        />
        <FilterChip active={statusFilter === "all"} onClick={() => setStatusFilter("all")}>
          {t("aiConfig.agents.filterAll")}
        </FilterChip>
        {AGENT_STATUSES.map((status) => (
          <FilterChip
            key={status}
            active={statusFilter === status}
            onClick={() => setStatusFilter(status)}
          >
            {t(`aiConfig.status.${statusKey(status)}`)}
          </FilterChip>
        ))}
      </div>

      {visible.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t("aiConfig.agents.noMatch")}</p>
      ) : (
        <div className="flex flex-col gap-1">
          {visible.map((row) => (
            <div
              key={row.id}
              className="border-border hover:bg-accent/50 flex items-center gap-3 rounded-md border px-3 py-2"
            >
              <button
                type="button"
                onClick={() => onOpenDetail(row.id)}
                className="min-w-0 flex-1 text-left text-sm font-medium hover:underline"
              >
                {row.name}
              </button>
              <StatusBadge
                status={row.status}
                label={t(`aiConfig.status.${statusKey(row.status)}`)}
              />
              <Button variant="ghost" size="sm" onClick={() => onOpenDetail(row.id)}>
                {t("aiConfig.agents.detail")}
              </Button>
              {/* Kept for parity with the TUI: quick content/mcp plan from the row. */}
              <QuickPlanButtons row={row} onPlan={onPlan} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function statusKey(status: SyncStatus): string {
  return status;
}

/** Row-level quick actions: content diff / mcp diff for the first supported scope. */
function QuickPlanButtons({
  row,
  onPlan,
}: {
  row: AgentRowView;
  onPlan: (agent: string, scope: Scope, isMcp: boolean) => void;
}) {
  const { t } = useAppTranslation();
  const contentSub = row.subRows.find((s) => s.contentStatus !== null);
  const mcpSub = row.subRows.find((s) => s.mcpStatus !== null);
  return (
    <>
      {contentSub && (
        <Button variant="ghost" size="sm" onClick={() => onPlan(row.id, contentSub.scope, false)}>
          {t("aiConfig.agents.contentDiff")}
        </Button>
      )}
      {mcpSub && (
        <Button variant="ghost" size="sm" onClick={() => onPlan(row.id, mcpSub.scope, true)}>
          {t("aiConfig.agents.mcpDiff")}
        </Button>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Agent detail — the TUI agent-detail screen
// ---------------------------------------------------------------------------

function DetailSheet({
  detail,
  onClose,
  onPlan,
  onImport,
}: {
  detail: AgentDetailView;
  onClose: () => void;
  onPlan: (scope: Scope, isMcp: boolean) => void;
  onImport: (scope: Scope) => void;
}) {
  const { t } = useAppTranslation();
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{detail.displayName}</DialogTitle>
          <DialogDescription>{t("aiConfig.detail.description")}</DialogDescription>
        </DialogHeader>
        <div className="flex max-h-[32rem] flex-col gap-3 overflow-auto">
          {detail.scopes.map((scope) => (
            <div key={scope.scope} className="border-border rounded-lg border">
              <div className="border-border bg-muted/40 flex items-center gap-2 rounded-t-lg border-b px-3 py-2">
                <span className="text-sm font-semibold">{t(`aiConfig.scope.${scope.scope}`)}</span>
                <div className="ml-auto flex items-center gap-1.5">
                  {scope.axes.map((axis) => (
                    <StatusBadge
                      key={axis.axis}
                      status={axis.status}
                      label={`${t(`aiConfig.detail.axis.${axis.axis}`)} · ${t(
                        `aiConfig.status.${axis.status}`
                      )}`}
                    />
                  ))}
                </div>
              </div>
              <div className="divide-border flex flex-col divide-y">
                {scope.axes.map((axis) => (
                  <AxisRow
                    key={axis.axis}
                    axis={axis}
                    onPlan={(isMcp) => onPlan(scope.scope, isMcp)}
                    onImport={() => onImport(scope.scope)}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("aiConfig.close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** One axis block: path, per-kind on-disk counts, and what a sync would change. */
function AxisRow({
  axis,
  onPlan,
  onImport,
}: {
  axis: AxisView;
  onPlan: (isMcp: boolean) => void;
  onImport: () => void;
}) {
  const { t } = useAppTranslation();
  const isMcp = axis.axis === "mcp";
  const pending = axis.toWrite + axis.toDelete;

  return (
    <div className="flex flex-col gap-2 px-3 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{t(`aiConfig.detail.axis.${axis.axis}`)}</span>
        <StatusBadge status={axis.status} label={t(`aiConfig.status.${axis.status}`)} />
        <div className="ml-auto flex items-center gap-1">
          <Button variant="outline" size="sm" onClick={() => onPlan(isMcp)}>
            {isMcp ? t("aiConfig.agents.mcpDiff") : t("aiConfig.agents.contentDiff")}
          </Button>
          {/* Import pulls on-disk content into the store, which only applies to
              the content axis. */}
          {!isMcp && (
            <Button variant="ghost" size="sm" onClick={onImport}>
              {t("aiConfig.detail.import")}
            </Button>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2 text-xs">
        <span className="text-muted-foreground shrink-0">{t("aiConfig.detail.location")}</span>
        {axis.location ? (
          <code
            className="bg-muted min-w-0 flex-1 truncate rounded px-1.5 py-0.5 font-mono"
            title={axis.location}
          >
            {axis.location}
          </code>
        ) : (
          <span className="text-muted-foreground">{t("aiConfig.detail.locationUnavailable")}</span>
        )}
      </div>

      {axis.kinds.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {axis.kinds.map((count) => (
            <span
              key={count.kind}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs",
                count.onDisk > 0 ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"
              )}
              title={t("aiConfig.detail.onDisk")}
            >
              {t(`aiConfig.kind.${count.kind}`)}
              <span className="font-mono font-semibold tabular-nums">{count.onDisk}</span>
            </span>
          ))}
        </div>
      )}

      {axis.readOnly && (
        <p className="text-muted-foreground text-xs">{t("aiConfig.detail.readOnly")}</p>
      )}

      {axis.error ? (
        <p className="text-destructive text-xs">{axis.error}</p>
      ) : axis.readOnly ? null : pending > 0 ? (
        <p className="text-xs text-amber-600 dark:text-amber-400">
          {t("aiConfig.detail.pending", {
            toWrite: axis.toWrite,
            toDelete: axis.toDelete,
          })}
        </p>
      ) : (
        <p className="text-muted-foreground text-xs">{t("aiConfig.detail.nothingPending")}</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Items tab — the TUI item browser
// ---------------------------------------------------------------------------

function ItemsTab({
  items,
  storeExists,
  onNew,
  onEdit,
  onDelete,
}: {
  items: ItemView[];
  storeExists: boolean;
  onNew: (kind: ItemKind) => void;
  onEdit: (item: ItemView) => void;
  onDelete: (item: ItemView) => void;
}) {
  const { t } = useAppTranslation();
  const [filter, setFilter] = useState<ItemKind | "all">("all");

  if (!storeExists) {
    return <p className="text-muted-foreground p-4 text-sm">{t("aiConfig.items.noStore")}</p>;
  }

  const visible = filter === "all" ? items : items.filter((i) => i.kind === filter);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <FilterChip active={filter === "all"} onClick={() => setFilter("all")}>
          {t("aiConfig.items.all")}
        </FilterChip>
        {ITEM_KINDS.map((kind) => (
          <FilterChip key={kind} active={filter === kind} onClick={() => setFilter(kind)}>
            {t(`aiConfig.kind.${kind}`)}
          </FilterChip>
        ))}
        <div className="ml-auto flex items-center gap-1">
          {ITEM_KINDS.map((kind) => (
            <Button key={kind} variant="ghost" size="sm" onClick={() => onNew(kind)}>
              + {t(`aiConfig.kind.${kind}`)}
            </Button>
          ))}
        </div>
      </div>

      {visible.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t("aiConfig.items.empty")}</p>
      ) : (
        <div className="flex flex-col gap-1">
          {visible.map((item) => (
            <div
              key={`${item.kind}:${item.name}`}
              className="border-border flex items-center gap-3 rounded-md border px-3 py-2"
            >
              <span className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 text-[10px] font-medium uppercase">
                {t(`aiConfig.kind.${item.kind}`)}
              </span>
              <span className="truncate font-mono text-sm font-medium">{item.name}</span>
              <span className="text-muted-foreground truncate text-xs">{item.description}</span>
              <div className="ml-auto flex items-center gap-1">
                <Button variant="ghost" size="sm" onClick={() => onEdit(item)}>
                  {t("aiConfig.items.edit")}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive"
                  onClick={() => onDelete(item)}
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-full px-3 py-1 text-xs font-medium transition-colors",
        active
          ? "bg-primary/10 text-primary"
          : "bg-muted text-muted-foreground hover:bg-accent hover:text-accent-foreground"
      )}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Confirmation dialog
// ---------------------------------------------------------------------------

function ConfirmDialog({
  pending,
  onCancel,
  onConfirm,
}: {
  pending: Pending | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useAppTranslation();
  if (!pending) return null;

  const { title, description, confirmLabel, danger } = describePending(pending, t);

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {danger ? (
              <AlertTriangle className="text-destructive size-4" />
            ) : (
              <Check className="size-4" />
            )}
            {title}
          </DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            <X className="size-4" />
            {t("aiConfig.cancel")}
          </Button>
          <Button variant={danger ? "destructive" : "default"} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function describePending(
  pending: Pending,
  t: (key: string, vars?: Record<string, unknown>) => string
): { title: string; description: string; confirmLabel: string; danger: boolean } {
  switch (pending.kind) {
    case "deleteItem":
      return {
        title: t("aiConfig.confirm.deleteTitle"),
        description: t("aiConfig.confirm.deleteBody", {
          kind: pending.item.kind,
          name: pending.item.name,
        }),
        confirmLabel: t("aiConfig.confirm.delete"),
        danger: true,
      };
    case "import":
      return {
        title: t("aiConfig.confirm.importTitle"),
        description: t("aiConfig.confirm.importBody", { label: pending.label }),
        confirmLabel: t("aiConfig.confirm.import"),
        danger: false,
      };
    case "force":
      return {
        title: t("aiConfig.confirm.forceTitle"),
        description: pending.text,
        confirmLabel: t("aiConfig.confirm.force"),
        danger: true,
      };
  }
}
