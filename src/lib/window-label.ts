/**
 * A window label for an entity id: one window per workspace, repository or data
 * source, so opening the same entity twice focuses the window already open
 * instead of stacking duplicates.
 *
 * A window label may only contain alphanumerics and `-`, `/`, `:`, `_` (see
 * `@/lib/plugin-label`), so the id is hashed rather than embedded. The hash is
 * FNV-1a over the UTF-16 code units, printed as 16 hex chars: a collision would
 * silently focus the wrong entity's window, which a 32-bit hash makes too
 * likely to accept.
 */
export function hashedWindowLabel(prefix: string, id: string) {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;

  for (let i = 0; i < id.length; i += 1) {
    hash ^= BigInt(id.charCodeAt(i));
    hash = (hash * prime) & mask;
  }

  return prefix + hash.toString(16).padStart(16, "0");
}
