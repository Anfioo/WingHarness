/**
 * `{{var}}` template resolution for the API client.
 *
 * Supports user variables from the active environment plus a small set of
 * dynamic variables (`{{$uuid}}`, `{{$timestamp}}`, `{{$isoTimestamp}}`,
 * `{{$randomInt}}`). Unknown variables are left verbatim so the UI can flag
 * them, and a literal placeholder can be produced with an escaped `\{{`.
 */

/** A dynamic variable resolved at call time rather than from the environment. */
export type DynamicVariable = "$uuid" | "$timestamp" | "$isoTimestamp" | "$randomInt";

const DYNAMIC_VARIABLES: readonly DynamicVariable[] = [
  "$uuid",
  "$timestamp",
  "$isoTimestamp",
  "$randomInt",
];

/**
 * Matches either an escaped opening (`\{{`, captured in group 1) or a whole
 * placeholder (`{{name}}`, with `name` in group 3). Group 2 is the full
 * placeholder for convenience.
 */
const VARIABLE_RE = /\\(\{\{)|(\{\{([^{}]*)\}\})/g;

/** True when `name` is one of the built-in dynamic variables. */
export function isDynamicVariable(name: string): name is DynamicVariable {
  return (DYNAMIC_VARIABLES as readonly string[]).includes(name);
}

/** RFC 4122 v4 UUID, falling back to a hand-rolled generator when `crypto` is absent. */
function generateUuid(): string {
  const cryptoObj: Crypto | undefined = globalThis.crypto;
  if (cryptoObj && typeof cryptoObj.randomUUID === "function") {
    return cryptoObj.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
    const random = (Math.random() * 16) | 0;
    const value = char === "x" ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}

/** Compute the value of a dynamic variable at the current instant. */
export function dynamicValue(name: DynamicVariable): string {
  switch (name) {
    case "$uuid":
      return generateUuid();
    case "$timestamp":
      return String(Math.floor(Date.now() / 1000));
    case "$isoTimestamp":
      return new Date().toISOString();
    case "$randomInt":
      // Inclusive 0–1000, mirroring Postman's `$randomInt`.
      return String(Math.floor(Math.random() * 1001));
  }
}

/**
 * Replace placeholders in `text`. User variables are looked up in `vars`
 * (missing keys are left as `{{name}}`); dynamic variables are computed.
 * `\{{` yields a literal `{{`.
 */
export function resolveTemplate(text: string, vars: Record<string, string>): string {
  return text.replace(
    VARIABLE_RE,
    (
      match,
      escaped: string | undefined,
      _whole: string | undefined,
      rawName: string | undefined
    ) => {
      if (escaped !== undefined) return "{{";
      const name = (rawName ?? "").trim();
      if (name === "") return match;
      if (isDynamicVariable(name)) return dynamicValue(name);
      if (Object.prototype.hasOwnProperty.call(vars, name)) return vars[name];
      return match;
    }
  );
}

/**
 * List the distinct variable names referenced by `text`, in encounter order,
 * excluding the built-in dynamic variables. When `vars` is supplied, names that
 * are already defined are filtered out, so the result is the still-unresolved
 * set the UI should surface.
 */
export function collectVariables(text: string, vars?: Record<string, string>): string[] {
  const names: string[] = [];
  for (const match of text.matchAll(VARIABLE_RE)) {
    if (match[1] !== undefined) continue; // escaped, not a variable
    const name = (match[3] ?? "").trim();
    if (name === "" || isDynamicVariable(name)) continue;
    if (vars && Object.prototype.hasOwnProperty.call(vars, name)) continue;
    names.push(name);
  }
  return Array.from(new Set(names));
}

/** True when resolving `text` against `vars` would leave any placeholder behind. */
export function hasUnresolvedVariables(text: string, vars: Record<string, string>): boolean {
  return collectVariables(text, vars).length > 0;
}

/** Turn a `KeyValue`-shaped variable list into the map `resolveTemplate` expects. */
export function variablesToMap(
  rows: { key: string; value: string; enabled: boolean }[]
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const row of rows) {
    if (row.enabled && row.key !== "") map[row.key] = row.value;
  }
  return map;
}

/**
 * Merge variable maps left to right; later layers win. Used to stack the active
 * environment's variables under the request's own variables, so a request can
 * override an environment value without mutating it.
 */
export function mergeVariables(...layers: Record<string, string>[]): Record<string, string> {
  return Object.assign({}, ...layers);
}
