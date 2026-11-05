import type { ConflictBlock } from "@/lib/git-core";

/**
 * Format-aware auto-merge.
 *
 * Every strategy follows one rule: merge only when the two sides are provably
 * disjoint. If anything is ambiguous, overlaps, or fails to parse, the strategy
 * returns null and the caller keeps the conflict markers untouched. The module
 * is pure: no React, no I/O, no side effects.
 */

export type Side = readonly string[];

interface Entry {
  path: string;
  text: string;
}

const LOCKFILES = new Set([
  "cargo.lock",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "poetry.lock",
  "pipfile.lock",
  "composer.lock",
  "gemfile.lock",
  "bun.lock",
  "bun.lockb",
]);

function stripCr(line: string): string {
  return line.replace(/\r$/, "");
}

function basename(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Union entries by path; a shared path with different text means "give up". */
function mergeEntries(a: readonly Entry[], b: readonly Entry[], sort: boolean): Entry[] | null {
  const seen = new Map<string, string>();
  for (const entry of a) seen.set(entry.path, entry.text);
  const out: Entry[] = [...a];
  for (const entry of b) {
    const known = seen.get(entry.path);
    if (known === undefined) {
      out.push(entry);
      seen.set(entry.path, entry.text);
      continue;
    }
    if (known !== entry.text) return null;
  }
  if (!sort) return out;
  return [...out].sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
}

function toLines(entries: readonly Entry[]): string[] {
  return entries.map((entry) => entry.text);
}

function toChunkLines(entries: readonly Entry[]): string[] {
  return entries
    .map((entry) => entry.text)
    .join("\n")
    .split("\n");
}

// --- JSON -----------------------------------------------------------------

function parseJson(lines: Side): { ok: true; value: unknown } | { ok: false } {
  const text = lines.join("\n").trim();
  if (text === "") return { ok: false };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

function deepMerge(a: unknown, b: unknown): { ok: true; value: unknown } | { ok: false } {
  if (deepEqual(a, b)) return { ok: true, value: a };
  if (isPlainObject(a) && isPlainObject(b)) {
    const out: Record<string, unknown> = { ...a };
    for (const key of Object.keys(b)) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") {
        return { ok: false };
      }
      if (!(key in a)) {
        out[key] = b[key];
        continue;
      }
      const merged = deepMerge(a[key], b[key]);
      if (!merged.ok) return { ok: false };
      out[key] = merged.value;
    }
    return { ok: true, value: out };
  }
  return { ok: false };
}

function mergeJson(a: Side, b: Side): string[] | null {
  const parsedA = parseJson(a);
  const parsedB = parseJson(b);
  if (!parsedA.ok || !parsedB.ok) return null;
  const merged = deepMerge(parsedA.value, parsedB.value);
  if (!merged.ok) return null;
  const indent = [...a, ...b].some((line) => /^\t/.test(line)) ? "\t" : "  ";
  return JSON.stringify(merged.value, null, indent).split("\n");
}

// --- YAML -----------------------------------------------------------------

function yamlEntries(lines: Side): Entry[] {
  const stack: { indent: number; key: string }[] = [];
  const out: Entry[] = [];
  let anon = 0;
  for (const raw of lines) {
    const content = raw.trimStart();
    if (raw.trim() === "") {
      out.push({ path: `~b${anon++}`, text: raw });
      continue;
    }
    if (content.startsWith("#")) {
      out.push({ path: `~c${anon++}`, text: raw });
      continue;
    }
    const indent = raw.length - content.length;
    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop();
    if (content.startsWith("- ") || content === "-") {
      const parent = stack.map((item) => item.key).join(".");
      out.push({ path: `${parent}.list[${anon++}]`, text: raw });
      continue;
    }
    const match = content.match(/^([^:\s][^:]*):(.*)$/);
    const key = match ? match[1].trim() : "";
    if (!match || key === "") {
      const parent = stack.map((item) => item.key).join(".");
      out.push({ path: `${parent}|${anon++}`, text: raw });
      continue;
    }
    stack.push({ indent, key });
    out.push({ path: stack.map((item) => item.key).join("."), text: raw });
  }
  return out;
}

function mergeYaml(a: Side, b: Side): string[] | null {
  const merged = mergeEntries(yamlEntries(a), yamlEntries(b), true);
  if (!merged) return null;
  return toLines(merged);
}

// --- CSS / SCSS / Less ----------------------------------------------------

function cssEntries(lines: Side): Entry[] | null {
  const out: Entry[] = [];
  let buffer: string[] = [];
  let selector = "";
  let depth = 0;
  let inBlock = false;
  let anon = 0;
  for (const raw of lines) {
    buffer.push(raw);
    const opens = (raw.match(/\{/g) ?? []).length;
    const closes = (raw.match(/\}/g) ?? []).length;
    if (!inBlock) {
      if (opens === 0) continue;
      selector = buffer.join("\n").split("{")[0].trim();
      depth = opens - closes;
      if (depth <= 0) {
        out.push({ path: selector || `~block${anon++}`, text: buffer.join("\n") });
        buffer = [];
        selector = "";
        depth = 0;
        continue;
      }
      inBlock = true;
      continue;
    }
    depth += opens - closes;
    if (depth <= 0) {
      out.push({ path: selector || `~block${anon++}`, text: buffer.join("\n") });
      buffer = [];
      selector = "";
      depth = 0;
      inBlock = false;
    }
  }
  if (buffer.length > 0) {
    if (inBlock) return null;
    out.push({ path: `~tail${anon++}`, text: buffer.join("\n") });
  }
  return out;
}

function mergeCss(a: Side, b: Side): string[] | null {
  const entriesA = cssEntries(a);
  const entriesB = cssEntries(b);
  if (!entriesA || !entriesB) return null;
  const merged = mergeEntries(entriesA, entriesB, false);
  if (!merged) return null;
  return toChunkLines(merged);
}

// --- import / require blocks ----------------------------------------------

const IMPORT_RE =
  /^\s*(?:import\b|export\b[^;]*\bfrom\b|(?:const|let|var)\b[^=]*=\s*require\(|require\()/;

function looksLikeImports(lines: Side): boolean {
  const nonEmpty = lines.filter((line) => line.trim() !== "");
  if (nonEmpty.length === 0) return false;
  return nonEmpty.every((line) => IMPORT_RE.test(line));
}

function specifierOf(line: string): string | null {
  const from = line.match(/from\s+['"]([^'"]+)['"]/);
  if (from) return from[1];
  const require = line.match(/require\(\s*['"]([^'"]+)['"]\s*\)/);
  if (require) return require[1];
  const bare = line.match(/^\s*import\s+['"]([^'"]+)['"]/);
  if (bare) return bare[1];
  return null;
}

function mergeImports(a: Side, b: Side): string[] | null {
  const collect = (lines: Side): Entry[] | null => {
    const out: Entry[] = [];
    for (const line of lines) {
      if (line.trim() === "") continue;
      const spec = specifierOf(line);
      if (spec === null) return null;
      out.push({ path: spec, text: line });
    }
    return out;
  };
  const entriesA = collect(a);
  const entriesB = collect(b);
  if (!entriesA || !entriesB) return null;
  const merged = mergeEntries(entriesA, entriesB, true);
  if (!merged) return null;
  return toLines(merged);
}

// --- TOML (Cargo.toml, pyproject.toml, ...) -------------------------------

function tomlEntries(lines: Side): Entry[] {
  const out: Entry[] = [];
  let section = "";
  let anon = 0;
  for (const raw of lines) {
    const text = raw.trim();
    if (text === "") {
      out.push({ path: `~b${anon++}`, text: raw });
      continue;
    }
    if (text.startsWith("#")) {
      out.push({ path: `~c${anon++}`, text: raw });
      continue;
    }
    const header = text.match(/^\[([^\]]+)\]$/);
    if (header) {
      section = header[1].trim();
      out.push({ path: `[${section}]`, text: raw });
      continue;
    }
    const pair = text.match(/^([A-Za-z0-9_.\-"']+)\s*=/);
    if (pair) {
      out.push({ path: `${section}.${pair[1]}`, text: raw });
      continue;
    }
    out.push({ path: `~x${anon++}`, text: raw });
  }
  return out;
}

function mergeToml(a: Side, b: Side): string[] | null {
  const merged = mergeEntries(tomlEntries(a), tomlEntries(b), true);
  if (!merged) return null;
  return toLines(merged);
}

// --- XML (pom.xml, ...) ---------------------------------------------------

function xmlEntries(lines: Side): Entry[] {
  const stack: string[] = [];
  const out: Entry[] = [];
  let anon = 0;
  for (const raw of lines) {
    const text = raw.trim();
    if (text === "") {
      out.push({ path: `~b${anon++}`, text: raw });
      continue;
    }
    if (text.startsWith("<!--") || text.startsWith("<?") || text.startsWith("<!")) {
      out.push({ path: `~m${anon++}`, text: raw });
      continue;
    }
    const close = text.match(/^<\/([\w:.-]+)>/);
    if (close) {
      const at = stack.lastIndexOf(close[1]);
      if (at >= 0) stack.length = at;
      out.push({ path: `~close${anon++}`, text: raw });
      continue;
    }
    const leaf = text.match(/^<([\w:.-]+)(?:\s[^>]*)?>[^<]*<\/\1>$/);
    if (leaf) {
      out.push({ path: `${stack.join(".")}.${leaf[1]}`, text: raw });
      continue;
    }
    const open = text.match(/^<([\w:.-]+)(?:\s[^>]*)?>$/);
    if (open) {
      stack.push(open[1]);
      out.push({ path: stack.join("."), text: raw });
      continue;
    }
    out.push({ path: `${stack.join(".")}|${anon++}`, text: raw });
  }
  return out;
}

function mergeXml(a: Side, b: Side): string[] | null {
  const entriesA = xmlEntries(a);
  const entriesB = xmlEntries(b);
  // Any repeated path in a single side makes position-based keying unsafe.
  const count = new Map<string, number>();
  for (const entry of [...entriesA, ...entriesB]) {
    const next = (count.get(entry.path) ?? 0) + 1;
    if (next > 1 && !entry.path.startsWith("~")) return null;
    count.set(entry.path, next);
  }
  const merged = mergeEntries(entriesA, entriesB, false);
  if (!merged) return null;
  return toLines(merged);
}

// --- Gradle ---------------------------------------------------------------

function gradleEntries(lines: Side): Entry[] {
  const stack: string[] = [];
  const out: Entry[] = [];
  let anon = 0;
  for (const raw of lines) {
    const text = raw.trim();
    if (text === "") {
      out.push({ path: `~b${anon++}`, text: raw });
      continue;
    }
    if (text.startsWith("//")) {
      out.push({ path: `~c${anon++}`, text: raw });
      continue;
    }
    if (text === "}") {
      stack.pop();
      out.push({ path: `~close${anon++}`, text: raw });
      continue;
    }
    const head = text.match(/^([A-Za-z_][\w.]*)\s*(?:\(|\{|=)/);
    if (head && text.endsWith("{")) {
      stack.push(head[1]);
      out.push({ path: stack.join("."), text: raw });
      continue;
    }
    if (head) {
      out.push({ path: `${stack.join(".")}.${head[1]}`, text: raw });
      continue;
    }
    out.push({ path: `${stack.join(".")}|${anon++}`, text: raw });
  }
  return out;
}

function mergeGradle(a: Side, b: Side): string[] | null {
  const merged = mergeEntries(gradleEntries(a), gradleEntries(b), true);
  if (!merged) return null;
  return toLines(merged);
}

// --- Dockerfile -----------------------------------------------------------

function dockerEntries(lines: Side): Entry[] {
  const out: Entry[] = [];
  let anon = 0;
  for (const raw of lines) {
    const text = raw.trim();
    if (text === "") {
      out.push({ path: `~b${anon++}`, text: raw });
      continue;
    }
    if (text.startsWith("#")) {
      out.push({ path: `~c${anon++}`, text: raw });
      continue;
    }
    const instruction = text.match(/^([A-Za-z]+)\s+(.*)$/);
    if (instruction) {
      out.push({ path: instruction[1].toUpperCase(), text: raw });
      continue;
    }
    out.push({ path: `~x${anon++}`, text: raw });
  }
  return out;
}

function mergeDockerfile(a: Side, b: Side): string[] | null {
  const merged = mergeEntries(dockerEntries(a), dockerEntries(b), false);
  if (!merged) return null;
  return toLines(merged);
}

// --- .env -----------------------------------------------------------------

function envKey(line: string): string | null {
  const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
  return match ? match[1] : null;
}

function mergeEnv(a: Side, b: Side): string[] | null {
  const collect = (lines: Side, mark: string): Entry[] | null => {
    const out: Entry[] = [];
    let anon = 0;
    for (const raw of lines) {
      const text = raw.trim();
      if (text === "" || text.startsWith("#")) {
        out.push({ path: `~${mark}${anon++}`, text: raw });
        continue;
      }
      const key = envKey(raw);
      if (key === null) return null;
      out.push({ path: key, text: raw });
    }
    return out;
  };
  const entriesA = collect(a, "a");
  const entriesB = collect(b, "b");
  if (!entriesA || !entriesB) return null;
  const merged = mergeEntries(entriesA, entriesB, false);
  if (!merged) return null;
  return toLines(merged);
}

// --- dispatch -------------------------------------------------------------

/**
 * Attempt a format-aware merge of one conflict block.
 * Returns the merged lines, or null when the merge is not provably safe.
 */
export function mergeConflicts(file: string, block: ConflictBlock): string[] | null {
  const a = block.current.map(stripCr);
  const b = block.incoming.map(stripCr);
  const name = basename(file).toLowerCase();
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot) : "";

  try {
    if (LOCKFILES.has(name)) return null;
    if (name === "dockerfile" || name.startsWith("dockerfile.")) return mergeDockerfile(a, b);
    if (
      name === "docker-compose.yml" ||
      name === "docker-compose.yaml" ||
      name === "compose.yml" ||
      name === "compose.yaml"
    ) {
      return mergeYaml(a, b);
    }
    if (ext === ".toml") return mergeToml(a, b);
    if (name === "pom.xml") return mergeXml(a, b);
    if (name === "build.gradle" || name === "build.gradle.kts") return mergeGradle(a, b);
    if (ext === ".json") return mergeJson(a, b);
    if (ext === ".yaml" || ext === ".yml") return mergeYaml(a, b);
    if (ext === ".css" || ext === ".scss" || ext === ".less") return mergeCss(a, b);
    if (name === ".env" || name.startsWith(".env.")) return mergeEnv(a, b);
    if (looksLikeImports(a) && looksLikeImports(b)) return mergeImports(a, b);
    return null;
  } catch {
    return null;
  }
}
