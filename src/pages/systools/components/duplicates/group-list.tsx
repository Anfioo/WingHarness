import { useEffect, useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useAppTranslation } from "@/hooks/use-app-translation";
import {
  suggestedGroupPaths,
  type DuplicateFileEntry,
  type DuplicateGroup,
  type DuplicateKeeperRule,
} from "@/lib/systools/duplicates";
import {
  buildDuplicateRows,
  DUPLICATE_ENTRY_ROW_HEIGHT,
  DuplicateEntryRow,
  DuplicateGroupRow,
} from "./group-row";

type GroupSuggestion = {
  suggested: ReadonlySet<string>;
  applied: boolean;
  unselectedCount: number;
};

type DuplicateGroupListProps = {
  groups: readonly DuplicateGroup[];
  labels: ReadonlyMap<string, string>;
  selected: ReadonlySet<string>;
  expanded: ReadonlySet<string>;
  keeperRule: DuplicateKeeperRule;
  /** Rows stay readable but cannot be selected while a scan or delete runs. */
  disabled: boolean;
  /** Changes for a new scan so the list scrolls back to the top. */
  resetKey: number;
  onToggleExpanded: (groupId: string) => void;
  onToggleGroup: (group: DuplicateGroup) => void;
  onToggleEntry: (group: DuplicateGroup, entry: DuplicateFileEntry, selected: boolean) => void;
  onOpenEntry: (entry: DuplicateFileEntry) => void;
  onRevealEntry: (entry: DuplicateFileEntry) => void;
  onDeleteEntry: (entry: DuplicateFileEntry) => void;
};

/**
 * Virtualized duplicate groups. A group can hold thousands of copies, so the
 * virtualizer works on flattened fixed-height rows rather than whole groups.
 */
export function DuplicateGroupList({
  groups,
  labels,
  selected,
  expanded,
  keeperRule,
  disabled,
  resetKey,
  onToggleExpanded,
  onToggleGroup,
  onToggleEntry,
  onOpenEntry,
  onRevealEntry,
  onDeleteEntry,
}: DuplicateGroupListProps) {
  const { t } = useAppTranslation();
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const suggestions = useMemo(() => {
    const map = new Map<string, GroupSuggestion>();
    for (const group of groups) {
      const suggested = new Set(suggestedGroupPaths(group, keeperRule));
      let unselectedCount = 0;
      for (const entry of group.entries) {
        if (!selected.has(entry.path)) unselectedCount += 1;
      }
      const applied =
        suggested.size > 0 &&
        group.entries.every((entry) => selected.has(entry.path) === suggested.has(entry.path));
      map.set(group.id, { suggested, applied, unselectedCount });
    }
    return map;
  }, [groups, keeperRule, selected]);

  const rows = useMemo(() => buildDuplicateRows(groups, expanded), [groups, expanded]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => rows[index]?.height ?? DUPLICATE_ENTRY_ROW_HEIGHT,
    getItemKey: (index) => rows[index]?.key ?? index,
    overscan: 10,
  });

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [resetKey]);

  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto px-1">
      <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((item) => {
          const row = rows[item.index];
          if (!row) return null;
          return (
            <div
              key={item.key}
              className="absolute top-0 left-0 w-full"
              style={{
                height: item.size,
                transform: `translateY(${item.start}px)`,
              }}
            >
              {row.kind === "group" ? (
                <DuplicateGroupRow
                  group={row.group}
                  label={labels.get(row.group.id) ?? row.group.entries[0]?.name ?? ""}
                  expanded={expanded.has(row.group.id)}
                  suggestedCount={suggestions.get(row.group.id)?.suggested.size ?? 0}
                  applied={suggestions.get(row.group.id)?.applied ?? false}
                  disabled={disabled}
                  onToggleExpanded={() => onToggleExpanded(row.group.id)}
                  onToggleSelection={() => onToggleGroup(row.group)}
                />
              ) : (
                <DuplicateEntryRow
                  entry={row.entry}
                  selected={selected.has(row.entry.path)}
                  disabled={
                    disabled ||
                    row.entry.deletePolicy === "protected" ||
                    isOnlyKeeper(row.group, row.entry, selected, suggestions)
                  }
                  actionsDisabled={disabled}
                  disabledReason={
                    row.entry.deletePolicy === "protected"
                      ? t("systools.duplicates.entry.protectedReason")
                      : isOnlyKeeper(row.group, row.entry, selected, suggestions)
                        ? t("systools.duplicates.entry.keepLast")
                        : null
                  }
                  onToggle={() =>
                    onToggleEntry(row.group, row.entry, !selected.has(row.entry.path))
                  }
                  onOpen={() => onOpenEntry(row.entry)}
                  onReveal={() => onRevealEntry(row.entry)}
                  onDelete={() => onDeleteEntry(row.entry)}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** The last unselected copy in a group is the keeper and cannot be selected. */
function isOnlyKeeper(
  group: DuplicateGroup,
  entry: DuplicateFileEntry,
  selected: ReadonlySet<string>,
  suggestions: ReadonlyMap<string, GroupSuggestion>
): boolean {
  if (selected.has(entry.path)) return false;
  return (suggestions.get(group.id)?.unselectedCount ?? 0) <= 1;
}
