import { ArrowUp, ChevronRight, House } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAppTranslation } from "@/hooks/use-app-translation";
import type { AnalysisBreadcrumb } from "@/lib/systools/storage";
import { cn } from "@/lib/utils";

type BrowserToolbarProps = {
  breadcrumbs: AnalysisBreadcrumb[];
  canGoUp: boolean;
  disabled: boolean;
  onNavigate: (path: string) => void;
  onUp: () => void;
  onHome: () => void;
};

/** Breadcrumbs plus parent/home navigation. */
export function BrowserToolbar({
  breadcrumbs,
  canGoUp,
  disabled,
  onNavigate,
  onUp,
  onHome,
}: BrowserToolbarProps) {
  const { t } = useAppTranslation();
  const visible = breadcrumbs.length > 4 ? breadcrumbs.slice(-4) : breadcrumbs;

  return (
    <div
      className="flex min-w-0 shrink-0 items-center gap-1 border-b px-2 py-1"
      data-slot="analysis-browser-toolbar"
    >
      <Button
        variant="ghost"
        size="icon-xs"
        onClick={onUp}
        disabled={!canGoUp || disabled}
        aria-label={t("systools.analysis.back")}
        title={t("systools.analysis.back")}
      >
        <ArrowUp className="size-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        onClick={onHome}
        disabled={disabled}
        aria-label={t("systools.analysis.home")}
        title={t("systools.analysis.home")}
      >
        <House className="size-3.5" />
      </Button>

      <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden">
        {breadcrumbs.length > visible.length ? (
          <span className="text-muted-foreground px-1 text-xs">…</span>
        ) : null}
        {visible.map((crumb, index) => {
          const current = index === visible.length - 1;
          return (
            <span key={crumb.path} className="flex min-w-0 items-center gap-0.5">
              {index > 0 ? (
                <ChevronRight
                  className="text-muted-foreground size-3 shrink-0"
                  aria-hidden="true"
                />
              ) : null}
              <button
                type="button"
                className={cn(
                  "max-w-40 truncate rounded-sm px-1 py-0.5 text-xs hover:underline",
                  current ? "font-medium" : "text-muted-foreground hover:text-foreground"
                )}
                title={crumb.path}
                onClick={() => onNavigate(crumb.path)}
                disabled={disabled || current}
              >
                {crumb.name}
              </button>
            </span>
          );
        })}
      </div>
    </div>
  );
}
