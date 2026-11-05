import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  Network,
  PowerOff,
  RefreshCw,
  RotateCw,
  ShieldOff,
  Square,
} from "lucide-react";
import { toast } from "sonner";
import {
  clashProxies,
  clashProxyDelay,
  clashProxySelect,
  type ClashProxiesView,
  type ClashProxyGroup,
  type ClashProxyNode,
} from "@/commands";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { cn } from "@/lib/utils";
import { collectNodes, groupsForMode, isSelectable, protocolLabel, toneClass } from "./nodes";
import { Empty, IconButton, Segmented } from "./shared";

/** The table only moves when a group picks again or a probe finishes. */
const POLL_MS = 3000;

type Progress = { done: number; total: number };

export function ProxiesTab({
  running,
  mode,
  onChangeMode,
}: {
  running: boolean;
  /** `rule` | `global` | `direct`; null while the core cannot be asked. */
  mode: string | null;
  onChangeMode: (mode: string) => void;
}) {
  const { t } = useAppTranslation();

  const [view, setView] = useState<ClashProxiesView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [testing, setTesting] = useState<ReadonlySet<string>>(() => new Set());
  const [progress, setProgress] = useState<Progress | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const mounted = useRef(true);
  // A ref, not state: the batch loop reads it between awaits and would keep
  // seeing the value captured when the run started.
  const cancelRef = useRef(false);

  const load = useCallback(async () => {
    try {
      const next = await clashProxies();
      if (!mounted.current) return;
      setView(next);
      setError(null);
    } catch (cause) {
      if (!mounted.current) return;
      setView(null);
      setError(String(cause));
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load();
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => {
      mounted.current = false;
      window.clearInterval(timer);
    };
  }, [load]);

  const toggleGroup = useCallback((name: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(name)) next.add(name);
      return next;
    });
  }, []);

  const choose = useCallback(
    async (group: ClashProxyGroup, member: ClashProxyNode) => {
      if (group.now === member.name) return;
      setBusy(group.name);
      try {
        await clashProxySelect(group.name, member.name);
        // The core switched immediately; show it before the next poll lands.
        setView(
          (prev) =>
            prev && {
              ...prev,
              groups: prev.groups.map((item) =>
                item.name === group.name ? { ...item, now: member.name } : item
              ),
            }
        );
        toast.success(t("clash.proxy.selected", { name: member.name }));
      } catch (cause) {
        toast.error(String(cause));
      } finally {
        setBusy(null);
      }
    },
    [t]
  );

  const mark = useCallback((name: string, on: boolean) => {
    setTesting((prev) => {
      const next = new Set(prev);
      if (on) next.add(name);
      else next.delete(name);
      return next;
    });
  }, []);

  /** Probe one node and fold the answer into every group that lists it. */
  const probeOne = useCallback(
    async (name: string, quiet: boolean): Promise<boolean> => {
      mark(name, true);
      try {
        const delay = await clashProxyDelay(name);
        if (!mounted.current) return true;
        setView((prev) => patchMember(prev, name, { alive: true, delay }));
        return true;
      } catch (cause) {
        if (!mounted.current) return false;
        // Clear the stale figure too, or the card keeps its old colour.
        setView((prev) => patchMember(prev, name, { alive: false, delay: null }));
        if (!quiet) toast.error(`${name}: ${String(cause)}`);
        return false;
      } finally {
        if (mounted.current) mark(name, false);
      }
    },
    [mark]
  );

  // The mode decides which groups are in force, so the list and the batch probe
  // both follow it.
  const groups = useMemo(() => groupsForMode(view, mode ?? "rule"), [view, mode]);
  const testable = useMemo(() => collectNodes(view, groups), [view, groups]);

  /** One after another: probing every node at once would flood the core. */
  const testAll = useCallback(async () => {
    const names = testable.map((entry) => entry.node.name);
    if (names.length === 0) return;
    cancelRef.current = false;
    setProgress({ done: 0, total: names.length });
    let failed = 0;
    for (const name of names) {
      if (cancelRef.current || !mounted.current) break;
      if (!(await probeOne(name, true))) failed += 1;
      if (!mounted.current) return;
      setProgress((prev) => prev && { ...prev, done: prev.done + 1 });
    }
    if (!mounted.current) return;
    setProgress(null);
    // One summary instead of a toast per dead node.
    if (failed > 0) toast.error(t("clash.proxy.testFailed", { count: failed }));
  }, [probeOne, t, testable]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        {mode ? (
          <Segmented
            value={mode}
            options={[
              { value: "rule", label: t("clash.runtime.modes.rule") },
              { value: "global", label: t("clash.runtime.modes.global") },
              { value: "direct", label: t("clash.runtime.modes.direct") },
            ]}
            onChange={onChangeMode}
          />
        ) : (
          <span className="text-muted-foreground/70 shrink-0 text-xs">
            {t("clash.runtime.modeOffline")}
          </span>
        )}
        <div
          className="text-muted-foreground min-w-0 flex-1 truncate text-xs"
          title={t("clash.proxy.hint")}
        >
          {t("clash.proxy.hint")}
        </div>
        {progress && (
          <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
            {t("clash.proxy.testProgress", {
              done: progress.done,
              total: progress.total,
            })}
          </span>
        )}
        <Button
          size="sm"
          variant="outline"
          disabled={!progress && testable.length === 0}
          onClick={() => {
            if (progress) cancelRef.current = true;
            else void testAll();
          }}
        >
          {progress ? <Square className="size-3.5" /> : <RotateCw className="size-3.5" />}
          {progress ? t("clash.proxy.testStop") : t("clash.proxy.testAll")}
        </Button>
        <Button size="sm" variant="outline" onClick={() => void load()}>
          <RefreshCw className="size-3.5" />
          {t("clash.actions.refresh")}
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {error ? (
          <Empty icon={PowerOff} text={running ? error : t("clash.proxy.offline")} />
        ) : mode === "direct" ? (
          <Empty icon={ShieldOff} text={t("clash.proxy.directMode")} />
        ) : groups.length === 0 ? (
          <Empty icon={Network} text={t("clash.proxy.empty")} />
        ) : (
          <div className="flex flex-col gap-2 p-3">
            {groups.map((group) => (
              <GroupRow
                key={group.name}
                group={group}
                busy={busy === group.name}
                collapsed={collapsed.has(group.name)}
                testing={testing}
                onToggle={() => toggleGroup(group.name)}
                onChoose={choose}
                onProbe={(name) => void probeOne(name, false)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function GroupRow({
  group,
  busy,
  collapsed,
  testing,
  onToggle,
  onChoose,
  onProbe,
}: {
  group: ClashProxyGroup;
  busy: boolean;
  collapsed: boolean;
  testing: ReadonlySet<string>;
  onToggle: () => void;
  onChoose: (group: ClashProxyGroup, member: ClashProxyNode) => void;
  onProbe: (name: string) => void;
}) {
  const { t } = useAppTranslation();

  return (
    <section className="bg-card/40 rounded-lg border">
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={!collapsed}
          className="-ml-0.5 flex min-w-0 items-center gap-1 text-left"
        >
          <ChevronDown
            className={cn(
              "text-muted-foreground size-4 shrink-0 transition-transform",
              collapsed && "-rotate-90"
            )}
          />
          <span className="truncate text-sm font-medium">{group.name}</span>
        </button>
        <Badge variant="secondary" className="h-5 shrink-0 rounded px-1.5 text-[11px] font-normal">
          {group.kind}
        </Badge>
        <span className="text-muted-foreground/60 shrink-0 text-[11px] tabular-nums">
          {group.members.length}
        </span>
        <span
          className="text-muted-foreground ml-auto max-w-[55%] min-w-0 truncate text-right text-[11px]"
          title={group.now || undefined}
        >
          {group.now ? t("clash.proxy.groupNow", { name: group.now }) : t("clash.proxy.automatic")}
        </span>
      </div>

      {!collapsed && (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-2 border-t p-3">
          {group.members.map((member) => (
            <NodeCardView
              key={member.name}
              group={group}
              member={member}
              active={member.name === group.now}
              testing={testing.has(member.name)}
              busy={busy}
              onProbe={() => onProbe(member.name)}
              onChoose={() => onChoose(group, member)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function NodeCardView({
  group,
  member,
  active,
  testing,
  busy,
  onProbe,
  onChoose,
}: {
  group: ClashProxyGroup;
  member: ClashProxyNode;
  active: boolean;
  testing: boolean;
  busy: boolean;
  onProbe: () => void;
  onChoose: () => void;
}) {
  const { t } = useAppTranslation();
  // Automatic groups pick for themselves; only a Selector accepts a manual
  // choice. Probing is read-only and stays available either way.
  const clickable = isSelectable(group) && !busy;

  return (
    <div
      className={cn(
        "bg-background/40 flex items-center gap-2 rounded-lg border px-3 py-2.5 transition-colors",
        active ? "border-primary/60 bg-primary/10" : "hover:border-primary/40 hover:bg-accent/40",
        clickable ? "cursor-pointer" : "cursor-default"
      )}
      onClick={clickable ? onChoose : undefined}
      title={
        clickable
          ? t("clash.proxy.select", { name: member.name })
          : isSelectable(group)
            ? member.name
            : t("clash.proxy.automatic")
      }
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-sm font-medium">
          {active && <Check className="text-primary size-4 shrink-0" />}
          <span className="truncate">{member.name}</span>
        </div>
        <div className="text-muted-foreground mt-1 flex items-baseline gap-2 text-xs">
          <span className="truncate">{protocolLabel(member.kind)}</span>
          <span className={cn("shrink-0 font-mono tabular-nums", toneClass(member))}>
            {!member.alive
              ? t("clash.proxy.dead")
              : member.delay === null
                ? "—"
                : `${member.delay} ms`}
          </span>
        </div>
      </div>
      {/* The arrow tests this node; the card body picks it. */}
      <span className="shrink-0" onClick={(event) => event.stopPropagation()}>
        <IconButton title={t("clash.proxy.testOne")} disabled={testing} onClick={onProbe}>
          <RotateCw className={cn("size-3.5", testing && "animate-spin")} />
        </IconButton>
      </span>
    </div>
  );
}

/** Every group listing a node shows the same probe result. */
function patchMember(
  view: ClashProxiesView | null,
  name: string,
  patch: Pick<ClashProxyNode, "alive" | "delay">
): ClashProxiesView | null {
  if (!view) return view;
  return {
    ...view,
    groups: view.groups.map((group) => ({
      ...group,
      members: group.members.map((member) =>
        member.name === name ? { ...member, ...patch } : member
      ),
    })),
  };
}
