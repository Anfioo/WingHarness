// Part of the one-mail module, adapted from OneMail
// (https://github.com/zhihui-hu/one-mail), AGPL-3.0-only.
// See `src-tauri/one-mail-core/UPSTREAM.md` for the porting record.

import type { ReactNode } from "react";
import { RefreshCw, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { OneMailFilters } from "@/hooks/use-one-mail-page";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { cn } from "@/lib/utils";
import { useOneMailPageContext } from "@/pages/one-mail/context";

type Range = OneMailFilters["range"];

/** The time chips; "all" is the first chip and is not a range of its own. */
const RANGE_CHIPS: { value: Exclude<Range, "all">; labelKey: string }[] = [
  { value: "today", labelKey: "oneMail.filters.today" },
  { value: "yesterday", labelKey: "oneMail.filters.yesterday" },
  { value: "last7days", labelKey: "oneMail.filters.last7Days" },
];

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "focus-visible:ring-ring/50 h-6 rounded-full border px-2 text-[11px] font-medium whitespace-nowrap transition-colors focus-visible:ring-2 focus-visible:outline-none",
        active
          ? "border-primary/40 bg-primary/10 text-foreground"
          : "border-border text-muted-foreground hover:text-foreground"
      )}
    >
      {children}
    </button>
  );
}

/**
 * The list's search box and filter chips.
 *
 * The search value is written straight into the page state — the hook debounces
 * the keyword itself — and the chips only rearrange the filters object. Every
 * change makes the hook refetch page zero, so there is no apply button.
 */
export default function MailFilters() {
  const page = useOneMailPageContext();
  const { t } = useAppTranslation();

  const { filters, setFilters, keyword, setKeyword } = page;
  const allActive = !filters.unreadOnly && !filters.starredOnly && filters.range === "all";

  const selectRange = (range: Range) =>
    setFilters({ ...filters, range: filters.range === range ? "all" : range });

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
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

        <Button
          variant="outline"
          size="sm"
          className="shrink-0"
          onClick={page.reloadConversations}
          disabled={page.conversationsLoading}
        >
          <RefreshCw className={page.conversationsLoading ? "animate-spin" : undefined} />
          {t("oneMail.filters.refresh")}
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-1">
        <Chip
          active={allActive}
          onClick={() => setFilters({ unreadOnly: false, starredOnly: false, range: "all" })}
        >
          {t("oneMail.filters.all")}
        </Chip>
        <Chip
          active={filters.unreadOnly}
          onClick={() => setFilters({ ...filters, unreadOnly: !filters.unreadOnly })}
        >
          {t("oneMail.filters.unread")}
        </Chip>
        <Chip
          active={filters.starredOnly}
          onClick={() => setFilters({ ...filters, starredOnly: !filters.starredOnly })}
        >
          {t("oneMail.filters.starred")}
        </Chip>
        <span aria-hidden className="bg-border mx-0.5 h-3.5 w-px" />
        {RANGE_CHIPS.map((chip) => (
          <Chip
            key={chip.value}
            active={filters.range === chip.value}
            onClick={() => selectRange(chip.value)}
          >
            {t(chip.labelKey)}
          </Chip>
        ))}
      </div>
    </div>
  );
}
