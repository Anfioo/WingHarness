import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { PortEntry } from "@/commands";
import { Skeleton } from "@/components/ui/skeleton";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { cn } from "@/lib/utils";
import { PortRow } from "./port-row";
import type { PortsListProps } from "./props";

const SKELETON_ROWS = 5;

const SECTION = "rounded-xl border border-border bg-card divide-y divide-border overflow-hidden";
const HEADER_TITLE = "text-xs font-medium text-muted-foreground";
const HEADER_COUNT = "font-mono text-[11px] text-muted-foreground tabular-nums";

/** Entries with no resolvable process live in their own group, sorted last. */
const NO_PROCESS_KEY = "";

type PortGroup = { key: string; label: string; entries: PortEntry[] };

/** Merge both visible lists by port, ascending, keeping the first entry per port. */
function mergeResults(pinned: PortEntry[], others: PortEntry[]): PortEntry[] {
  const byPort = new Map<number, PortEntry>();
  for (const entry of [...pinned, ...others]) {
    if (!byPort.has(entry.port)) byPort.set(entry.port, entry);
  }
  return Array.from(byPort.values()).sort((left, right) => left.port - right.port);
}

/** Group by process name, biggest group first, alphabetical within a size, no-process last. */
function groupByProcess(entries: PortEntry[], noProcessLabel: string): PortGroup[] {
  const buckets = new Map<string, PortEntry[]>();
  for (const entry of entries) {
    const key = entry.process?.name ?? NO_PROCESS_KEY;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(entry);
    else buckets.set(key, [entry]);
  }

  return [...buckets.entries()]
    .map(([key, members]) => ({
      key,
      label: key === NO_PROCESS_KEY ? noProcessLabel : key,
      entries: members,
    }))
    .sort(
      (left, right) =>
        Number(left.key === NO_PROCESS_KEY) - Number(right.key === NO_PROCESS_KEY) ||
        right.entries.length - left.entries.length ||
        left.label.localeCompare(right.label)
    );
}

/** Whole-list empty state: no rows to show at all. */
function EmptyCard({ title, body }: { title: string; body: string }) {
  return (
    <div className="border-border bg-card rounded-xl border px-4 py-12 text-center">
      <p className="text-sm font-medium">{title}</p>
      <p className="text-muted-foreground mt-1 text-xs">{body}</p>
    </div>
  );
}

/** Section-level empty state: one group is empty while the page still has rows. */
function SectionEmpty({ title, body }: { title: string; body: string }) {
  return (
    <div className="px-3.5 py-6 text-center">
      <p className="text-xs font-medium">{title}</p>
      <p className="text-muted-foreground mt-1 text-[11px]">{body}</p>
    </div>
  );
}

export function PortsList({
  pinned,
  others,
  query,
  pinnedOnly,
  groupBy,
  loading,
  onOpenDetail,
  onKill,
  onTogglePin,
}: PortsListProps) {
  const { t } = useAppTranslation();
  const [othersOpen, setOthersOpen] = useState(false);
  const [openGroups, setOpenGroups] = useState<Set<string>>(() => new Set());

  const trimmedQuery = query.trim();
  const hasQuery = trimmedQuery.length > 0;
  const total = pinned.length + others.length;
  const results = useMemo(() => mergeResults(pinned, others), [pinned, others]);
  const pinnedPorts = useMemo(() => new Set(pinned.map((entry) => entry.port)), [pinned]);
  const groups = useMemo(
    () => (groupBy === "app" ? groupByProcess(others, t("ports.list.noProcess")) : []),
    [groupBy, others, t]
  );

  const toggleGroup = (key: string) => {
    setOpenGroups((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  if (loading && total === 0) {
    return (
      <div className={SECTION}>
        {Array.from({ length: SKELETON_ROWS }, (_, index) => (
          <div key={index} className="flex h-12 items-center gap-3 px-3.5">
            <Skeleton className="size-2 rounded-full" />
            <Skeleton className="h-3 w-[52px]" />
            <Skeleton className="h-3 w-[118px]" />
            <Skeleton className="h-3 flex-1" />
            <Skeleton className="h-5 w-16 rounded-full" />
          </div>
        ))}
      </div>
    );
  }

  if (total === 0) {
    return (
      <EmptyCard
        title={t("ports.list.noMatch.title")}
        body={
          hasQuery
            ? t("ports.list.noMatch.bodyWithQuery", { query: trimmedQuery })
            : t("ports.list.noMatch.body")
        }
      />
    );
  }

  if (hasQuery) {
    return (
      <section className={SECTION}>
        <div className="flex flex-col items-start gap-1 px-3.5 py-2">
          <h2 className={HEADER_TITLE}>{t("ports.list.results", { count: results.length })}</h2>
          <p className="text-muted-foreground text-[11px]">
            {t("ports.list.resultsHint", { query: trimmedQuery })}
          </p>
        </div>
        {results.map((entry) => (
          <PortRow
            key={entry.port}
            port={entry}
            pinned={pinnedPorts.has(entry.port)}
            showPin
            onOpenDetail={onOpenDetail}
            onKill={onKill}
            onTogglePin={onTogglePin}
          />
        ))}
      </section>
    );
  }

  return (
    <div className="space-y-4">
      <section className={SECTION}>
        <div className="flex items-baseline gap-2 px-3.5 py-2">
          <h2 className={HEADER_TITLE}>{t("ports.list.pinned")}</h2>
          <span className={HEADER_COUNT}>{pinned.length}</span>
        </div>
        {pinned.length > 0 ? (
          pinned.map((entry) => (
            <PortRow
              key={entry.port}
              port={entry}
              pinned
              showPin
              onOpenDetail={onOpenDetail}
              onKill={onKill}
              onTogglePin={onTogglePin}
            />
          ))
        ) : (
          <SectionEmpty
            title={t("ports.list.pinnedEmpty.title")}
            body={t("ports.list.pinnedEmpty.body")}
          />
        )}
      </section>

      {!pinnedOnly && (
        <section className={SECTION}>
          {others.length > 0 ? (
            <button
              type="button"
              onClick={() => setOthersOpen((open) => !open)}
              aria-expanded={othersOpen}
              className="group hover:bg-accent focus-visible:ring-ring/50 flex w-full items-center gap-2 px-3.5 py-2 text-left focus-visible:ring-2 focus-visible:outline-none"
            >
              <span className={cn(HEADER_TITLE, "group-hover:text-foreground")}>
                {t("ports.list.other")}
              </span>
              <span className={HEADER_COUNT}>{others.length}</span>
              <span className="bg-border h-px flex-1" />
              <span className="text-muted-foreground group-hover:text-foreground text-[11px]">
                {othersOpen ? t("ports.list.hideOther") : t("ports.list.showOther")}
              </span>
              <ChevronDown
                className={cn(
                  "text-muted-foreground size-4 transition-transform",
                  othersOpen && "rotate-180"
                )}
              />
            </button>
          ) : (
            <div className="flex items-baseline gap-2 px-3.5 py-2">
              <h2 className={HEADER_TITLE}>{t("ports.list.other")}</h2>
              <span className={HEADER_COUNT}>0</span>
            </div>
          )}

          {others.length > 0 &&
            othersOpen &&
            (groupBy === "app" ? (
              <div className="divide-border divide-y">
                {groups.map((group) => {
                  const open = openGroups.has(group.key);
                  return (
                    <div key={group.key} className="divide-border divide-y">
                      <button
                        type="button"
                        onClick={() => toggleGroup(group.key)}
                        aria-expanded={open}
                        className="hover:bg-accent focus-visible:ring-ring/50 flex w-full items-center gap-2 py-2 pr-3.5 pl-6 text-left focus-visible:ring-2 focus-visible:outline-none"
                      >
                        <ChevronRight
                          className={cn(
                            "text-muted-foreground size-3.5 shrink-0 transition-transform",
                            open && "rotate-90"
                          )}
                        />
                        <span className="text-foreground truncate text-xs font-medium">
                          {group.label}
                        </span>
                        <span className={HEADER_COUNT}>{group.entries.length}</span>
                      </button>
                      {open &&
                        group.entries.map((entry) => (
                          <PortRow
                            key={entry.port}
                            port={entry}
                            pinned={false}
                            showPin={false}
                            onOpenDetail={onOpenDetail}
                            onKill={onKill}
                            onTogglePin={onTogglePin}
                          />
                        ))}
                    </div>
                  );
                })}
              </div>
            ) : (
              others.map((entry) => (
                <PortRow
                  key={entry.port}
                  port={entry}
                  pinned={false}
                  showPin={false}
                  onOpenDetail={onOpenDetail}
                  onKill={onKill}
                  onTogglePin={onTogglePin}
                />
              ))
            ))}
          {others.length === 0 && (
            <SectionEmpty
              title={t("ports.list.otherEmpty.title")}
              body={t("ports.list.otherEmpty.body")}
            />
          )}
        </section>
      )}
    </div>
  );
}
