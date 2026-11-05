import { useAppTranslation } from "@/hooks/use-app-translation";
import { cn } from "@/lib/utils";

/**
 * The status colour and label for a raw SVN status code.
 *
 * This is the single place status colour lives. Three views feed it raw codes
 * of two shapes and expect the same colour for the same meaning:
 *
 *  - the `svn status` words the file list and changed-path rows carry
 *    (`modified`, `added`, `deleted`, `replaced`, `unversioned`, `missing`,
 *    `conflicted`, `obstructed`), and
 *  - the single-letter log actions (`A` / `D` / `M` / `R`).
 *
 * Both are folded onto one small set of canonical names here, so colour and
 * label never drift between callers.
 */
type StatusName =
  | "added"
  | "modified"
  | "deleted"
  | "replaced"
  | "unversioned"
  | "missing"
  | "conflicted"
  | "obstructed";

function statusName(code: string): StatusName | null {
  switch (code.trim().toLowerCase()) {
    case "a":
    case "added":
      return "added";
    case "d":
    case "deleted":
      return "deleted";
    case "m":
    case "modified":
      return "modified";
    case "r":
    case "replaced":
      return "replaced";
    case "unversioned":
      return "unversioned";
    case "missing":
      return "missing";
    case "conflicted":
      return "conflicted";
    case "obstructed":
      return "obstructed";
    default:
      return null;
  }
}

/**
 * The Tailwind classes for a status code (the reference's `getStatusClass`,
 * reskinned to this project's tokens). Returns a class *string* rather than a
 * status name so it drops straight onto `className`.
 */
export function statusTone(code: string): string {
  switch (statusName(code)) {
    case "added":
      return "bg-success/15 text-success";
    case "modified":
      return "bg-info/15 text-info";
    case "replaced":
      return "bg-primary/15 text-primary";
    case "deleted":
    case "missing":
    case "conflicted":
    case "obstructed":
      return "bg-destructive/15 text-destructive";
    case "unversioned":
      return "bg-muted text-muted-foreground";
    default:
      return "bg-muted text-muted-foreground";
  }
}

/**
 * The i18n key for a status code: `status.added` … `status.obstructed` under
 * the shared `common` fragment, falling back to the raw code when the code is
 * unknown. Matches the reference's `getStatusLabelKey`.
 */
export function statusLabelKey(code: string): string {
  const name = statusName(code);
  return name ? `svnWorkspace.common.status.${name}` : code;
}

/**
 * The coloured status chip. Resolves {@link statusLabelKey} through the app
 * translation; if the shared `common` fragment does not carry the key yet it
 * falls back to this feature's own `changes` fragment, and finally to the raw
 * code, so the chip is always legible.
 */
export function StatusBadge({ code, className }: { code: string; className?: string }) {
  const { t } = useAppTranslation();
  const key = statusLabelKey(code);
  const translated = t(key);
  const name = statusName(code);
  const ownKey = name ? `svnWorkspace.changes.status.${name}` : "";
  const own = ownKey ? t(ownKey) : key;
  const label = translated !== key ? translated : own !== ownKey ? own : code;

  return (
    <span
      data-status-badge={name ?? code}
      className={cn(
        "inline-flex h-5 items-center justify-center rounded-[4px] px-1.5 font-mono text-[10px] leading-none font-semibold uppercase",
        statusTone(code),
        className
      )}
    >
      {label}
    </span>
  );
}
