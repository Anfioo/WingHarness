// Adapted from moin (MIT), https://github.com/exxvius/moin at 79e7587.
// See `src-tauri/moin-core/UPSTREAM.md` for the porting record.

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Download, LoaderCircle, Pause, Play, RotateCcw, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import {
  isMoinError,
  moinAddDownload,
  moinCancelDownload,
  moinDeleteDownload,
  moinErrorKey,
  moinForgetDownload,
  moinListCategories,
  moinPauseDownload,
  moinRemoveDownload,
  moinResumeDownload,
  moinRetryDownload,
  type MoinCategory,
  type MoinTask,
  type MoinTaskProgress,
  type MoinTaskStatus,
} from "@/commands";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAppTranslation } from "@/hooks/use-app-translation";
import {
  formatBytes,
  formatDate,
  formatEta,
  formatPercent,
  formatSpeed,
  percent,
} from "@/lib/moin/format";

const STATUS_KEYS: Record<MoinTaskStatus, string> = {
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

const STATUS_STYLES: Record<MoinTaskStatus, string> = {
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

type Filter = "all" | "active" | "completed" | "paused" | "failed" | "stalled" | "archived";

const FILTERS: Filter[] = ["all", "active", "completed", "paused", "failed", "stalled", "archived"];

const ACTIVE_STATUSES: MoinTaskStatus[] = ["queued", "connecting", "downloading", "moving"];

const isActive = (status: MoinTaskStatus) => ACTIVE_STATUSES.includes(status);

function matchesFilter(task: MoinTask, filter: Filter): boolean {
  switch (filter) {
    case "all":
      return !task.archived;
    case "active":
      return isActive(task.status) && !task.archived;
    case "archived":
      return task.archived;
    default:
      return task.status === filter && !task.archived;
  }
}

export default function DownloadsTab({
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
  const [filter, setFilter] = useState<Filter>("all");
  const [url, setUrl] = useState("");
  const [filename, setFilename] = useState("");
  const [headersText, setHeadersText] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [categories, setCategories] = useState<MoinCategory[]>([]);
  const [adding, setAdding] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

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

  const visibleTasks = useMemo(
    () => tasks.filter((task) => matchesFilter(task, filter)),
    [tasks, filter]
  );

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
        category: categoryId || null,
        filename: filename.trim() || null,
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
      });
      setUrl("");
      setFilename("");
      setHeadersText("");
      toast.success(t("moin.add.success"));
      await reload();
    } catch (failure) {
      setFormError(isMoinError(failure) ? moinErrorKey(failure.code) : "moin.error.internal");
    } finally {
      setAdding(false);
    }
  };

  const runAction = async (id: string, operation: () => Promise<void>) => {
    setBusyId(id);
    setActionError(null);
    try {
      await operation();
      await reload();
    } catch (failure) {
      setActionError(isMoinError(failure) ? moinErrorKey(failure.code) : "moin.error.internal");
    } finally {
      setBusyId(null);
    }
  };

  const confirmThen = (messageKey: string, operation: () => Promise<void>) => {
    if (!window.confirm(t(messageKey))) return;
    return operation();
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
              <option value="">{t("moin.add.autoCategory")}</option>
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
          <div
            className="flex flex-wrap items-center gap-1"
            role="group"
            aria-label={t("moin.task.status")}
          >
            {FILTERS.map((value) => (
              <Button
                key={value}
                type="button"
                size="sm"
                variant={filter === value ? "secondary" : "ghost"}
                onClick={() => setFilter(value)}
              >
                {t(`moin.filter.${value}`)}
              </Button>
            ))}
          </div>
        </div>

        {error && (
          <div
            role="alert"
            className="border-destructive/40 bg-destructive/5 text-destructive rounded-lg border px-3 py-2 text-sm"
          >
            {t(error)}
          </div>
        )}
        {actionError && (
          <div
            role="alert"
            className="border-destructive/40 bg-destructive/5 text-destructive rounded-lg border px-3 py-2 text-sm"
          >
            {t(actionError)}
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
                onPause={() => void runAction(task.id, () => moinPauseDownload(task.id))}
                onResume={() => void runAction(task.id, () => moinResumeDownload(task.id))}
                onRetry={() => void runAction(task.id, () => moinRetryDownload(task.id))}
                onCancel={() => void runAction(task.id, () => moinCancelDownload(task.id))}
                onRemove={() =>
                  void confirmThen("moin.action.removeConfirm", () =>
                    runAction(task.id, () => moinRemoveDownload(task.id))
                  )
                }
                onDelete={() =>
                  void confirmThen("moin.action.deleteConfirm", () =>
                    runAction(task.id, () => moinDeleteDownload(task.id))
                  )
                }
                onForget={() =>
                  void confirmThen("moin.action.forgetConfirm", () =>
                    runAction(task.id, () => moinForgetDownload(task.id))
                  )
                }
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
  onPause,
  onResume,
  onRetry,
  onCancel,
  onRemove,
  onDelete,
  onForget,
}: {
  task: MoinTask;
  progress?: MoinTaskProgress;
  busy: boolean;
  onPause: () => void;
  onResume: () => void;
  onRetry: () => void;
  onCancel: () => void;
  onRemove: () => void;
  onDelete: () => void;
  onForget: () => void;
}) {
  const { t } = useAppTranslation();
  const received = progress?.received ?? task.received;
  const total = progress?.total ?? task.total;
  const speed = progress?.speed ?? 0;
  const completion = percent(received, total);
  const canPause =
    task.status === "queued" || task.status === "connecting" || task.status === "downloading";
  const canResume = task.status === "paused";
  const canRetry =
    task.status === "failed" || task.status === "stalled" || task.status === "canceled";
  const idle = !isActive(task.status);

  return (
    <article className="bg-card min-w-0 rounded-lg border p-3 sm:p-4">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="min-w-0 truncate font-medium" title={task.filename}>
              {task.filename}
            </h3>
            <span
              className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[task.status]}`}
            >
              {t(STATUS_KEYS[task.status])}
            </span>
            {task.archived && (
              <span className="bg-muted rounded-full px-2 py-0.5 text-xs">
                {t("moin.filter.archived")}
              </span>
            )}
          </div>
          <p className="text-muted-foreground mt-1 truncate text-xs" title={task.url}>
            {task.url}
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-1">
          {canPause && (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t("moin.action.pauseAria", { filename: task.filename })}
              disabled={busy}
              onClick={onPause}
            >
              <Pause />
            </Button>
          )}
          {canResume && (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t("moin.action.resumeAria", { filename: task.filename })}
              disabled={busy}
              onClick={onResume}
            >
              <Play />
            </Button>
          )}
          {canRetry && (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t("moin.action.retry")}
              disabled={busy}
              onClick={onRetry}
            >
              <RotateCcw />
            </Button>
          )}
          {(canPause || canResume) && (
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
          {idle && !task.archived && (
            <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onRemove}>
              {t("moin.action.remove")}
            </Button>
          )}
          {idle && (
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
              {formatBytes(received)} / {total === null ? "—" : formatBytes(total)}
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
          {t("moin.task.path")}: {task.dest}
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
