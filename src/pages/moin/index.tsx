import { useEffect, useState, type FormEvent } from "react";
import {
  Archive,
  Download,
  FolderDown,
  LoaderCircle,
  Pause,
  Play,
  RefreshCw,
  Settings2,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import {
  moinAddDownload,
  moinCancelDownload,
  moinCreateCategory,
  moinDeleteCategory,
  moinDeleteDownload,
  moinForgetDownload,
  moinGetSettings,
  moinListCategories,
  moinPatchSettings,
  moinPauseDownload,
  moinReorderCategories,
  moinRemoveDownload,
  moinResumeDownload,
  moinUpdateCategory,
  type MoinCategory,
  type MoinSettings,
  type MoinTask,
  type MoinTaskProgress,
  type MoinTaskStatus,
} from "@/commands";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { useMoinTasks } from "@/hooks/use-moin-tasks";
import {
  formatBytes,
  formatDate,
  formatEta,
  formatPercent,
  formatSpeed,
  percent,
} from "@/lib/moin/format";

const statusKeys: Record<MoinTaskStatus, string> = {
  queued: "moin.status.queued",
  connecting: "moin.status.connecting",
  downloading: "moin.status.downloading",
  paused: "moin.status.paused",
  moving: "moin.status.moving",
  completed: "moin.status.completed",
  failed: "moin.status.failed",
  stalled: "moin.status.stalled",
  canceled: "moin.status.canceled",
};

const statusStyles: Record<MoinTaskStatus, string> = {
  queued: "bg-muted text-muted-foreground",
  connecting: "bg-primary/10 text-primary",
  downloading: "bg-primary/10 text-primary",
  paused: "bg-muted text-muted-foreground",
  moving: "bg-primary/10 text-primary",
  completed: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  failed: "bg-destructive/10 text-destructive",
  stalled: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  canceled: "bg-muted text-muted-foreground",
};

const isActive = (status: MoinTaskStatus) =>
  status === "queued" || status === "connecting" || status === "downloading" || status === "moving";

const canArchive = (status: MoinTaskStatus) =>
  status === "paused" ||
  status === "completed" ||
  status === "failed" ||
  status === "stalled" ||
  status === "canceled";

export default function MoinPage() {
  const { t } = useAppTranslation();
  const [tab, setTab] = useState("downloads");
  const downloads = useMoinTasks();

  return (
    <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col gap-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold">{t("moin.title")}</h1>
          <p className="text-muted-foreground text-sm">{t("moin.subtitle")}</p>
        </div>
        {tab === "downloads" && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={downloads.loading}
            onClick={() => void downloads.reload()}
          >
            <RefreshCw className={downloads.loading ? "animate-spin" : ""} />
            {downloads.loading ? t("moin.common.refreshing") : t("moin.common.refresh")}
          </Button>
        )}
      </header>

      <Tabs value={tab} onValueChange={setTab} className="min-h-0 flex-1">
        <TabsList>
          <TabsTrigger value="downloads">
            <Download />
            {t("moin.tab.downloads")}
          </TabsTrigger>
          <TabsTrigger value="categories">
            <FolderDown />
            {t("moin.tab.categories")}
          </TabsTrigger>
          <TabsTrigger value="settings">
            <Settings2 />
            {t("moin.tab.settings")}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="downloads" className="mt-4">
          <DownloadsPanel
            tasks={downloads.tasks}
            progress={downloads.progress}
            loading={downloads.loading}
            error={downloads.error}
            reload={downloads.reload}
          />
        </TabsContent>
        <TabsContent value="categories" className="mt-4">
          <CategoriesPanel />
        </TabsContent>
        <TabsContent value="settings" className="mt-4">
          <SettingsPanel active={tab === "settings"} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function DownloadsPanel({
  tasks,
  progress,
  loading,
  error,
  reload,
}: {
  tasks: MoinTask[];
  progress: Record<string, MoinTaskProgress>;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
}) {
  const { t } = useAppTranslation();
  const [showArchived, setShowArchived] = useState(false);
  const [url, setUrl] = useState("");
  const [filename, setFilename] = useState("");
  const [headersText, setHeadersText] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [categories, setCategories] = useState<MoinCategory[]>([]);
  const [adding, setAdding] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [actionError, setActionError] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const visibleTasks = tasks.filter((task) => showArchived || !task.archived);

  useEffect(() => {
    let cancelled = false;
    void moinListCategories()
      .then((items) => {
        if (!cancelled) setCategories(items);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const addDownload = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFormError(null);
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url.trim());
    } catch {
      setFormError("moin.add.invalidUrl");
      return;
    }
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      setFormError("moin.add.invalidUrl");
      return;
    }

    const headers: Record<string, string> = {};
    for (const line of headersText
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean)) {
      const separator = line.indexOf(":");
      if (separator < 1 || !line.slice(0, separator).trim() || !line.slice(separator + 1).trim()) {
        setFormError("moin.add.invalidHeaders");
        return;
      }
      headers[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
    }

    setAdding(true);
    try {
      await moinAddDownload({
        url: parsedUrl.toString(),
        ...(categoryId ? { category: categoryId } : {}),
        ...(filename.trim() ? { filename: filename.trim() } : {}),
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
      });
      setUrl("");
      setFilename("");
      setHeadersText("");
      toast.success(t("moin.add.success"));
      await reload();
    } catch {
      setFormError("moin.common.operationFailed");
    } finally {
      setAdding(false);
    }
  };

  const runTaskAction = async (
    task: MoinTask,
    action: "archive" | "delete" | "forget" | "cancel",
    operation: () => Promise<void>
  ) => {
    if (action !== "cancel") {
      const key = action;
      const confirmed = window.confirm(
        `${t(`moin.action.${key}ConfirmTitle`)}\n\n${t(`moin.action.${key}ConfirmDescription`)}`
      );
      if (!confirmed) return;
    }

    setBusyId(task.id);
    setActionError(false);
    try {
      await operation();
      await reload();
    } catch {
      setActionError(true);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <form onSubmit={(event) => void addDownload(event)} className="bg-card rounded-lg border p-4">
        <div className="mb-3 flex items-center gap-2 font-medium">
          <Download className="text-primary size-4" />
          <h2>{t("moin.add.title")}</h2>
        </div>
        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(12rem,0.55fr)]">
          <label className="grid gap-1.5 text-sm md:col-span-2">
            <span>{t("moin.add.url")}</span>
            <Input
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder={t("moin.add.urlPlaceholder")}
              autoComplete="url"
              disabled={adding}
            />
          </label>
          <label className="grid gap-1.5 text-sm">
            <span>{t("moin.add.category")}</span>
            <select
              value={categoryId}
              onChange={(event) => setCategoryId(event.target.value)}
              disabled={adding}
              className="border-input bg-background h-9 rounded-md border px-3 text-sm"
            >
              <option value="">{t("moin.add.categoryAuto")}</option>
              {categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1.5 text-sm">
            <span>{t("moin.add.filename")}</span>
            <Input
              value={filename}
              onChange={(event) => setFilename(event.target.value)}
              placeholder={t("moin.add.filenamePlaceholder")}
              disabled={adding}
            />
          </label>
          <label className="grid gap-1.5 text-sm">
            <span>{t("moin.add.headers")}</span>
            <textarea
              value={headersText}
              onChange={(event) => setHeadersText(event.target.value)}
              placeholder={t("moin.add.headersPlaceholder")}
              disabled={adding}
              rows={2}
              className="border-input bg-background placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 min-h-9 w-full resize-y rounded-md border px-3 py-2 text-sm shadow-xs outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50"
            />
          </label>
        </div>
        {formError && (
          <p role="alert" className="text-destructive mt-3 text-sm">
            {t(formError)}
          </p>
        )}
        <div className="mt-3 flex justify-end">
          <Button type="submit" disabled={adding}>
            {adding ? <LoaderCircle className="animate-spin" /> : <Download />}
            {adding ? t("moin.add.adding") : t("moin.add.submit")}
          </Button>
        </div>
      </form>

      <section className="flex min-w-0 flex-col gap-3" aria-label={t("moin.tab.downloads")}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-muted-foreground text-sm">
            {t("moin.task.count", { count: visibleTasks.length })}
          </p>
          <label className="text-muted-foreground flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(event) => setShowArchived(event.target.checked)}
              className="accent-primary size-4"
            />
            {t("moin.common.showArchived")}
          </label>
        </div>

        {error && (
          <div
            role="alert"
            className="border-destructive/40 bg-destructive/5 text-destructive rounded-lg border px-3 py-2 text-sm"
          >
            {t("moin.error.load")}
          </div>
        )}
        {actionError && (
          <div
            role="alert"
            className="border-destructive/40 bg-destructive/5 text-destructive rounded-lg border px-3 py-2 text-sm"
          >
            {t("moin.common.operationFailed")}
          </div>
        )}

        {loading && tasks.length === 0 ? (
          <div className="text-muted-foreground flex items-center justify-center gap-2 rounded-lg border py-12 text-sm">
            <LoaderCircle className="size-4 animate-spin" />
            {t("moin.common.loading")}
          </div>
        ) : visibleTasks.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed px-4 py-12 text-center">
            <Download className="text-muted-foreground size-8" />
            <p className="font-medium">{t("moin.common.empty")}</p>
            <p className="text-muted-foreground text-sm">{t("moin.add.title")}</p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {visibleTasks.map((task) => (
              <TaskCard
                key={task.id}
                task={task}
                progress={progress[task.id]}
                busy={busyId === task.id}
                reload={reload}
                onCancel={() =>
                  void runTaskAction(task, "cancel", () => moinCancelDownload({ id: task.id }))
                }
                onArchive={() =>
                  void runTaskAction(task, "archive", () => moinRemoveDownload({ id: task.id }))
                }
                onDelete={() =>
                  void runTaskAction(task, "delete", () => moinDeleteDownload({ id: task.id }))
                }
                onForget={() =>
                  void runTaskAction(task, "forget", () => moinForgetDownload({ id: task.id }))
                }
                onStartAction={() => setBusyId(task.id)}
                onFinishAction={() => setBusyId(null)}
                onActionError={() => setActionError(true)}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function TaskCard({
  task,
  progress,
  busy,
  reload,
  onCancel,
  onArchive,
  onDelete,
  onForget,
  onStartAction,
  onFinishAction,
  onActionError,
}: {
  task: MoinTask;
  progress?: MoinTaskProgress;
  busy: boolean;
  reload: () => Promise<void>;
  onCancel: () => void;
  onArchive: () => void;
  onDelete: () => void;
  onForget: () => void;
  onStartAction: () => void;
  onFinishAction: () => void;
  onActionError: () => void;
}) {
  const { t } = useAppTranslation();
  const received = progress?.received ?? task.received;
  const total = progress?.total ?? task.total;
  const speed = progress?.speed ?? 0;
  const completion = percent(received, total);
  const safeToRemove = !isActive(task.status);
  const showPause =
    task.status === "queued" || task.status === "connecting" || task.status === "downloading";

  const invokeAction = async (action: () => Promise<void>) => {
    onStartAction();
    try {
      await action();
      await reload();
    } catch {
      onActionError();
    } finally {
      onFinishAction();
    }
  };

  return (
    <article className="bg-card min-w-0 rounded-lg border p-3 sm:p-4">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="min-w-0 truncate font-medium" title={task.filename}>
              {task.filename}
            </h3>
            <span
              className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusStyles[task.status]}`}
            >
              {t(statusKeys[task.status])}
            </span>
            {task.archived && (
              <span className="bg-muted rounded-full px-2 py-0.5 text-xs">
                {t("moin.task.archived")}
              </span>
            )}
          </div>
          <p className="text-muted-foreground mt-1 truncate text-xs" title={task.url}>
            {task.url}
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-1">
          {showPause && (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t("moin.action.pauseAria", { filename: task.filename })}
              disabled={busy}
              onClick={() => void invokeAction(() => moinPauseDownload({ id: task.id }))}
            >
              <Pause />
            </Button>
          )}
          {task.status === "paused" && (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t("moin.action.resumeAria", { filename: task.filename })}
              disabled={busy}
              onClick={() => void invokeAction(() => moinResumeDownload({ id: task.id }))}
            >
              <Play />
            </Button>
          )}
          {(showPause || task.status === "paused") && (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t("moin.action.cancelAria", { filename: task.filename })}
              disabled={busy}
              onClick={onCancel}
            >
              <X />
            </Button>
          )}
          {safeToRemove && canArchive(task.status) && !task.archived && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={t("moin.action.archive")}
              disabled={busy}
              onClick={onArchive}
            >
              <Archive />
              <span className="hidden sm:inline">{t("moin.action.archive")}</span>
            </Button>
          )}
          {safeToRemove && (
            <>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={t("moin.action.delete")}
                disabled={busy}
                onClick={onDelete}
              >
                <Trash2 />
                <span className="hidden sm:inline">{t("moin.action.delete")}</span>
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={t("moin.action.forget")}
                disabled={busy}
                onClick={onForget}
              >
                <X />
              </Button>
            </>
          )}
        </div>
      </div>

      <div className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
        <div className="min-w-0">
          <div
            role="progressbar"
            aria-label={t("moin.task.progress")}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={completion === null ? undefined : Math.round(completion)}
            className="bg-muted h-2 overflow-hidden rounded-full"
          >
            <div
              className={`bg-primary h-full rounded-full transition-[width] ${completion === null ? "w-1/3 animate-pulse" : ""}`}
              style={completion === null ? undefined : { width: `${completion}%` }}
            />
          </div>
          <div className="text-muted-foreground mt-1 flex flex-wrap justify-between gap-x-3 text-xs">
            <span>
              {formatBytes(received)} /{" "}
              {total === null ? t("moin.task.unknownSize") : formatBytes(total)}
            </span>
            {completion !== null && <span>{formatPercent(completion)}</span>}
          </div>
        </div>
        <div className="text-muted-foreground flex flex-wrap gap-x-3 text-xs sm:justify-end">
          {(task.status === "downloading" || task.status === "connecting") && (
            <span>
              {t("moin.task.speed")}: {formatSpeed(speed)}
            </span>
          )}
          {task.status === "downloading" && (
            <span>
              {t("moin.task.eta")}:{" "}
              {formatEta(total === null ? null : Math.max(0, total - received), speed)}
            </span>
          )}
          <span>
            {t("moin.task.addedAt")}: {formatDate(task.created_at)}
          </span>
        </div>
      </div>

      <div className="text-muted-foreground mt-2 flex min-w-0 flex-wrap gap-x-4 gap-y-1 text-xs">
        <span className="min-w-0 truncate" title={task.dest}>
          {t("moin.task.destination")}: {task.dest}
        </span>
        {task.backend && (
          <span>
            {t("moin.task.backend")}: {task.backend}
          </span>
        )}
        {task.error && (
          <span className="text-destructive basis-full break-words">
            {t("moin.task.error")}: {task.error}
          </span>
        )}
      </div>
    </article>
  );
}

function CategoriesPanel() {
  const { t } = useAppTranslation();
  const [categories, setCategories] = useState<MoinCategory[]>([]);
  const [editing, setEditing] = useState<MoinCategory | null>(null);
  const [name, setName] = useState("");
  const [extensions, setExtensions] = useState("");
  const [saveDir, setSaveDir] = useState("");
  const [color, setColor] = useState("#378ADD");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);

  const reload = async () => {
    setLoading(true);
    try {
      setCategories(await moinListCategories());
      setError(false);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void reload();
  }, []);

  const startCreate = () => {
    setEditing(null);
    setName("");
    setExtensions("");
    setSaveDir("");
    setColor("#378ADD");
  };

  const startEdit = (category: MoinCategory) => {
    setEditing(category);
    setName(category.name);
    setExtensions(
      category.triggers
        .filter((trigger) => trigger.type === "extension")
        .flatMap((trigger) => trigger.exts)
        .join(", ")
    );
    setSaveDir(category.save_dir ?? "");
    setColor(category.color || "#378ADD");
  };

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const exts = extensions
      .split(",")
      .map((value) => value.trim().replace(/^\./, "").toLowerCase())
      .filter(Boolean);
    const category: MoinCategory = {
      ...(editing ?? ({} as MoinCategory)),
      id: editing?.id ?? crypto.randomUUID(),
      name: name.trim(),
      color,
      icon: editing?.icon ?? null,
      hidden_from_all: editing?.hidden_from_all ?? false,
      save_dir: saveDir.trim() || null,
      incomplete_dir: editing?.incomplete_dir ?? null,
      sources: editing?.sources ?? [],
      triggers: [
        ...(editing?.triggers.filter((trigger) => trigger.type !== "extension") ?? []),
        ...(exts.length > 0 ? [{ type: "extension" as const, exts }] : []),
      ],
      order: editing?.order ?? categories.length,
    };
    setSaving(true);
    setError(false);
    try {
      const updated = editing
        ? await moinUpdateCategory({ category })
        : await moinCreateCategory({ category });
      setCategories(updated);
      setEditing(null);
      setName("");
      setExtensions("");
      setSaveDir("");
      toast.success(t("moin.categories.saved"));
    } catch {
      setError(true);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (category: MoinCategory) => {
    if (!window.confirm(t("moin.categories.deleteConfirm", { name: category.name }))) return;
    setSaving(true);
    try {
      setCategories(await moinDeleteCategory({ id: category.id }));
      if (editing?.id === category.id) startCreate();
    } catch {
      setError(true);
    } finally {
      setSaving(false);
    }
  };

  const move = async (category: MoinCategory, direction: -1 | 1) => {
    const index = categories.findIndex((item) => item.id === category.id);
    const nextIndex = index + direction;
    if (index < 0 || nextIndex < 0 || nextIndex >= categories.length) return;
    const ids = categories.map((item) => item.id);
    [ids[index], ids[nextIndex]] = [ids[nextIndex], ids[index]];
    try {
      setCategories(await moinReorderCategories({ ids }));
    } catch {
      setError(true);
    }
  };

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(20rem,0.7fr)]">
      <section className="flex min-w-0 flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="font-medium">{t("moin.categories.title")}</h2>
          <Button type="button" size="sm" onClick={startCreate}>
            {t("moin.categories.add")}
          </Button>
        </div>
        {error && (
          <p role="alert" className="text-destructive text-sm">
            {t("moin.categories.failed")}
          </p>
        )}
        {loading ? (
          <div className="text-muted-foreground flex items-center justify-center gap-2 rounded-lg border py-10 text-sm">
            <LoaderCircle className="size-4 animate-spin" />
            {t("moin.common.loading")}
          </div>
        ) : categories.length === 0 ? (
          <div className="flex min-h-40 flex-col items-center justify-center gap-2 rounded-lg border border-dashed p-5 text-center">
            <FolderDown className="text-muted-foreground size-7" />
            <p className="font-medium">{t("moin.categories.emptyTitle")}</p>
            <p className="text-muted-foreground text-sm">{t("moin.categories.emptyDescription")}</p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {categories.map((category, index) => (
              <article
                key={category.id}
                className="bg-card flex min-w-0 items-center gap-3 rounded-lg border p-3"
              >
                <span
                  className="size-3 shrink-0 rounded-full"
                  style={{ backgroundColor: category.color || "var(--primary)" }}
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{category.name}</p>
                  <p className="text-muted-foreground truncate text-xs">
                    {category.triggers
                      .map((trigger) =>
                        trigger.type === "extension"
                          ? trigger.exts.map((ext) => `.${ext}`).join(", ")
                          : trigger.type
                      )
                      .filter(Boolean)
                      .join(" · ") || t("moin.categories.noRules")}
                  </p>
                  {category.save_dir && (
                    <p className="text-muted-foreground truncate text-xs">{category.save_dir}</p>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={t("moin.categories.moveUp")}
                    disabled={index === 0 || saving}
                    onClick={() => void move(category, -1)}
                  >
                    ↑
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={t("moin.categories.moveDown")}
                    disabled={index === categories.length - 1 || saving}
                    onClick={() => void move(category, 1)}
                  >
                    ↓
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={saving}
                    onClick={() => startEdit(category)}
                  >
                    {t("moin.categories.edit")}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={saving}
                    onClick={() => void remove(category)}
                  >
                    {t("moin.categories.delete")}
                  </Button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
      <form onSubmit={(event) => void save(event)} className="bg-card h-fit rounded-lg border p-4">
        <h2 className="mb-4 font-medium">
          {t(editing ? "moin.categories.editTitle" : "moin.categories.createTitle")}
        </h2>
        <div className="grid gap-3">
          <label className="grid gap-1.5 text-sm">
            <span>{t("moin.categories.name")}</span>
            <Input
              required
              maxLength={128}
              value={name}
              onChange={(event) => setName(event.target.value)}
              disabled={saving}
            />
          </label>
          <label className="grid gap-1.5 text-sm">
            <span>{t("moin.categories.extensions")}</span>
            <Input
              value={extensions}
              onChange={(event) => setExtensions(event.target.value)}
              placeholder={t("moin.categories.extensionsPlaceholder")}
              disabled={saving}
            />
          </label>
          <label className="grid gap-1.5 text-sm">
            <span>{t("moin.categories.directory")}</span>
            <Input
              value={saveDir}
              onChange={(event) => setSaveDir(event.target.value)}
              placeholder={t("moin.categories.directoryPlaceholder")}
              disabled={saving}
            />
          </label>
          <label className="grid gap-1.5 text-sm">
            <span>{t("moin.categories.color")}</span>
            <input
              type="color"
              value={color}
              onChange={(event) => setColor(event.target.value)}
              className="border-input bg-background h-9 w-full rounded-md border p-1"
              disabled={saving}
            />
          </label>
        </div>
        {error && (
          <p role="alert" className="text-destructive mt-3 text-sm">
            {t("moin.categories.failed")}
          </p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          {editing && (
            <Button type="button" variant="ghost" disabled={saving} onClick={startCreate}>
              {t("moin.common.cancel")}
            </Button>
          )}
          <Button type="submit" disabled={saving || !name.trim()}>
            {saving ? t("moin.common.saving") : t("moin.common.save")}
          </Button>
        </div>
      </form>
    </div>
  );
}

interface SettingsDraft {
  maxConcurrent: string;
  connections: string;
  downloadDir: string;
  addPaused: boolean;
}

const toDraft = (settings: MoinSettings): SettingsDraft => ({
  maxConcurrent: String(settings.max_concurrent),
  connections: String(settings.connections),
  downloadDir: settings.download_dir ?? "",
  addPaused: settings.add_paused,
});

function SettingsPanel({ active }: { active: boolean }) {
  const { t } = useAppTranslation();
  const [settings, setSettings] = useState<MoinSettings | null>(null);
  const [draft, setDraft] = useState<SettingsDraft | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [saveError, setSaveError] = useState<"invalid" | "save" | null>(null);

  useEffect(() => {
    if (!active || loaded) return;
    let cancelled = false;
    void moinGetSettings()
      .then((result) => {
        if (cancelled) return;
        setSettings(result);
        setDraft(toDraft(result));
        setLoadError(false);
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      })
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [active, loaded]);

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!draft) return;
    const maxConcurrent = Number(draft.maxConcurrent);
    const connections = Number(draft.connections);
    if (
      !draft.maxConcurrent.trim() ||
      !draft.connections.trim() ||
      !Number.isInteger(maxConcurrent) ||
      maxConcurrent < 0 ||
      !Number.isInteger(connections) ||
      connections < 1
    ) {
      setSaveError("invalid");
      return;
    }

    setSaving(true);
    setSaveError(null);
    try {
      const updated = await moinPatchSettings({
        patch: {
          max_concurrent: maxConcurrent,
          connections,
          download_dir: draft.downloadDir.trim() || null,
          add_paused: draft.addPaused,
        },
      });
      setSettings(updated);
      setDraft(toDraft(updated));
      toast.success(t("moin.settings.saveSuccess"));
    } catch {
      setSaveError("save");
    } finally {
      setSaving(false);
    }
  };

  if (!active) return null;

  if (!loaded) {
    return (
      <div className="text-muted-foreground flex items-center justify-center gap-2 rounded-lg border py-12 text-sm">
        <LoaderCircle className="size-4 animate-spin" />
        {t("moin.common.loading")}
      </div>
    );
  }

  if (loadError || !settings || !draft) {
    return (
      <div role="alert" className="flex flex-col items-start gap-3 rounded-lg border p-4">
        <p className="text-destructive text-sm">{t("moin.settings.loadFailed")}</p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            setLoadError(false);
            setLoaded(false);
          }}
        >
          {t("moin.common.retry")}
        </Button>
      </div>
    );
  }

  return (
    <form
      onSubmit={(event) => void save(event)}
      className="bg-card max-w-3xl rounded-lg border p-4 sm:p-5"
    >
      <div className="mb-5">
        <h2 className="font-semibold">{t("moin.settings.title")}</h2>
        <p className="text-muted-foreground mt-1 text-sm">{t("moin.settings.description")}</p>
      </div>
      <div className="grid gap-5">
        <label className="grid gap-1.5 text-sm sm:grid-cols-[minmax(12rem,0.7fr)_minmax(12rem,1fr)] sm:items-center">
          <span>{t("moin.settings.maxConcurrent")}</span>
          <Input
            type="number"
            min={0}
            step={1}
            required
            value={draft.maxConcurrent}
            onChange={(event) => setDraft({ ...draft, maxConcurrent: event.target.value })}
            disabled={saving}
          />
          <span className="text-muted-foreground text-xs sm:col-start-2">
            {t("moin.settings.maxConcurrentHint")}
          </span>
        </label>
        <label className="grid gap-1.5 text-sm sm:grid-cols-[minmax(12rem,0.7fr)_minmax(12rem,1fr)] sm:items-center">
          <span>{t("moin.settings.connections")}</span>
          <Input
            type="number"
            min={1}
            step={1}
            required
            value={draft.connections}
            onChange={(event) => setDraft({ ...draft, connections: event.target.value })}
            disabled={saving}
          />
        </label>
        <label className="grid gap-1.5 text-sm sm:grid-cols-[minmax(12rem,0.7fr)_minmax(12rem,1fr)] sm:items-center">
          <span>{t("moin.settings.downloadDir")}</span>
          <Input
            value={draft.downloadDir}
            onChange={(event) => setDraft({ ...draft, downloadDir: event.target.value })}
            placeholder={t("moin.settings.downloadDirPlaceholder")}
            disabled={saving}
          />
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={draft.addPaused}
            onChange={(event) => setDraft({ ...draft, addPaused: event.target.checked })}
            className="accent-primary size-4"
            disabled={saving}
          />
          {t("moin.settings.addPaused")}
        </label>
      </div>
      {saveError && (
        <p role="alert" className="text-destructive mt-4 text-sm">
          {t(saveError === "invalid" ? "moin.settings.invalidNumbers" : "moin.settings.saveFailed")}
        </p>
      )}
      <div className="mt-5 flex justify-end">
        <Button type="submit" disabled={saving}>
          {saving ? <LoaderCircle className="animate-spin" /> : null}
          {saving ? t("moin.common.saving") : t("moin.common.save")}
        </Button>
      </div>
    </form>
  );
}
