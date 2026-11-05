import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Loader2, Plus, RefreshCw, Search, Server, X } from "lucide-react";
import { toast } from "sonner";
import {
  serverConnectionClose,
  serverConnectionState,
  serverProfileCreate,
  serverProfileDelete,
  serverProfileReorder,
  serverProfilesList,
} from "@/commands/services/servers";
import type {
  ConnectionState,
  ServerProfile,
  ServerProfileInput,
  ServerProfilesView,
} from "@/commands/services/servers/types";
import { ServerFormDialog } from "@/components/servers/server-form";
import { ServerList } from "@/components/servers/server-list";
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
import { errorText, serverErrorCodeKey } from "@/lib/servers/format";
import { openServerWindow } from "@/lib/servers/windows";

const CONNECTION_POLL_MS = 5000;
const CLOCK_TICK_MS = 60_000;

export default function ServersPage() {
  const { t } = useAppTranslation();

  const [view, setView] = useState<ServerProfilesView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [states, setStates] = useState<Record<string, ConnectionState>>({});
  const [now, setNow] = useState(() => Date.now());

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ServerProfile | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ServerProfile | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const describe = useCallback(
    (failure: unknown) => {
      const key = serverErrorCodeKey(failure);
      return key ? t(key, { defaultValue: errorText(failure) }) : errorText(failure);
    },
    [t]
  );

  const load = useCallback(
    async (announce = false) => {
      setLoading(true);
      setError(null);
      try {
        const loaded = await serverProfilesList();
        setView(loaded);
        if (announce) {
          toast.success(t("servers.reload.done", { defaultValue: "Server list refreshed." }));
        }
      } catch (failure) {
        setError(describe(failure));
      } finally {
        setLoading(false);
      }
    },
    [describe, t]
  );

  useEffect(() => {
    void load();
  }, [load]);

  // The relative "last connected" labels only need minute precision.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => window.clearInterval(timer);
  }, []);

  // Connection state lives in the engine, so it is polled rather than pushed.
  const idsKey = useMemo(
    () => (view?.profiles ?? []).map((profile) => profile.id).join("|"),
    [view]
  );

  useEffect(() => {
    const ids = idsKey ? idsKey.split("|") : [];
    if (ids.length === 0) {
      setStates({});
      return;
    }

    let cancelled = false;
    const poll = async () => {
      const results = await Promise.all(
        ids.map(async (id) => {
          try {
            return [id, await serverConnectionState(id)] as const;
          } catch {
            return [id, "idle"] as const;
          }
        })
      );
      if (!cancelled) setStates(Object.fromEntries(results));
    };

    void poll();
    const timer = window.setInterval(() => void poll(), CONNECTION_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [idsKey]);

  const profiles = view?.profiles ?? [];

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return profiles;
    return profiles.filter(
      (profile) =>
        profile.name.toLowerCase().includes(needle) ||
        profile.host.toLowerCase().includes(needle) ||
        profile.username.toLowerCase().includes(needle)
    );
  }, [profiles, query]);

  const handleOpen = async (profile: ServerProfile) => {
    try {
      await openServerWindow(profile.id);
    } catch (failure) {
      toast.error(
        t("servers.error.openFailed", {
          defaultValue: "Could not open the server window: {{error}}",
          error: describe(failure),
        })
      );
    }
  };

  const handleEdit = (profile: ServerProfile) => {
    setEditing(profile);
    setFormOpen(true);
  };

  const handleCreate = () => {
    setEditing(null);
    setFormOpen(true);
  };

  const handleSaved = useCallback(
    (profile: ServerProfile) => {
      // Keep the open dialog in sync with the credential flags the engine just
      // returned, then reload for the authoritative list.
      setEditing((current) => (current && current.id === profile.id ? profile : current));
      void load();
    },
    [load]
  );

  const handleDuplicate = async (profile: ServerProfile) => {
    setBusyId(profile.id);
    const input: ServerProfileInput = {
      name: t("servers.form.duplicateName", {
        name: profile.name,
        defaultValue: "{{name}} (copy)",
      }),
      host: profile.host,
      port: profile.port,
      username: profile.username,
      authKind: profile.authKind,
      privateKey: profile.privateKey,
      password: profile.password,
      passphrase: profile.passphrase,
      terminalType: profile.terminalType,
      note: profile.note,
      color: profile.color,
    };
    try {
      const copy = await serverProfileCreate(input);
      toast.success(
        t("servers.toast.duplicated", { name: copy.name, defaultValue: "Created {{name}}." })
      );
      await load();
    } catch (failure) {
      toast.error(
        t("servers.toast.duplicateFailed", {
          defaultValue: "Could not duplicate the server: {{error}}",
          error: describe(failure),
        })
      );
    } finally {
      setBusyId(null);
    }
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await serverProfileDelete(pendingDelete.id);
      // Deleting a profile that is still open would leave a dead tab behind.
      await serverConnectionClose(pendingDelete.id).catch(() => undefined);
      toast.success(
        t("servers.toast.deleted", { name: pendingDelete.name, defaultValue: "Deleted {{name}}." })
      );
      setPendingDelete(null);
      await load();
    } catch (failure) {
      toast.error(
        t("servers.toast.deleteFailed", {
          defaultValue: "Could not delete the server: {{error}}",
          error: describe(failure),
        })
      );
    } finally {
      setDeleting(false);
    }
  };

  const handleMove = async (profile: ServerProfile, direction: -1 | 1) => {
    if (!view) return;
    const index = view.profiles.findIndex((entry) => entry.id === profile.id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= view.profiles.length) return;

    const next = [...view.profiles];
    [next[index], next[target]] = [next[target], next[index]];
    // Optimistic: the order is local state until the engine confirms it.
    setView({ ...view, profiles: next });

    try {
      await serverProfileReorder(next.map((entry) => entry.id));
    } catch (failure) {
      toast.error(
        t("servers.toast.reorderFailed", {
          defaultValue: "Could not save the new order: {{error}}",
          error: describe(failure),
        })
      );
      await load();
    }
  };

  const hasProfiles = profiles.length > 0;

  return (
    <div className="flex w-full min-w-0 flex-col gap-4">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold">{t("servers.title")}</h1>
          <p className="text-muted-foreground text-sm">{t("servers.subtitle")}</p>
        </div>
        <Button onClick={handleCreate}>
          <Plus />
          {t("servers.action.create")}
        </Button>
      </header>

      {hasProfiles && (
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative w-full max-w-md">
            <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
            <Input
              className="pr-8 pl-8"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("servers.search.placeholder", {
                defaultValue: "Search by name, host or username",
              })}
              aria-label={t("servers.search.placeholder", {
                defaultValue: "Search by name, host or username",
              })}
            />
            {query && (
              <Button
                variant="ghost"
                size="icon-xs"
                className="absolute top-1/2 right-1.5 -translate-y-1/2"
                aria-label={t("servers.search.clear", { defaultValue: "Clear search" })}
                onClick={() => setQuery("")}
              >
                <X />
              </Button>
            )}
          </div>

          <span className="text-muted-foreground text-xs">
            {t("servers.list.count", {
              count: profiles.length,
              defaultValue: "{{count}} servers",
            })}
          </span>

          <Button
            variant="ghost"
            size="sm"
            className="ml-auto"
            disabled={loading}
            onClick={() => void load(true)}
          >
            <RefreshCw className={loading ? "animate-spin" : undefined} />
            {t("servers.action.refresh", { defaultValue: "Refresh" })}
          </Button>
        </div>
      )}

      {loading && !view ? (
        <div className="text-muted-foreground flex flex-1 flex-col items-center justify-center gap-2 py-16 text-sm">
          <Loader2 className="size-6 animate-spin" />
          {t("servers.loading", { defaultValue: "Loading servers…" })}
        </div>
      ) : error && !view ? (
        <div className="border-destructive/40 bg-destructive/5 flex flex-col items-center gap-3 rounded-lg border border-dashed p-8 text-center">
          <AlertTriangle className="text-destructive size-7" />
          <p className="text-sm font-medium">
            {t("servers.error.loadFailed", { defaultValue: "Could not load the server list." })}
          </p>
          <p className="text-muted-foreground max-w-md text-xs break-words">{error}</p>
          <Button variant="outline" size="sm" disabled={loading} onClick={() => void load()}>
            <RefreshCw className={loading ? "animate-spin" : undefined} />
            {t("servers.action.retry", { defaultValue: "Retry" })}
          </Button>
        </div>
      ) : !hasProfiles ? (
        <div className="border-border text-muted-foreground flex flex-1 flex-col items-center justify-center gap-3 rounded-lg border border-dashed p-8 text-center text-sm">
          <Server className="size-8" />
          <p className="text-foreground font-medium">{t("servers.empty.title")}</p>
          <p className="max-w-md">{t("servers.empty.description")}</p>
          <Button variant="outline" onClick={handleCreate}>
            <Plus />
            {t("servers.empty.action")}
          </Button>
        </div>
      ) : filtered.length === 0 ? (
        <div className="border-border text-muted-foreground flex flex-col items-center gap-2 rounded-lg border border-dashed p-8 text-center text-sm">
          <Search className="size-6" />
          <p className="text-foreground font-medium">
            {t("servers.list.noResults", { defaultValue: "No servers match your search." })}
          </p>
          <Button variant="ghost" size="sm" onClick={() => setQuery("")}>
            {t("servers.search.clear", { defaultValue: "Clear search" })}
          </Button>
        </div>
      ) : (
        <ServerList
          profiles={filtered}
          orderIds={profiles.map((profile) => profile.id)}
          states={states}
          now={now}
          busyId={busyId}
          onOpen={(profile) => void handleOpen(profile)}
          onEdit={handleEdit}
          onDuplicate={(profile) => void handleDuplicate(profile)}
          onDelete={setPendingDelete}
          onMove={(profile, direction) => void handleMove(profile, direction)}
        />
      )}

      {error && view && (
        <div className="border-destructive/40 bg-destructive/5 text-destructive flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-xs">
          <AlertTriangle className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 break-words">{error}</span>
          <Button variant="ghost" size="xs" disabled={loading} onClick={() => void load()}>
            {t("servers.action.retry", { defaultValue: "Retry" })}
          </Button>
        </div>
      )}

      <ServerFormDialog
        open={formOpen}
        profile={editing}
        onOpenChange={setFormOpen}
        onSaved={handleSaved}
      />

      <Dialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open && !deleting) setPendingDelete(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="text-destructive size-4 shrink-0" />
              {t("servers.delete.title", { defaultValue: "Delete server?" })}
            </DialogTitle>
            <DialogDescription>
              {t("servers.delete.description", {
                name: pendingDelete?.name ?? "",
                defaultValue:
                  "Deleting {{name}} also removes its saved password or passphrase and its trusted host key. This cannot be undone.",
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" disabled={deleting} onClick={() => setPendingDelete(null)}>
              {t("servers.form.cancel")}
            </Button>
            <Button variant="destructive" disabled={deleting} onClick={() => void confirmDelete()}>
              {deleting ? <Loader2 className="animate-spin" /> : <AlertTriangle />}
              {t("servers.action.delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
