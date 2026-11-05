/**
 * Resolve a saved request into the payload the engine sends.
 *
 * Variables come from two layers: the active environment, then the request's
 * own `variables` (later wins). Every template-bearing field — URL, params,
 * headers, body and auth — is interpolated here, so the engine never sees a
 * `{{var}}`. The URL is then made absolute against the environment's
 * `baseUrl` variable, which is what lets imported specs with relative paths be
 * sent unchanged.
 */
import {
  collectVariables,
  mergeVariables,
  resolveTemplate,
  variablesToMap,
} from "@/lib/api-core/template";
import { BASE_URL_VARIABLE } from "@/lib/api-core/request-model";
import type {
  Auth,
  CollectionNode,
  Environment,
  KeyValue,
  RequestBody,
  RequestDef,
  SendRequest,
} from "@/lib/api-core/types";
import { buildRequestUrl, resolveUrl, type UrlProblem } from "@/lib/api-core/url";

/** A request plus environment after interpolation. */
export interface ResolvedRequest {
  /** Payload handed to the engine; its `url` is absolute and template-free. */
  payload: SendRequest;
  /** The URL actually sent, with enabled params appended, for display. */
  finalUrl: string;
  /** Variable names still left as `{{name}}`; empty when fully resolved. */
  missing: string[];
  /** The subset of `missing` that appears in the URL itself. */
  urlMissing: string[];
  /** Why the URL could not be resolved, or `null` when it is usable. */
  problem: UrlProblem | null;
}

/** Resolve `{{var}}` in both halves of every row, keeping enabled flags. */
function resolveRows(rows: KeyValue[], vars: Record<string, string>): KeyValue[] {
  return rows.map((row) => ({
    ...row,
    key: resolveTemplate(row.key, vars),
    value: resolveTemplate(row.value, vars),
  }));
}

function resolveBody(body: RequestBody, vars: Record<string, string>): RequestBody {
  return {
    ...body,
    text: resolveTemplate(body.text, vars),
    rows: resolveRows(body.rows, vars),
    filePaths: { ...body.filePaths },
  };
}

function resolveAuth(auth: Auth, vars: Record<string, string>): Auth {
  return {
    kind: auth.kind,
    token: resolveTemplate(auth.token, vars),
    username: resolveTemplate(auth.username, vars),
    password: resolveTemplate(auth.password, vars),
    apiKeyName: resolveTemplate(auth.apiKeyName, vars),
    apiKeyValue: resolveTemplate(auth.apiKeyValue, vars),
  };
}

/** Every templated field of a request, in the order variables are discovered. */
function requestTexts(request: RequestDef): string[] {
  const texts: string[] = [request.url];
  for (const row of request.params) texts.push(row.key, row.value);
  for (const row of request.headers) texts.push(row.key, row.value);
  texts.push(request.body.text);
  for (const row of request.body.rows) texts.push(row.key, row.value);
  texts.push(
    request.auth.token,
    request.auth.username,
    request.auth.password,
    request.auth.apiKeyName,
    request.auth.apiKeyValue
  );
  return texts;
}

/**
 * Every variable name referenced by a request, defined or not. Dynamic
 * variables (`{{$uuid}}` and friends) are excluded because they never need a
 * value. The editor uses this to show what a request depends on.
 */
export function requestVariableNames(request: RequestDef): string[] {
  const names = new Set<string>();
  for (const text of requestTexts(request)) {
    for (const name of collectVariables(text)) names.add(name);
  }
  return Array.from(names);
}

/**
 * How many requests in a tree reference each variable name. The environment
 * dialog uses this to flag variables nothing refers to yet.
 */
export function countVariableUsage(collections: CollectionNode[]): Map<string, number> {
  const counts = new Map<string, number>();
  const walk = (nodes: CollectionNode[]) => {
    for (const node of nodes) {
      for (const request of node.requests) {
        for (const name of requestVariableNames(request)) {
          counts.set(name, (counts.get(name) ?? 0) + 1);
        }
      }
      walk(node.children);
    }
  };
  walk(collections);
  return counts;
}

/** Variable names left unresolved across every templated field of a request. */
function missingVariables(request: RequestDef, vars: Record<string, string>): string[] {
  return requestVariableNames(request).filter(
    (name) => !Object.prototype.hasOwnProperty.call(vars, name)
  );
}

/**
 * Interpolate and resolve one request. `environment` is the active one, or
 * `null` when the workspace has none. The returned payload is always built, so
 * the UI can show the resolved URL even when it is not sendable; callers must
 * check `problem` and `missing` before sending.
 */
export function resolveRequest(
  request: RequestDef,
  environment: Environment | null
): ResolvedRequest {
  const vars = mergeVariables(
    variablesToMap(environment?.variables ?? []),
    variablesToMap(request.variables)
  );

  const params = resolveRows(request.params, vars);
  const headers = resolveRows(request.headers, vars);
  const body = resolveBody(request.body, vars);
  const auth = resolveAuth(request.auth, vars);

  const url = resolveTemplate(request.url, vars);
  const resolved = resolveUrl(url, vars[BASE_URL_VARIABLE] ?? "");
  const finalUrl = resolved.ok ? buildRequestUrl(resolved.url, params) : "";

  return {
    payload: {
      requestId: request.id,
      method: request.method.trim().toUpperCase(),
      url: resolved.ok ? resolved.url : "",
      params,
      headers,
      body,
      auth,
      timeoutMs: request.timeoutMs,
      followRedirects: request.followRedirects,
    },
    finalUrl,
    missing: missingVariables(request, vars),
    urlMissing: collectVariables(request.url, vars),
    problem: resolved.ok ? null : resolved.problem,
  };
}
