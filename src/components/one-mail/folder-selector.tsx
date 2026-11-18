// Part of the one-mail module, adapted from OneMail
// (https://github.com/zhihui-hu/one-mail), AGPL-3.0-only.
// See `src-tauri/one-mail-core/UPSTREAM.md` for the porting record.

import { useMemo } from "react";
import type { FolderCandidate, FolderRole } from "@/commands";
import { Badge } from "@/components/ui/badge";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { cn } from "@/lib/utils";

export interface FolderSelectorProps {
  candidates: FolderCandidate[];
  /** Folder paths the account should sync. */
  selected: Set<string>;
  onChange: (paths: Set<string>) => void;
  disabled?: boolean;
}

type GroupKey = "inbox" | "sent" | "drafts" | "trash" | "junk" | "archive" | "custom";

const GROUP_ORDER: GroupKey[] = ["inbox", "sent", "drafts", "trash", "junk", "archive", "custom"];

const GROUP_LABEL: Record<GroupKey, string> = {
  inbox: "oneMail.folders.inbox",
  sent: "oneMail.folders.sent",
  drafts: "oneMail.folders.drafts",
  trash: "oneMail.folders.trash",
  junk: "oneMail.folders.junk",
  archive: "oneMail.folders.archive",
  custom: "oneMail.folders.custom",
};

const ROLE_GROUP: Record<FolderRole, GroupKey> = {
  inbox: "inbox",
  sent: "sent",
  drafts: "drafts",
  trash: "trash",
  junk: "junk",
  archive: "archive",
  all_mail: "custom",
  important: "custom",
  starred: "custom",
  custom: "custom",
};

const isInbox = (folder: FolderCandidate) => folder.role === "inbox";
const isLocked = (folder: FolderCandidate) => isInbox(folder) || !folder.selectable;

/**
 * The folder check list shared by account creation and account editing.
 *
 * INBOX is locked on: every account syncs it, so unchecking it is not offered.
 * `selected` carries paths rather than ids because a discovery result has no
 * folder ids yet — the account form maps the paths to ids after the save.
 */
export function FolderSelector({
  candidates,
  selected,
  onChange,
  disabled = false,
}: FolderSelectorProps) {
  const { t } = useAppTranslation();

  const groups = useMemo(() => {
    const buckets = new Map<GroupKey, FolderCandidate[]>();
    for (const folder of candidates) {
      const key = ROLE_GROUP[folder.role] ?? "custom";
      const bucket = buckets.get(key);
      if (bucket) bucket.push(folder);
      else buckets.set(key, [folder]);
    }
    for (const bucket of buckets.values()) {
      bucket.sort((left, right) => left.path.localeCompare(right.path));
    }
    return GROUP_ORDER.filter((key) => buckets.has(key)).map((key) => ({
      key,
      folders: buckets.get(key) ?? [],
    }));
  }, [candidates]);

  const selectable = candidates.filter((folder) => folder.selectable);
  const allSelected = selectable.every((folder) => isInbox(folder) || selected.has(folder.path));

  /** Every emitted set carries the locked inboxes, whatever the user picked. */
  const emit = (paths: Set<string>) => {
    const next = new Set(paths);
    for (const folder of candidates) {
      if (isInbox(folder)) next.add(folder.path);
    }
    onChange(next);
  };

  const toggleFolder = (folder: FolderCandidate, checked: boolean) => {
    const next = new Set(selected);
    if (checked) next.add(folder.path);
    else next.delete(folder.path);
    emit(next);
  };

  if (candidates.length === 0) {
    return (
      <p className="text-muted-foreground text-xs">{t("oneMail.accountForm.selectFolders")}</p>
    );
  }

  return (
    <div className="space-y-2 rounded-md border p-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-medium">{t("oneMail.accountForm.selectFolders")}</span>
        <label className="flex items-center gap-1.5 text-xs">
          <input
            type="checkbox"
            className="accent-primary size-3.5"
            checked={allSelected}
            disabled={disabled || selectable.length === 0}
            onChange={(event) =>
              emit(
                event.target.checked ? new Set(selectable.map((folder) => folder.path)) : new Set()
              )
            }
          />
          {t("oneMail.filters.all")}
        </label>
      </div>

      <div className="max-h-56 space-y-2 overflow-y-auto pr-1">
        {groups.map((group) => (
          <div key={group.key} className="space-y-1">
            <p className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
              {t(GROUP_LABEL[group.key])}
            </p>
            {group.folders.map((folder) => {
              const locked = isLocked(folder);
              const checked = isInbox(folder) || selected.has(folder.path);
              return (
                <label
                  key={folder.path}
                  className={cn(
                    "flex min-h-8 items-center gap-2 rounded px-2 text-xs",
                    locked ? "cursor-default" : "hover:bg-muted/50 cursor-pointer",
                    disabled && "opacity-60"
                  )}
                  title={folder.path}
                >
                  <input
                    type="checkbox"
                    className="accent-primary size-3.5 shrink-0"
                    checked={checked}
                    disabled={disabled || locked}
                    onChange={(event) => toggleFolder(folder, event.target.checked)}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{folder.name || folder.path}</span>
                    {folder.name && folder.name !== folder.path && (
                      <span className="text-muted-foreground block truncate text-[11px]">
                        {folder.path}
                      </span>
                    )}
                  </span>
                  <Badge variant="outline" className="shrink-0 text-[10px]">
                    {t(GROUP_LABEL[ROLE_GROUP[folder.role] ?? "custom"])}
                  </Badge>
                </label>
              );
            })}
          </div>
        ))}
      </div>

      {candidates.some(isInbox) && (
        <p className="text-muted-foreground text-[11px]">{t("oneMail.accountForm.inboxLocked")}</p>
      )}
    </div>
  );
}

export default FolderSelector;
