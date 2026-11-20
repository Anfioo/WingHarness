// Ported from Argus (https://github.com/Ray-lea/Argus), AGPL-3.0-or-later.
// See docs/UPSTREAM_PROJECTS.md for the porting record.

// The services tab: the service list, its search / filter / sort state, the
// toolbar actions and the right-click menu. Polling runs only while the tab is
// selected and the document is visible.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  AlertCircle,
  ExternalLink,
  Play,
  RefreshCw,
  RotateCw,
  Search,
  Square,
  X,
} from "lucide-react";
import { toast } from "sonner";
import {
  argusErrorKey,
  argusServiceControl,
  argusServiceStartType,
  argusServicesConsole,
  argusServicesList,
  isArgusError,
  systoolsRevealInFileManager,
  type ArgusError,
  type ServiceAction,
  type ServiceInfo,
  type ServiceStartType,
} from "@/commands";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ServiceTable } from "@/components/task-manager/service-table";
import {
  serviceBinaryPath,
  type ServiceActions,
} from "@/components/task-manager/service-context-menu";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { useTaskManager } from "@/hooks/use-task-manager";
import {
  buildServiceRows,
  DEFAULT_SERVICE_SORT,
  isServicePending,
  SERVICE_FILTERS,
  type ServiceFilter,
  type ServiceSort,
} from "@/lib/task-manager/service-rows";
import { cn } from "@/lib/utils";

const POLL_MS = 3000;
const SKELETON_ROWS = 10;

const DONE_KEY: Record<ServiceAction, string> = {
  start: "started",
  stop: "stopped",
  restart: "restarted",
};

const FAILED_KEY: Record<ServiceAction, string> = {
  start: "startFailed",
  stop: "stopFailed",
  restart: "restartFailed",
};

function toServiceError(value: unknown): ArgusError {
  if (isArgusError(value)) return value;
  return {
    code: "internal",
    message: value instanceof Error ? value.message : String(value),
  };
}

function errorMessage(failure: unknown): string {
  if (isArgusError(failure)) return failure.message;
  return failure instanceof Error ? failure.message : String(failure);
}

function ServiceSkeleton() {
  return (
    <div className="border-border bg-card flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border">
      <div className="bg-muted/40 h-8 shrink-0 border-b" />
      {Array.from({ length: SKELETON_ROWS }, (_, index) => (
        <div key={index} className="border-border/50 flex h-8 items-center gap-3 border-b px-3">
          <Skeleton className="h-3 w-40" />
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-3 w-10" />
          <Skeleton className="ml-auto h-3 w-32" />
        </div>
      ))}
    </div>
  );
}

function ServiceEmpty({
  title,
  body,
  action,
}: {
  title: string;
  body?: string;
  action?: ReactNode;
}) {
  return (
    <div className="border-border bg-card flex min-h-0 flex-1 flex-col items-center justify-center gap-2 rounded-xl border px-6 py-12 text-center">
      <AlertCircle className="text-muted-foreground size-6" />
      <p className="text-sm font-medium">{title}</p>
      {body && <p className="text-muted-foreground max-w-md text-xs">{body}</p>}
      {action}
    </div>
  );
}

function SearchBox({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const { t } = useAppTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div className="group relative min-w-[12rem] flex-1">
      <Search className="text-muted-foreground group-focus-within:text-foreground pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 transition-colors" />
      <Input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          onChange("");
          inputRef.current?.blur();
        }}
        placeholder={t("taskManager.services.search.placeholder")}
        aria-label={t("taskManager.services.search.aria")}
        className="pr-10 pl-9"
      />
      {value && (
        <button
          type="button"
          onClick={() => {
            onChange("");
            inputRef.current?.focus();
          }}
          aria-label={t("taskManager.services.search.clear")}
          className="text-muted-foreground hover:bg-accent hover:text-foreground absolute top-1/2 right-2 flex size-5 -translate-y-1/2 items-center justify-center rounded"
        >
          <X className="size-3.5" />
        </button>
      )}
    </div>
  );
}

export function ServicesTab({ active }: { active: boolean }) {
  const { t } = useAppTranslation();
  const page = useTaskManager();

  const [services, setServices] = useState<ServiceInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ArgusError | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ServiceFilter>("all");
  const [sort, setSort] = useState<ServiceSort>(DEFAULT_SERVICE_SORT);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set());

  // A poll can finish after the page is gone; it must not write then.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const fetchOnce = useCallback(async (): Promise<void> => {
    try {
      const next = await argusServicesList();
      if (!mounted.current) return;
      setServices(next);
      setError(null);
    } catch (failure) {
      if (!mounted.current) return;
      setError(toServiceError(failure));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  // Poll only while this tab is selected. A hidden document pauses the timer
  // too, and showing it again fetches immediately.
  useEffect(() => {
    if (!active) return;
    let stopped = false;
    let timer: number | undefined;
    const tick = () => {
      if (stopped || document.visibilityState !== "visible") return;
      void fetchOnce();
    };
    const start = () => {
      if (timer !== undefined) return;
      tick();
      timer = window.setInterval(tick, POLL_MS);
    };
    const pause = () => {
      if (timer === undefined) return;
      window.clearInterval(timer);
      timer = undefined;
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") start();
      else pause();
    };
    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      stopped = true;
      pause();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [active, fetchOnce]);

  const rows = useMemo(
    () => buildServiceRows(services, query, filter, sort),
    [services, query, filter, sort]
  );

  const selected = useMemo(
    () =>
      selectedName ? (services.find((service) => service.name === selectedName) ?? null) : null,
    [services, selectedName]
  );

  // A refreshed list may no longer contain the selection (a service removed).
  useEffect(() => {
    if (selectedName && !services.some((service) => service.name === selectedName)) {
      setSelectedName(null);
    }
  }, [services, selectedName]);

  const counts = useMemo(
    () => ({
      running: services.filter((service) => service.state === "running").length,
      total: services.length,
    }),
    [services]
  );

  const setBusyFor = useCallback((name: string, inFlight: boolean) => {
    if (!mounted.current) return;
    setBusy((current) => {
      const next = new Set(current);
      if (inFlight) next.add(name);
      else next.delete(name);
      return next;
    });
  }, []);

  const control = useCallback(
    async (service: ServiceInfo, action: ServiceAction): Promise<void> => {
      setBusyFor(service.name, true);
      try {
        await argusServiceControl(service.name, action);
        toast.success(
          t(`taskManager.services.toast.${DONE_KEY[action]}`, { name: service.displayName })
        );
      } catch (failure) {
        toast.error(
          t(`taskManager.services.toast.${FAILED_KEY[action]}`, { name: service.displayName }),
          {
            description: isArgusError(failure)
              ? t(argusErrorKey(failure.code))
              : errorMessage(failure),
          }
        );
      } finally {
        setBusyFor(service.name, false);
        void fetchOnce();
      }
    },
    [fetchOnce, setBusyFor, t]
  );

  const changeStartType = useCallback(
    async (service: ServiceInfo, startType: ServiceStartType): Promise<void> => {
      setBusyFor(service.name, true);
      try {
        await argusServiceStartType(service.name, startType);
        toast.success(
          t("taskManager.services.toast.startTypeChanged", {
            name: service.displayName,
            type: t(`taskManager.services.startType.${startType}`),
          })
        );
      } catch (failure) {
        toast.error(
          t("taskManager.services.toast.startTypeFailed", { name: service.displayName }),
          {
            description: isArgusError(failure)
              ? t(argusErrorKey(failure.code))
              : errorMessage(failure),
          }
        );
      } finally {
        setBusyFor(service.name, false);
        void fetchOnce();
      }
    },
    [fetchOnce, setBusyFor, t]
  );

  const copyName = useCallback(
    async (service: ServiceInfo): Promise<void> => {
      try {
        await navigator.clipboard.writeText(service.name);
        toast.success(t("taskManager.services.toast.nameCopied"));
      } catch {
        toast.error(t("taskManager.toast.copyFailed"));
      }
    },
    [t]
  );

  const openLocation = useCallback(async (service: ServiceInfo): Promise<void> => {
    const binary = serviceBinaryPath(service.path);
    if (!binary) return;
    try {
      await systoolsRevealInFileManager(binary);
    } catch (failure) {
      toast.error(errorMessage(failure));
    }
  }, []);

  const actions = useMemo<ServiceActions>(
    () => ({
      busy,
      onControl: (service, action) => void control(service, action),
      onStartType: (service, startType) => void changeStartType(service, startType),
      onCopyName: (service) => void copyName(service),
      onOpenLocation: (service) => void openLocation(service),
    }),
    [busy, control, changeStartType, copyName, openLocation]
  );

  const openConsole = useCallback((): void => {
    void argusServicesConsole().catch((failure: unknown) => {
      const parsed = toServiceError(failure);
      toast.error(t(argusErrorKey(parsed.code)));
    });
  }, [t]);

  const pending = selected !== null && (busy.has(selected.name) || isServicePending(selected));
  const canStart = selected !== null && !pending && selected.state !== "running";
  const canStop = selected !== null && !pending && selected.canStop;
  const serviceReady = page.service?.state === "running";

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <SearchBox value={query} onChange={setQuery} />

          <div
            role="group"
            aria-label={t("taskManager.services.column.status")}
            className="border-border bg-card flex h-9 shrink-0 items-center gap-0.5 rounded-lg border p-[3px]"
          >
            {SERVICE_FILTERS.map((option) => {
              const isActive = filter === option;
              return (
                <button
                  key={option}
                  type="button"
                  aria-pressed={isActive}
                  onClick={() => setFilter(option)}
                  className={cn(
                    "focus-visible:ring-ring/50 h-full rounded-md px-2.5 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:outline-hidden",
                    isActive
                      ? "bg-accent text-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  {t(`taskManager.services.filter.${option}`)}
                </button>
              );
            })}
          </div>

          <Button
            variant="outline"
            size="sm"
            disabled={!canStart}
            onClick={() => {
              if (selected) void control(selected, "start");
            }}
          >
            <Play />
            {t("taskManager.services.actions.start")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!canStop}
            onClick={() => {
              if (selected) void control(selected, "stop");
            }}
          >
            <Square />
            {t("taskManager.services.actions.stop")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!canStop}
            onClick={() => {
              if (selected) void control(selected, "restart");
            }}
          >
            <RotateCw />
            {t("taskManager.services.actions.restart")}
          </Button>

          <Button variant="outline" size="sm" onClick={openConsole}>
            <ExternalLink />
            {t("taskManager.services.actions.openConsole")}
          </Button>
          <Button variant="outline" size="sm" onClick={() => void fetchOnce()}>
            <RefreshCw />
            {t("taskManager.services.actions.refresh")}
          </Button>
        </div>

        {error && services.length > 0 && (
          <div
            role="alert"
            className="border-destructive/40 bg-destructive/5 text-destructive rounded-lg border px-3 py-1.5 text-xs"
          >
            {t(argusErrorKey(error.code))}
          </div>
        )}
      </div>

      {loading && services.length === 0 ? (
        <ServiceSkeleton />
      ) : error && services.length === 0 ? (
        <ServiceEmpty
          title={t("taskManager.services.empty.error")}
          body={t(argusErrorKey(error.code))}
          action={
            <Button variant="outline" size="sm" onClick={() => void fetchOnce()}>
              {t("taskManager.services.actions.refresh")}
            </Button>
          }
        />
      ) : services.length === 0 ? (
        <ServiceEmpty
          title={t("taskManager.services.empty.error")}
          body={t("taskManager.services.empty.loading")}
          action={
            <Button variant="outline" size="sm" onClick={() => void fetchOnce()}>
              {t("taskManager.services.actions.refresh")}
            </Button>
          }
        />
      ) : rows.length === 0 ? (
        <ServiceEmpty
          title={t("taskManager.services.empty.noMatch")}
          action={
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setQuery("");
                setFilter("all");
              }}
            >
              {t("taskManager.services.empty.clear")}
            </Button>
          }
        />
      ) : (
        <ServiceTable
          rows={rows}
          selectedName={selectedName}
          sort={sort}
          actions={actions}
          onSortChange={(next: ServiceSort) => setSort(next)}
          onSelect={setSelectedName}
        />
      )}

      <footer className="text-muted-foreground flex flex-wrap items-center justify-between gap-2 px-1 text-xs">
        <span className="tabular-nums">
          {t("taskManager.services.summary", {
            running: counts.running,
            total: counts.total,
          })}
        </span>
        {!serviceReady && <span>{t("taskManager.services.manageHint")}</span>}
      </footer>
    </div>
  );
}
