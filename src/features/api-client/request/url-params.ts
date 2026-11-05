/**
 * URL ↔ query-param helpers for the request editor.
 *
 * The engine appends `params` to `url` (`builder.query(...)`), so the persisted
 * `RequestDef.url` is kept query-free and the query lives in `params`. These
 * helpers let the URL field show the full URL and round-trip both ways without
 * duplicating the query on send.
 */
import { encodeQuery, parseQueryString } from "@/lib/api-core/url";
import type { KeyValue } from "@/lib/api-core/types";

export interface SplitUrl {
  /** Everything before the first `?` (and before any `#`). */
  base: string;
  /** The raw query text after the first `?`, without the `?`. */
  query: string;
  /** The `#…` fragment, including the `#`, or `""`. */
  fragment: string;
  /** Whether the input contained a `?`. */
  hasQuery: boolean;
}

/** Split a URL into its base, query and fragment. Only the first `?`/`#` count. */
export function splitUrl(url: string): SplitUrl {
  const hashIndex = url.indexOf("#");
  const fragment = hashIndex >= 0 ? url.slice(hashIndex) : "";
  const head = hashIndex >= 0 ? url.slice(0, hashIndex) : url;
  const queryIndex = head.indexOf("?");
  const hasQuery = queryIndex >= 0;
  return {
    base: hasQuery ? head.slice(0, queryIndex) : head,
    query: hasQuery ? head.slice(queryIndex + 1) : "",
    fragment,
    hasQuery,
  };
}

/** Parse the enabled query rows out of a URL's query string. */
export function paramsFromUrl(url: string): KeyValue[] {
  return parseQueryString(splitUrl(url).query);
}

/** Rebuild a URL with `params` as its (encoded) query string, keeping the fragment. */
export function urlWithParams(url: string, params: KeyValue[]): string {
  const { base, fragment } = splitUrl(url);
  const query = encodeQuery(params);
  return query === "" ? `${base}${fragment}` : `${base}?${query}${fragment}`;
}

/** The full URL to display: a URL that already carries a query is shown as-is. */
export function displayUrl(url: string, params: KeyValue[]): string {
  return splitUrl(url).hasQuery ? url : urlWithParams(url, params);
}
