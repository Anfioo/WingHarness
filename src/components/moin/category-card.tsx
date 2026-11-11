// Adapted from moin (MIT), https://github.com/exxvius/moin at 79e7587.
// See `src-tauri/moin-core/UPSTREAM.md` for the porting record.

import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  Archive,
  Book,
  Briefcase,
  Code,
  Download,
  File,
  Film,
  Folder,
  Gamepad2,
  GraduationCap,
  GripVertical,
  Image,
  Music,
  Pencil,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import type { MoinCategory, MoinTrigger } from "@/commands";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { formatBytes } from "@/lib/moin/format";
import { cn } from "@/lib/utils";

/** The translator returned by `useAppTranslation`, passed to the label helpers. */
export type MoinTranslate = ReturnType<typeof useAppTranslation>["t"];

/**
 * The eight colour tokens the editor offers, mapped onto Tailwind's `*-500`
 * steps. `color` is stored as the hex value so the three seeded categories and
 * any hand-edited `categories.json` keep working; the tokens only drive the
 * palette and the swatch classes.
 */
export const CATEGORY_COLORS = [
  { token: "red", hex: "#ef4444", swatch: "bg-red-500" },
  { token: "orange", hex: "#f97316", swatch: "bg-orange-500" },
  { token: "amber", hex: "#f59e0b", swatch: "bg-amber-500" },
  { token: "green", hex: "#22c55e", swatch: "bg-green-500" },
  { token: "teal", hex: "#14b8a6", swatch: "bg-teal-500" },
  { token: "blue", hex: "#3b82f6", swatch: "bg-blue-500" },
  { token: "violet", hex: "#8b5cf6", swatch: "bg-violet-500" },
  { token: "pink", hex: "#ec4899", swatch: "bg-pink-500" },
] as const;

/** Default for a new category: the `blue` token. */
export const DEFAULT_CATEGORY_COLOR: string = CATEGORY_COLORS[5].hex;

/** The twelve `lucide-react` icons the editor offers, stored as ids. */
export const CATEGORY_ICON_IDS = [
  "file",
  "film",
  "music",
  "image",
  "archive",
  "code",
  "book",
  "gamepad-2",
  "graduation-cap",
  "briefcase",
  "folder",
  "download",
] as const;

const ICON_MAP: Record<string, LucideIcon> = {
  file: File,
  film: Film,
  music: Music,
  image: Image,
  archive: Archive,
  code: Code,
  book: Book,
  "gamepad-2": Gamepad2,
  "graduation-cap": GraduationCap,
  briefcase: Briefcase,
  folder: Folder,
  download: Download,
};

/** Resolves a stored icon id; `null` when the id is unknown or unset. */
export function categoryIcon(id: string | null): LucideIcon | null {
  if (!id) return null;
  return ICON_MAP[id] ?? null;
}

/** Ids the backend seeds on a fresh install; their names are translated. */
const SEED_IDS = ["documents", "videos", "archives"];

/**
 * Seed categories are stored with English names, so the UI translates them by
 * id. Every other category shows the name the user typed — never a translation,
 * otherwise switching language would rewrite the stored name.
 */
export function categoryLabel(category: MoinCategory, t: MoinTranslate): string {
  if (SEED_IDS.includes(category.id)) {
    return t(`moin.category.defaults.${category.id}`);
  }
  return category.name;
}

/** One rule in one line: extensions, a byte range, or the first glob. */
export function describeTrigger(trigger: MoinTrigger, t: MoinTranslate): string {
  switch (trigger.type) {
    case "extension":
      return trigger.exts.length > 0
        ? trigger.exts.map((ext) => `.${ext}`).join(", ")
        : t("moin.trigger.extension");
    case "size": {
      const min = trigger.min === null ? null : formatBytes(trigger.min);
      const max = trigger.max === null ? null : formatBytes(trigger.max);
      if (min !== null && max !== null) return `${min} – ${max}`;
      if (min !== null) return `≥ ${min}`;
      if (max !== null) return `≤ ${max}`;
      return t("moin.trigger.size");
    }
    case "url-pattern":
      return trigger.patterns[0] ?? t("moin.trigger.urlPattern");
    case "name-pattern":
      return trigger.patterns[0] ?? t("moin.trigger.namePattern");
  }
}

/** The colour dot, or the icon tinted with the category colour. */
export function CategoryGlyph({
  icon,
  color,
  className,
}: {
  icon: string | null;
  color: string;
  className?: string;
}) {
  const Icon = icon ? ICON_MAP[icon] : undefined;
  if (Icon) {
    return <Icon className={cn("shrink-0", className)} style={{ color }} aria-hidden />;
  }
  return (
    <span
      aria-hidden
      className={cn("inline-block shrink-0 rounded-full", className)}
      style={{ backgroundColor: color || "var(--primary)" }}
    />
  );
}

export type CategoryCardProps = {
  category: MoinCategory;
  /** Downloads currently tagged with this category. */
  taskCount: number;
  disabled?: boolean;
  onEdit: () => void;
  onDelete: () => void;
};

/**
 * One category in the grid: glyph, name, rule summary, folder and hit count.
 * The whole card is a sortable item; only the grip starts a drag so the edit
 * and delete buttons stay clickable.
 */
export function CategoryCard({
  category,
  taskCount,
  disabled = false,
  onEdit,
  onDelete,
}: CategoryCardProps) {
  const { t } = useAppTranslation();
  const { setNodeRef, transform, transition, attributes, listeners, isDragging } = useSortable({
    id: category.id,
    disabled,
  });

  const ruleSummary =
    category.triggers.length === 0
      ? t("moin.category.noRules")
      : t("moin.category.ruleCount", { count: category.triggers.length });
  const firstRule = category.triggers[0];

  return (
    <article
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        "bg-card flex min-w-0 flex-col gap-2 rounded-lg border p-3",
        isDragging && "opacity-60"
      )}
    >
      <div className="flex min-w-0 items-start gap-2">
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground mt-0.5 cursor-grab touch-none rounded active:cursor-grabbing"
          aria-label={t("moin.category.order")}
          disabled={disabled}
          {...attributes}
          {...listeners}
        >
          <GripVertical className="size-4" />
        </button>
        <CategoryGlyph icon={category.icon} color={category.color} className="mt-0.5 size-4" />
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{categoryLabel(category, t)}</p>
          <p className="text-muted-foreground truncate text-xs">{ruleSummary}</p>
        </div>
        <div className="flex shrink-0 items-center">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t("moin.category.edit")}
            disabled={disabled}
            onClick={onEdit}
          >
            <Pencil />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t("moin.common.delete")}
            disabled={disabled}
            onClick={onDelete}
          >
            <Trash2 />
          </Button>
        </div>
      </div>

      {category.hidden_from_all && (
        <Badge variant="outline" className="w-fit">
          {t("moin.category.hiddenFromAll")}
        </Badge>
      )}

      {firstRule && (
        <p className="text-muted-foreground truncate font-mono text-xs">
          {describeTrigger(firstRule, t)}
        </p>
      )}

      {category.save_dir && (
        <p className="text-muted-foreground truncate font-mono text-xs" title={category.save_dir}>
          {category.save_dir}
        </p>
      )}

      <p className="text-muted-foreground mt-auto text-xs">
        {t("moin.task.count", { count: taskCount })}
      </p>
    </article>
  );
}
