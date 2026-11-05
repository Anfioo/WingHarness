import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useAppTranslation } from "@/hooks/use-app-translation";
import type { StartupArtifact, StartupCatalog, StartupDesiredState } from "@/lib/systools/startup";
import { ApplicationIcon } from "../uninstall/application-icon";
import { StartupRow, STARTUP_ROW_HEIGHT } from "./startup-row";

type StartupListProps = {
  catalog: StartupCatalog;
  /** Artifacts already narrowed by the source filter and search query. */
  artifacts: StartupArtifact[];
  icons: ReadonlyMap<string, string>;
  queue: ReadonlyMap<string, StartupDesiredState>;
  /** Changes whenever the filter or query changes so the list scrolls back up. */
  resetKey: string;
  blockedReason: (artifact: StartupArtifact) => string | null;
  onToggle: (artifact: StartupArtifact) => void;
};

type ListGroup = {
  key: string;
  name: string;
  iconPath: string | null;
  /** The synthetic group for artifacts the catalog did not group. */
  fallbackName: boolean;
  showHeader: boolean;
  items: StartupArtifact[];
};

type ListRow =
  | {
      kind: "group";
      key: string;
      groupId: string;
      name: string;
      iconPath: string | null;
      fallbackName: boolean;
      itemCount: number;
      expanded: boolean;
    }
  | { kind: "item"; key: string; artifact: StartupArtifact };

const GROUP_HEADER_HEIGHT = 32;

/** Virtualized owner groups with collapsible headers. */
export function StartupList({
  catalog,
  artifacts,
  icons,
  queue,
  resetKey,
  blockedReason,
  onToggle,
}: StartupListProps) {
  const { t } = useAppTranslation();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());

  const rows = useMemo<ListRow[]>(() => {
    const artifactsById = new Map(artifacts.map((artifact) => [artifact.itemId, artifact]));
    const consumed = new Set<string>();
    const groups: ListGroup[] = [];

    for (const group of catalog.groups) {
      const items: StartupArtifact[] = [];
      for (const itemId of group.itemIds) {
        const artifact = artifactsById.get(itemId);
        if (!artifact || consumed.has(itemId)) continue;
        consumed.add(itemId);
        items.push(artifact);
      }
      if (items.length) {
        groups.push({
          key: group.groupId,
          name: group.name,
          iconPath: group.iconPath,
          fallbackName: false,
          showHeader: group.name.length > 0,
          items,
        });
      }
    }

    // A catalog without groups (or with items outside every group) still has
    // to render: show the leftovers after the grouped rows.
    const leftovers = artifacts.filter((artifact) => !consumed.has(artifact.itemId));
    if (leftovers.length) {
      groups.push({
        key: "__startup_leftover__",
        name: "",
        iconPath: null,
        fallbackName: true,
        showHeader: groups.length > 0,
        items: leftovers,
      });
    }

    const next: ListRow[] = [];
    for (const group of groups) {
      const expanded = !collapsed.has(group.key);
      if (group.showHeader) {
        next.push({
          kind: "group",
          key: `g:${group.key}`,
          groupId: group.key,
          name: group.name,
          iconPath: group.iconPath,
          fallbackName: group.fallbackName,
          itemCount: group.items.length,
          expanded,
        });
      }
      if (expanded) {
        for (const artifact of group.items) {
          next.push({ kind: "item", key: `i:${artifact.itemId}`, artifact });
        }
      }
    }
    return next;
  }, [catalog.groups, artifacts, collapsed]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) =>
      rows[index].kind === "group" ? GROUP_HEADER_HEIGHT : STARTUP_ROW_HEIGHT,
    getItemKey: (index) => rows[index].key,
    overscan: 10,
  });

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [resetKey]);

  function toggleGroup(key: string) {
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto px-1">
        <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((virtualItem) => {
            const row = rows[virtualItem.index];
            return (
              <div
                key={virtualItem.key}
                className="absolute top-0 left-0 w-full"
                style={{
                  transform: `translateY(${virtualItem.start}px)`,
                  height: virtualItem.size,
                }}
              >
                {row.kind === "group" ? (
                  <button
                    type="button"
                    aria-expanded={row.expanded}
                    title={
                      row.expanded
                        ? t("systools.startup.actions.collapseGroup")
                        : t("systools.startup.actions.expandGroup")
                    }
                    onClick={() => toggleGroup(row.groupId)}
                    className="hover:bg-muted/50 flex h-8 w-full items-center gap-1.5 rounded-md px-2 text-left text-xs font-medium transition-colors"
                  >
                    {row.expanded ? (
                      <ChevronDown className="size-3.5 shrink-0" />
                    ) : (
                      <ChevronRight className="size-3.5 shrink-0" />
                    )}
                    <ApplicationIcon
                      name={row.fallbackName ? t("systools.startup.title") : row.name}
                      src={row.iconPath ? icons.get(row.iconPath) : undefined}
                      className="size-5 rounded"
                    />
                    <span className="truncate">
                      {row.fallbackName ? t("systools.startup.title") : row.name}
                    </span>
                    <Badge variant="outline" className="text-[10px] leading-4">
                      {t("systools.startup.summary.items", { count: row.itemCount })}
                    </Badge>
                  </button>
                ) : (
                  <StartupRow
                    artifact={row.artifact}
                    iconSrc={row.artifact.iconPath ? icons.get(row.artifact.iconPath) : undefined}
                    desiredState={queue.get(row.artifact.itemId)}
                    blockedReason={blockedReason(row.artifact)}
                    onToggle={onToggle}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
