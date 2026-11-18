// Part of the one-mail module, adapted from OneMail
// (https://github.com/zhihui-hu/one-mail), AGPL-3.0-only.
// See `src-tauri/one-mail-core/UPSTREAM.md` for the porting record.

import type { ReactNode } from "react";
import { Plus, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import type { OneMailFilters } from "@/hooks/use-one-mail-page";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { cn } from "@/lib/utils";
import { useOneMailPageContext } from "@/pages/one-mail/context";

type Range = OneMailFilters["range"];

const RANGE_CHIPS: { value: Range; labelKey: string }[] = [
  { value: "all", labelKey: "oneMail.filters.all" },
  { value: "today", labelKey: "oneMail.filters.today" },
  { value: "yesterday", labelKey: "oneMail.filters.yesterday" },
  { value: "last7days", labelKey: "oneMail.filters.last7Days" },
];

function Chip({
  active,
  onClick,
  children,
  pressed,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
  pressed?: boolean;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed ?? active}
      onClick={onClick}
      className={cn(
        "focus-visible:ring-ring h-6 rounded-full border px-2.5 text-[11px] font-medium whitespace-nowrap transition-colors focus-visible:ring-2 focus-visible:outline-none",
        active
          ? "border-primary bg-primary text-primary-foreground hover:bg-primary/90"
          : "border-border/70 bg-background/50 text-muted-foreground hover:bg-muted hover:text-foreground"
      )}
    >
      {children}
    </button>
  );
}

/**
 * The list header: search, the add menu and the filter chips.
 *
 * Search is typed into the page state, and the hook debounces the keyword
 * itself; every chip change refetches page zero, so there is no apply button.
 */
export default function MailFilters() {
  const page = useOneMailPageContext();
  const { t } = useAppTranslation();

  const { filters, setFilters, keyword, setKeyword } = page;

  const setRange = (range: Range) => {
    if (range === "all") {
      setFilters({ unreadOnly: false, starredOnly: false, range: "all" });
      return;
    }
    setFilters({ ...filters, range: filters.range === range ? "all" : range });
  };
  const allActive = !filters.unreadOnly && !filters.starredOnly && filters.range === "all";

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1.5">
        <div className="group relative min-w-0 flex-1">
          <Search className="text-muted-foreground group-focus-within:text-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 transition-colors" />
          <Input
            type="text"
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              setKeyword("");
              event.currentTarget.blur();
            }}
            placeholder={t("oneMail.filters.searchPlaceholder")}
            aria-label={t("oneMail.filters.searchPlaceholder")}
            className="h-8 pl-8 text-xs"
          />
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="icon-sm"
              aria-label={t("oneMail.list.add")}
              title={t("oneMail.list.add")}
            >
              <Plus className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-44">
            <DropdownMenuItem onSelect={page.accountDialog.openAdd}>
              {t("oneMail.list.addProvider")}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={page.composer.openNew}>
              {t("oneMail.list.newMessage")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="flex flex-wrap items-center gap-1">
        {RANGE_CHIPS.map((chip) => (
          <Chip
            key={chip.value}
            active={chip.value === "all" ? allActive : filters.range === chip.value}
            onClick={() => setRange(chip.value)}
          >
            {t(chip.labelKey)}
          </Chip>
        ))}
        <span aria-hidden className="bg-border mx-0.5 h-3.5 w-px" />
        <Chip
          active={filters.unreadOnly}
          pressed={filters.unreadOnly}
          onClick={() => setFilters({ ...filters, unreadOnly: !filters.unreadOnly })}
        >
          {t("oneMail.filters.unread")}
        </Chip>
        <Chip
          active={filters.starredOnly}
          pressed={filters.starredOnly}
          onClick={() => setFilters({ ...filters, starredOnly: !filters.starredOnly })}
        >
          {t("oneMail.filters.starred")}
        </Chip>
      </div>
    </div>
  );
}
