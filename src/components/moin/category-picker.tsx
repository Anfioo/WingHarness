// Adapted from moin (MIT), https://github.com/exxvius/moin at 79e7587.
// See `src-tauri/moin-core/UPSTREAM.md` for the porting record.

import { useMemo } from "react";
import type { MoinCategory } from "@/commands";
import { CategoryGlyph, categoryLabel } from "@/components/moin/category-card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAppTranslation } from "@/hooks/use-app-translation";

/** Radix Select forbids an empty item value, so "no category" needs a sentinel. */
const NONE = "__none__";

export type CategoryPickerProps = {
  categories: MoinCategory[];
  value: string | null;
  disabled?: boolean;
  id?: string;
  className?: string;
  onChange: (categoryId: string | null) => void;
};

/**
 * Single-select category dropdown with a colour dot per entry, ordered the way
 * the engine matches them. Clearing the selection yields `null` ("no category"),
 * which is what `moin_add_download` and `moin_move_to_category` expect.
 */
export function CategoryPicker({
  categories,
  value,
  disabled = false,
  id,
  className,
  onChange,
}: CategoryPickerProps) {
  const { t } = useAppTranslation();
  const ordered = useMemo(
    () => [...categories].sort((left, right) => left.order - right.order),
    [categories]
  );

  return (
    <Select
      value={value ?? NONE}
      disabled={disabled}
      onValueChange={(next) => onChange(next === NONE ? null : next)}
    >
      <SelectTrigger id={id} className={className} aria-label={t("moin.category.title")}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE}>{t("moin.common.clear")}</SelectItem>
        {ordered.map((category) => (
          <SelectItem key={category.id} value={category.id}>
            <CategoryGlyph icon={category.icon} color={category.color} className="size-2.5" />
            {categoryLabel(category, t)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
