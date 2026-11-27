/** Official Scoop buckets, so their name alone is enough to clone them. */
export const KNOWN_BUCKETS: Record<string, string> = {
  main: "https://github.com/ScoopInstaller/Main",
  extras: "https://github.com/ScoopInstaller/Extras",
  versions: "https://github.com/ScoopInstaller/Versions",
  java: "https://github.com/ScoopInstaller/Java",
  games: "https://github.com/ScoopInstaller/Games",
  nirsoft: "https://github.com/ScoopInstaller/Nirsoft",
  php: "https://github.com/ScoopInstaller/PHP",
  nonportable: "https://github.com/ScoopInstaller/Nonportable",
};

/** What the buckets tab runs for the typed line. */
export type ScoopBucketAction =
  | { kind: "add"; name: string; url: string }
  | { kind: "install"; spec: string; bucket: string | null };

/** `unknown` means "not a known bucket", `url` "not a repository address". */
export type ScoopBucketReason = "empty" | "unknown" | "name" | "url" | "tooMany";

export type ScoopBucketParse =
  { ok: true; action: ScoopBucketAction } | { ok: false; reason: ScoopBucketReason; value: string };

const BUCKET_NAME = /^[a-z0-9][a-z0-9._-]*$/;

function looksLikeUrl(token: string): boolean {
  return /^https?:/i.test(token);
}

function repositoryUrl(token: string): URL | null {
  if (!/^https?:\/\//i.test(token)) return null;
  try {
    const url = new URL(token);
    return url.hostname.includes(".") || url.hostname === "localhost" ? url : null;
  } catch {
    return null;
  }
}

/** `https://github.com/ScoopInstaller/Extras` → `extras`. */
function nameFromUrl(url: string): string {
  const repo = url
    .replace(/\/+$/, "")
    .split("/")
    .pop()
    ?.replace(/\.git$/, "");
  return (repo ?? "").toLowerCase();
}

function installAction(spec: string): ScoopBucketParse {
  const first = spec.split(/\s+/)[0];
  const bucket = first.includes("/") ? first.split("/")[0].toLowerCase() : null;
  return { ok: true, action: { kind: "install", spec, bucket } };
}

/**
 * Reads one typed line as either a bucket to clone or an app to install.
 *
 * Accepted, with every leading word optional: `scoop bucket add <name> <url>`,
 * `<name> <url>`, a repository URL on its own, a known bucket name on its own,
 * and `scoop install <bucket>/<manifest>` or `<bucket>/<manifest>`. A bare
 * `owner/repo` is an install, not a clone: that is how `scoop install` reads it.
 * The `install` word is also what makes a longer line — several apps, or the
 * forms the search tab accepts — an install instead of a malformed clone.
 */
export function parseBucketInput(text: string): ScoopBucketParse {
  const raw = text.trim();
  const tokens = raw.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { ok: false, reason: "empty", value: raw };

  let stripped = tokens;
  if (stripped[0].toLowerCase() === "scoop") stripped = stripped.slice(1);
  if (stripped[0]?.toLowerCase() === "bucket") stripped = stripped.slice(1);
  if (stripped[0]?.toLowerCase() === "add") stripped = stripped.slice(1);
  if (stripped.length === 0) return { ok: false, reason: "empty", value: raw };

  if (stripped[0].toLowerCase() === "install") {
    const spec = stripped.slice(1).join(" ");
    return spec ? installAction(spec) : { ok: false, reason: "empty", value: raw };
  }

  if (stripped.length === 1) {
    const token = stripped[0];
    if (repositoryUrl(token)) {
      const name = nameFromUrl(token);
      return BUCKET_NAME.test(name)
        ? { ok: true, action: { kind: "add", name, url: token } }
        : { ok: false, reason: "url", value: token };
    }
    if (looksLikeUrl(token)) return { ok: false, reason: "url", value: token };
    if (token.includes("/")) return installAction(token);

    const known = KNOWN_BUCKETS[token.toLowerCase()];
    return known
      ? { ok: true, action: { kind: "add", name: token.toLowerCase(), url: known } }
      : { ok: false, reason: "unknown", value: token };
  }

  if (stripped.length === 2) {
    if (!repositoryUrl(stripped[1])) {
      return { ok: false, reason: "url", value: stripped[1] };
    }
    const name = stripped[0].toLowerCase();
    return BUCKET_NAME.test(name)
      ? { ok: true, action: { kind: "add", name, url: stripped[1] } }
      : { ok: false, reason: "name", value: stripped[0] };
  }

  return { ok: false, reason: "tooMany", value: raw };
}
