import { ArrowDown, ArrowDownUp, ArrowUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAppTranslation } from "@/hooks/use-app-translation";
import type { LargeFileSortDirection, LargeFileSortKey } from "@/lib/systools/large-files";

type SortMenuProps = {
  sortKey: LargeFileSortKey;
  direction: LargeFileSortDirection;
  onSortKeyChange: (key: LargeFileSortKey) => void;
  onDirectionChange: (direction: LargeFileSortDirection) => void;
};

const SORT_KEYS: readonly LargeFileSortKey[] = ["size", "name", "modified"];

function isSortKey(value: string): value is LargeFileSortKey {
  return (SORT_KEYS as readonly string[]).includes(value);
}

function isDirection(value: string): value is LargeFileSortDirection {
  return value === "asc" || value === "desc";
}

/** Sort key and direction for the result list. */
export function SortMenu({
  sortKey,
  direction,
  onSortKeyChange,
  onDirectionChange,
}: SortMenuProps) {
  const { t } = useAppTranslation();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="xs" className="gap-1 text-xs">
          <ArrowDownUp className="size-3.5" />
          <span>{t(`systools.largeFiles.sort.keys.${sortKey}`)}</span>
          {direction === "asc" ? (
            <ArrowUp className="size-3.5" />
          ) : (
            <ArrowDown className="size-3.5" />
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuLabel>{t("systools.largeFiles.sort.label")}</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={sortKey}
          onValueChange={(value) => {
            if (isSortKey(value)) onSortKeyChange(value);
          }}
        >
          <DropdownMenuRadioItem value="size">
            {t("systools.largeFiles.sort.keys.size")}
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="name">
            {t("systools.largeFiles.sort.keys.name")}
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="modified">
            {t("systools.largeFiles.sort.keys.modified")}
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup
          value={direction}
          onValueChange={(value) => {
            if (isDirection(value)) onDirectionChange(value);
          }}
        >
          <DropdownMenuRadioItem value="desc">
            {t("systools.largeFiles.sort.descending")}
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="asc">
            {t("systools.largeFiles.sort.ascending")}
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
