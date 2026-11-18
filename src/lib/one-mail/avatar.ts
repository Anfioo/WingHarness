// Part of the one-mail module, adapted from OneMail
// (https://github.com/zhihui-hu/one-mail), AGPL-3.0-only.
// See `src-tauri/one-mail-core/UPSTREAM.md` for the porting record.

/**
 * The eight avatar tints, spelled out as whole Tailwind classes: the scanner
 * only sees classes that appear literally, so no `bg-${tone}` is possible.
 */
const AVATAR_TONES = [
  "bg-sky-500/15 text-sky-700 dark:text-sky-300",
  "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  "bg-rose-500/15 text-rose-700 dark:text-rose-300",
  "bg-violet-500/15 text-violet-700 dark:text-violet-300",
  "bg-cyan-500/15 text-cyan-700 dark:text-cyan-300",
  "bg-orange-500/15 text-orange-700 dark:text-orange-300",
  "bg-teal-500/15 text-teal-700 dark:text-teal-300",
];

/**
 * A stable tint for any seed — an account colour key or a correspondent's
 * address. The same seed always lands on the same class, so a rail row and its
 * messages keep one colour without the backend having to freeze a palette.
 */
export function avatarTone(seed: string): string {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) % 100_000;
  }
  return AVATAR_TONES[hash % AVATAR_TONES.length];
}

/** One or two letters for the avatar: the name when there is one, else the address. */
export function initialsFor(name: string | null | undefined, email: string): string {
  const source = (name ?? "").trim() || email.split("@")[0] || "?";
  const parts = source.split(/[\s._-]+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
