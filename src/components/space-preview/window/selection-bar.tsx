// The multi-selection summary: how far into the hand-off the window is, and the
// two buttons that step through it. The count is hidden for a single file.

import { ChevronDown, ChevronUp } from "lucide-react";
import { useAppTranslation } from "@/hooks/use-app-translation";

interface SelectionBarProps {
  /** Zero-based position of the current file; -1 when nothing is open. */
  index: number;
  total: number;
  disabled: boolean;
  onPrevious: () => void;
  onNext: () => void;
}

export function SelectionBar({ index, total, disabled, onPrevious, onNext }: SelectionBarProps) {
  const { t } = useAppTranslation();
  const previousLabel = t("spacePreview.window.previous", { defaultValue: "Previous" });
  const nextLabel = t("spacePreview.window.next", { defaultValue: "Next" });

  return (
    <div className="flex min-w-0 flex-1 items-center gap-1">
      {total > 1 && (
        <span
          className="text-muted-foreground shrink-0 px-1 text-xs tabular-nums"
          title={t("spacePreview.window.multiSelect", { count: total })}
        >
          {index + 1} / {total}
        </span>
      )}
      <button
        type="button"
        aria-label={previousLabel}
        title={previousLabel}
        disabled={disabled}
        className="hover:bg-accent rounded-md p-1.5 disabled:opacity-40"
        onClick={onPrevious}
      >
        <ChevronUp className="size-4" />
      </button>
      <button
        type="button"
        aria-label={nextLabel}
        title={nextLabel}
        disabled={disabled}
        className="hover:bg-accent rounded-md p-1.5 disabled:opacity-40"
        onClick={onNext}
      >
        <ChevronDown className="size-4" />
      </button>
      <span className="text-muted-foreground hidden min-w-0 truncate px-1 text-xs sm:inline">
        {t("spacePreview.window.hint", {
          defaultValue: "Arrow keys switch files. Space or Esc closes.",
        })}
      </span>
    </div>
  );
}
