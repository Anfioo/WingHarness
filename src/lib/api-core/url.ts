/**
 * URL helpers for the API client: query-string codec, path-parameter filling
 * and scheme validation. All functions are pure and dependency-free.
 */
import type { KeyValue } from "@/lib/api-core/types";

/**
 * Decode a URI component without throwing on malformed input (`%` alone, bad
 * escapes). Invalid sequences are returned verbatim, which matches how most
 * HTTP clients behave.
 */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    return value;
  }
}

/** The name part of a placeholder row: a key that carries no value is kept. */
function isMeaningfulRow(row: KeyValue): boolean {
  return row.enabled && row.key !== "";
}

/**
 * Encode enabled rows as a query string (`a=1&b=2`). Disabled rows and rows
 * with an empty key are skipped. Both key and value are percent-encoded.
 */
export function encodeQuery(params: KeyValue[]): string {
  return params
    .filter(isMeaningfulRow)
    .map((row) => `${encodeURIComponent(row.key)}=${encodeURIComponent(row.value)}`)
    .join("&");
}

/**
 * Parse a query string (`?a=1&b=2` or `a=1&b=2`) into enabled rows. Keys
 * without `=` are captured with an empty value. Malformed input does not throw.
 */
export function parseQueryString(query: string): KeyValue[] {
  const body = query.startsWith("?") ? query.slice(1) : query;
  if (body === "") return [];
  return body
    .split("&")
    .filter((part) => part !== "")
    .map((part) => {
      const eq = part.indexOf("=");
      const key = eq >= 0 ? part.slice(0, eq) : part;
      const value = eq >= 0 ? part.slice(eq + 1) : "";
      return { key: safeDecode(key), value: safeDecode(value), enabled: true };
    });
}

/**
 * Trim a URL without adding a scheme. The engine only accepts absolute
 * `http`/`https` URLs, so callers should validate with {@link isHttpUrl}
 * rather than silently prefixing something.
 */
export function normalizeUrl(raw: string): string {
  return raw.trim();
}

/** True when `raw` parses to an absolute `http` or `https` URL. */
export function isHttpUrl(raw: string): boolean {
  const value = normalizeUrl(raw);
  if (value === "") return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** Extract the scheme (`http`, `https`, …) of a URL, or `null` if unparseable. */
export function urlScheme(raw: string): string | null {
  const value = normalizeUrl(raw);
  if (value === "") return null;
  try {
    const url = new URL(value);
    return url.protocol.replace(/:$/, "");
  } catch {
    return null;
  }
}

const PATH_PARAM_RE = /\{([^{}]+)\}/g;
const COLON_PARAM_RE = /(^|\/):([A-Za-z_][A-Za-z0-9_]*)/g;

/**
 * Substitute `{name}` (OpenAPI style) and `:name` path parameters. Names that
 * are missing from `values` are left untouched so the user can see what is
 * still unfilled. Values are percent-encoded.
 */
export function fillPathParams(path: string, values: Record<string, string>): string {
  const resolved = path.replace(PATH_PARAM_RE, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(values, name) ? encodeURIComponent(values[name]) : match
  );
  return resolved.replace(COLON_PARAM_RE, (match, prefix: string, name: string) =>
    Object.prototype.hasOwnProperty.call(values, name)
      ? `${prefix}${encodeURIComponent(values[name])}`
      : match
  );
}

/** List the distinct path-parameter names referenced by `{name}` or `:name`. */
export function collectPathParams(path: string): string[] {
  const names: string[] = [];
  for (const match of path.matchAll(PATH_PARAM_RE)) names.push(match[1]);
  for (const match of path.matchAll(COLON_PARAM_RE)) names.push(match[2]);
  return Array.from(new Set(names));
}

/**
 * Append the enabled rows of `params` to `base` as a query string, preserving
 * any fragment. Returns `base` unchanged when no row is enabled, and uses `&`
 * when `base` already carries a query.
 */
export function buildRequestUrl(base: string, params: KeyValue[]): string {
  const query = encodeQuery(params);
  if (query === "") return base;

  const hashIndex = base.indexOf("#");
  const hash = hashIndex >= 0 ? base.slice(hashIndex) : "";
  const head = hashIndex >= 0 ? base.slice(0, hashIndex) : base;
  const separator = head.includes("?") ? "&" : "?";
  return `${head}${separator}${query}${hash}`;
}

/** Why a request URL could not be turned into an absolute `http(s)` URL. */
export type UrlProblem = "empty" | "invalid" | "unresolved" | "missingBase" | "baseInvalid";

/** Outcome of {@link resolveUrl}; `ok` narrows to the final absolute URL. */
export type ResolvedUrl = { ok: true; url: string } | { ok: false; problem: UrlProblem };

/**
 * Normalize a base URL for joining: trimmed with trailing slashes removed, so
 * `https://api.example.com/` and `https://api.example.com` behave the same.
 * An empty base stays empty rather than becoming `/`.
 */
export function normalizeBaseUrl(raw: string): string {
  return normalizeUrl(raw).replace(/\/+$/, "");
}

/**
 * Turn a request URL into the absolute URL the engine sends.
 *
 * An absolute `http(s)` URL is used as-is. Anything else is treated as a path
 * relative to `baseUrl` (`/pets`, `pets`, `?id=1`), which is how OpenAPI specs
 * are imported when they declare no `servers`. Leftover `{{var}}` placeholders
 * are reported as `unresolved` so the UI can name them instead of sending a
 * percent-encoded placeholder.
 */
export function resolveUrl(rawUrl: string, baseUrl = ""): ResolvedUrl {
  const url = normalizeUrl(rawUrl);
  if (url === "") return { ok: false, problem: "empty" };
  if (url.includes("{{")) return { ok: false, problem: "unresolved" };

  const scheme = urlScheme(url);
  if (scheme !== null) {
    if (scheme !== "http" && scheme !== "https") return { ok: false, problem: "invalid" };
    return isHttpUrl(url) ? { ok: true, url } : { ok: false, problem: "invalid" };
  }

  const base = normalizeBaseUrl(baseUrl);
  if (base === "") return { ok: false, problem: "missingBase" };
  if (!isHttpUrl(base)) return { ok: false, problem: "baseInvalid" };

  if (url.startsWith("//")) {
    const protocol = base.slice(0, base.indexOf(":"));
    const absolute = `${protocol}:${url}`;
    return isHttpUrl(absolute) ? { ok: true, url: absolute } : { ok: false, problem: "invalid" };
  }

  const joined = url.startsWith("?") ? `${base}${url}` : `${base}/${url.replace(/^\/+/, "")}`;
  return isHttpUrl(joined) ? { ok: true, url: joined } : { ok: false, problem: "invalid" };
}
