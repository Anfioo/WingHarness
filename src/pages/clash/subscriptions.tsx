import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, Loader2, Plus, RefreshCw, Rss, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  clashProfileSelect,
  clashSubscriptionAdd,
  clashSubscriptionList,
  clashSubscriptionRemove,
  clashSubscriptionUpdate,
  type ClashProfile,
  type ClashSubscription,
} from "@/commands";
import { Badge } from "@/components/ui/badge";
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
import { Empty, IconButton, formatBytes } from "./shared";

/** The host a link points at; the whole URL when it is not a URL at all. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function date(seconds: number | null): string {
  if (!seconds) return "";
  const value = new Date(seconds * 1000);
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${value.getFullYear()}-${month}-${day}`;
}

/** `3小时前` / `3 hours ago`, in the page's own language. */
function elapsed(seconds: number, locale: string, justNow: string): string {
  const minutes = Math.round((seconds * 1000 - Date.now()) / 60000);
  if (Math.abs(minutes) < 1) return justNow;
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (Math.abs(minutes) < 60) return format.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return format.format(hours, "hour");
  const days = Math.round(hours / 24);
  if (Math.abs(days) < 30) return format.format(days, "day");
  const months = Math.round(days / 30);
  if (Math.abs(months) < 12) return format.format(months, "month");
  return format.format(Math.round(months / 12), "year");
}

export function SubscriptionsTab({
  activeProfile,
  profiles,
  refresh,
}: {
  activeProfile: string | null;
  profiles: ClashProfile[];
  refresh: () => Promise<void>;
}) {
  const { t } = useAppTranslation();

  const [items, setItems] = useState<ClashSubscription[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ name: "", url: "" });
  const [pendingDelete, setPendingDelete] = useState<ClashSubscription | null>(null);

  // Every subscription owns the profile its download lands in; whatever is left
  // was created or imported by hand and no link will ever overwrite it.
  const local = useMemo(() => {
    const remote = new Set(items.map((item) => item.profile));
    return profiles.filter((profile) => !remote.has(profile.id));
  }, [items, profiles]);

  const load = useCallback(async () => {
    try {
      setItems(await clashSubscriptionList());
    } catch (error) {
      console.error("Failed to load subscriptions:", error);
      toast.error(String(error));
    }
  }, []);

  const reload = useCallback(async () => {
    await load();
    await refresh();
  }, [load, refresh]);

  useEffect(() => {
    void load();
  }, [load]);

  const update = useCallback(
    async (item: ClashSubscription) => {
      setBusy(item.name);
      try {
        await clashSubscriptionUpdate(item.name);
        toast.success(t("clash.subs.updated", { name: item.name }));
      } catch (error) {
        toast.error(String(error));
      } finally {
        setBusy(null);
        await load();
        await refresh();
      }
    },
    [load, refresh, t]
  );

  const submit = useCallback(async () => {
    const name = draft.name.trim();
    const url = draft.url.trim();
    if (!name || !url) return;
    setBusy("add");
    try {
      const created = await clashSubscriptionAdd(name, url);
      setAdding(false);
      setDraft({ name: "", url: "" });
      setBusy(null);
      await load();
      await update(created);
    } catch (error) {
      toast.error(String(error));
      setBusy(null);
    }
  }, [draft, load, update]);

  const remove = useCallback(async () => {
    if (!pendingDelete) return;
    try {
      await clashSubscriptionRemove(pendingDelete.name);
      setPendingDelete(null);
      toast.success(t("clash.messages.deleted"));
      await load();
      await refresh();
    } catch (error) {
      toast.error(String(error));
    }
  }, [load, pendingDelete, refresh, t]);

  const activateProfile = useCallback(
    async (id: string) => {
      try {
        await clashProfileSelect(id);
        await refresh();
        toast.success(t("clash.messages.saved"));
      } catch (error) {
        toast.error(String(error));
      }
    },
    [refresh, t]
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <div className="text-muted-foreground min-w-0 flex-1 text-xs">{t("clash.subs.hint")}</div>
        <Button size="sm" variant="outline" onClick={() => void reload()}>
          <RefreshCw className="size-3.5" />
          {t("clash.actions.refresh")}
        </Button>
        <Button size="sm" onClick={() => setAdding(true)}>
          <Plus className="size-3.5" />
          {t("clash.subs.add")}
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {items.length === 0 && local.length === 0 ? (
          <Empty icon={Rss} text={t("clash.subs.empty")} />
        ) : (
          <div className="flex flex-col gap-3 p-2.5">
            <section className="flex flex-col gap-2">
              <GroupHeader label={t("clash.subs.remote")} count={items.length} />
              {items.length === 0 ? (
                <InlineEmpty text={t("clash.subs.emptyRemote")} />
              ) : (
                items.map((item) => (
                  <SubscriptionCard
                    key={item.name}
                    item={item}
                    active={activeProfile === item.profile}
                    busy={busy === item.name}
                    disabled={busy !== null}
                    onUpdate={() => void update(item)}
                    onActivate={() => void activateProfile(item.profile)}
                    onDelete={() => setPendingDelete(item)}
                  />
                ))
              )}
            </section>

            <section className="flex flex-col gap-2">
              <GroupHeader label={t("clash.subs.local")} count={local.length} />
              {local.length === 0 ? (
                <InlineEmpty text={t("clash.subs.emptyLocal")} />
              ) : (
                local.map((profile) => (
                  <LocalCard
                    key={profile.id}
                    profile={profile}
                    active={activeProfile === profile.id}
                    onActivate={() => void activateProfile(profile.id)}
                  />
                ))
              )}
            </section>
          </div>
        )}
      </div>

      <Dialog
        open={adding}
        onOpenChange={(open) => {
          if (open) return;
          setAdding(false);
          setDraft({ name: "", url: "" });
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("clash.subs.add")}</DialogTitle>
            <DialogDescription>{t("clash.subs.addHint")}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Input
              autoFocus
              placeholder={t("clash.subs.namePlaceholder")}
              value={draft.name}
              onChange={(event) => setDraft((prev) => ({ ...prev, name: event.target.value }))}
            />
            <Input
              placeholder="https://…"
              value={draft.url}
              onChange={(event) => setDraft((prev) => ({ ...prev, url: event.target.value }))}
              onKeyDown={(event) => event.key === "Enter" && void submit()}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAdding(false)}>
              {t("clash.prompts.cancel")}
            </Button>
            <Button onClick={() => void submit()} disabled={busy === "add"}>
              {busy === "add" && <Loader2 className="size-3.5 animate-spin" />}
              {t("clash.prompts.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("clash.actions.delete")}</DialogTitle>
            <DialogDescription>
              {t("clash.subs.confirmDelete", { name: pendingDelete?.name ?? "" })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingDelete(null)}>
              {t("clash.prompts.cancel")}
            </Button>
            <Button variant="destructive" onClick={() => void remove()}>
              {t("clash.prompts.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** `Subscriptions 3` — how many entries the section below holds. */
function GroupHeader({ label, count }: { label: string; count: number }) {
  return (
    <div className="text-muted-foreground flex items-center gap-1.5 px-0.5 text-xs font-medium">
      <span>{label}</span>
      <span className="font-mono text-[11px] tabular-nums">{count}</span>
    </div>
  );
}

function InlineEmpty({ text }: { text: string }) {
  return (
    <div className="text-muted-foreground/70 rounded-lg border border-dashed px-3.5 py-2.5 text-xs">
      {text}
    </div>
  );
}

function SubscriptionCard({
  item,
  active,
  busy,
  disabled,
  onUpdate,
  onActivate,
  onDelete,
}: {
  item: ClashSubscription;
  active: boolean;
  busy: boolean;
  disabled: boolean;
  onUpdate: () => void;
  onActivate: () => void;
  onDelete: () => void;
}) {
  const { t, language } = useAppTranslation();
  const used = item.upload + item.download;
  const percent =
    item.total > 0 ? Math.min(100, Math.max(1, Math.round((used / item.total) * 100))) : 0;
  const locale = language?.startsWith("zh") ? "zh-CN" : "en";
  const canActivate = !active && !disabled;

  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={active}
      onClick={() => canActivate && onActivate()}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        if (canActivate) onActivate();
      }}
      className={cn(
        "flex flex-col gap-2 rounded-lg border px-3.5 py-3 transition-colors",
        active ? "border-primary/50 bg-primary/5" : "bg-card/40 hover:bg-accent/40 cursor-pointer"
      )}
    >
      <div className="flex items-center gap-1.5">
        <span className="truncate text-sm font-medium" title={item.name}>
          {item.name}
        </span>
        <span
          className="bg-muted text-muted-foreground shrink-0 rounded px-1 font-mono text-[11px] leading-4"
          title={t("clash.subs.clashConfig")}
        >
          C
        </span>
        {active && <Check className="text-primary size-3.5 shrink-0" />}
        {item.error && (
          <Badge variant="destructive" className="shrink-0" title={item.error}>
            {t("clash.subs.failed")}
          </Badge>
        )}
        <span
          className="ml-auto flex shrink-0 items-center gap-0.5"
          onClick={(event) => event.stopPropagation()}
        >
          <IconButton title={t("clash.subs.update")} onClick={onUpdate} disabled={disabled}>
            {busy ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <RefreshCw className="size-3.5" />
            )}
          </IconButton>
          <IconButton title={t("clash.actions.delete")} onClick={onDelete} disabled={disabled}>
            <Trash2 className="size-3.5" />
          </IconButton>
        </span>
      </div>

      <div className="text-muted-foreground flex items-baseline gap-2 text-xs">
        <span className="truncate font-mono text-[11px]" title={item.url}>
          {hostOf(item.url)}
        </span>
        {item.lastUpdated && (
          <span className="ml-auto shrink-0">
            {elapsed(item.lastUpdated, locale, t("clash.subs.justNow"))}
          </span>
        )}
      </div>

      {(item.total > 0 || item.expire) && (
        <div className="flex items-baseline gap-2 text-xs">
          {item.total > 0 && (
            <span className="text-muted-foreground font-mono tabular-nums">
              {formatBytes(used)} / {formatBytes(item.total)}
            </span>
          )}
          {item.expire && (
            <span className="text-muted-foreground/70 ml-auto shrink-0 text-[11px] tabular-nums">
              {date(item.expire)}
            </span>
          )}
        </div>
      )}

      {item.total > 0 && (
        <div className="bg-muted h-1 w-full overflow-hidden rounded-full">
          <div
            className={cn(
              "h-full rounded-full",
              percent >= 90 ? "bg-red-500" : percent >= 70 ? "bg-amber-500" : "bg-primary"
            )}
            style={{ width: `${percent}%` }}
          />
        </div>
      )}

      {item.error && (
        <div className="text-destructive truncate text-[11px]" title={item.error}>
          {item.error}
        </div>
      )}
    </div>
  );
}

function LocalCard({
  profile,
  active,
  onActivate,
}: {
  profile: ClashProfile;
  active: boolean;
  onActivate: () => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={active}
      onClick={() => !active && onActivate()}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        if (!active) onActivate();
      }}
      className={cn(
        "flex items-center gap-2 rounded-lg border px-3.5 py-2.5 transition-colors",
        active ? "border-primary/50 bg-primary/5" : "bg-card/40 hover:bg-accent/40 cursor-pointer"
      )}
    >
      <span className="truncate text-sm font-medium" title={profile.id}>
        {profile.name}
      </span>
      {active && <Check className="text-primary size-3.5 shrink-0" />}
      <span className="text-muted-foreground ml-auto shrink-0 font-mono text-[11px] tabular-nums">
        {formatBytes(profile.size)}
      </span>
    </div>
  );
}
