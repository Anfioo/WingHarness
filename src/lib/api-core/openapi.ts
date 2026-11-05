/**
 * OpenAPI 3.0 / Swagger 2.0 → API client import converter.
 *
 * A pure, dependency-light translator: it takes the text of a spec (JSON or
 * YAML) and produces the `ImportResult` the engine's `api_import_apply` command
 * consumes — one collection named after the spec title, one folder per tag, and
 * one request per operation.
 *
 * Supported: OpenAPI 3.0 `servers`/`components` and Swagger 2.0
 * `host`+`basePath`+`schemes`/`definitions`, local `$ref` (with a cycle guard),
 * `allOf` merging, and the bearer / basic / apiKey-in-header auth shapes the
 * model supports.
 *
 * Deliberately out of scope: remote (multi-file / URL) `$ref`, callbacks and
 * webhooks, and OpenAPI 3.1-only semantics (a 3.1 document is parsed as 3.0
 * with a warning).
 */
import { parse as parseYaml } from "yaml";
import { createEmptyAuth, newId } from "@/lib/api-core/request-model";
import type {
  Auth,
  CollectionNode,
  ImportResult,
  KeyValue,
  RequestBody,
  RequestDef,
} from "@/lib/api-core/types";

/** A JSON object with untyped keys — the shape every OpenAPI node arrives as. */
type JsonObject = Record<string, unknown>;

/** Options controlling how imported request URLs are written. */
export interface OpenApiConvertOptions {
  /**
   * Rewrite request URLs to `{{baseUrl}}/path` (default) so switching the
   * workspace's base URL retargets the whole collection. `false` bakes the
   * spec's own server URL into every request instead.
   */
  useBaseUrlVariable?: boolean;
}

/** The folder every operation without a `tags` entry is filed under. */
const DEFAULT_GROUP = "Default";

/** Operation verbs we convert; `trace` and path-item meta keys are ignored. */
const METHODS = ["get", "put", "post", "delete", "options", "head", "patch"] as const;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** RFC 6901 JSON-pointer segment: `~1` is `/`, `~0` is `~`. */
function decodePointerSegment(segment: string): string {
  return segment.replace(/~1/g, "/").replace(/~0/g, "~");
}

function messageOf(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return String(error);
}

/** `base` + `path`, joining with exactly one slash and keeping `{{var}}` intact. */
function joinUrl(base: string, path: string): string {
  if (base === "") return path;
  const trimmedBase = base.replace(/\/+$/, "");
  return `${trimmedBase}${path.startsWith("/") ? path : `/${path}`}`;
}

/** Turn OpenAPI `{name}` path templating into the client's `{{name}}` form. */
function templatePath(path: string): string {
  return path.replace(/\{([^{}]+)\}/g, "{{$1}}");
}

function emptyBody(): RequestBody {
  return { kind: "none", text: "", rows: [], filePaths: {}, rawContentType: "" };
}

/** Parse spec text, preferring JSON and falling back to YAML. */
function parseSpecSource(text: string): JsonObject {
  const trimmed = text.trim();
  if (trimmed === "") throw new Error("The spec document is empty.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    try {
      parsed = parseYaml(trimmed);
    } catch (error) {
      throw new Error(`The spec is not valid JSON or YAML: ${messageOf(error)}`);
    }
  }
  if (!isObject(parsed)) {
    throw new Error("The spec document is not an object.");
  }
  return parsed;
}

/** Which spec generation the document belongs to, or an error when neither. */
function detectVersion(root: JsonObject): 2 | 3 {
  const openapi = asString(root.openapi);
  if (openapi && openapi.startsWith("3")) return 3;
  const swagger = asString(root.swagger);
  if (swagger && swagger.startsWith("2")) return 2;
  throw new Error("Unsupported document: expected an OpenAPI 3.x or Swagger 2.0 specification.");
}

/**
 * Converts one spec object. Stateful only for `$ref` caching and warning
 * de-duplication; every output value is freshly built.
 */
class SpecConverter {
  private readonly root: JsonObject;
  private readonly version: 2 | 3;
  private readonly useBaseUrlVariable: boolean;
  private readonly refCache = new Map<string, JsonObject | null>();
  private readonly warnings = new Set<string>();

  constructor(root: JsonObject, version: 2 | 3, options: OpenApiConvertOptions = {}) {
    this.root = root;
    this.version = version;
    this.useBaseUrlVariable = options.useBaseUrlVariable !== false;
    const openapi = asString(root.openapi);
    if (version === 3 && openapi && !openapi.startsWith("3.0")) {
      this.warn(`OpenAPI ${openapi} is not fully supported; the document was read as OpenAPI 3.0.`);
    }
  }

  convert(): ImportResult {
    const collection: CollectionNode = {
      id: newId(),
      name: this.collectionName(),
      children: [],
      requests: [],
    };
    const folders = new Map<string, CollectionNode>();
    const folderFor = (tag: string): CollectionNode => {
      let folder = folders.get(tag);
      if (!folder) {
        folder = { id: newId(), name: tag, children: [], requests: [] };
        folders.set(tag, folder);
        collection.children.push(folder);
      }
      return folder;
    };

    const base = this.baseUrl();
    const paths = isObject(this.root.paths) ? this.root.paths : {};
    let operations = 0;
    for (const [path, rawItem] of Object.entries(paths)) {
      const pathItem = this.deref(rawItem);
      if (!pathItem) continue;
      for (const method of METHODS) {
        const rawOperation = pathItem[method];
        if (!isObject(rawOperation)) continue;
        const operation = this.deref(rawOperation) ?? rawOperation;
        try {
          const request = this.buildRequest(method.toUpperCase(), path, pathItem, operation, base);
          folderFor(this.tagFor(operation)).requests.push(request);
          operations += 1;
        } catch (error) {
          this.warn(`${method.toUpperCase()} ${path}: ${messageOf(error)}`);
        }
      }
    }
    if (operations === 0) {
      this.warn("The document contains no operations to import.");
    }

    return { collections: [collection], warnings: Array.from(this.warnings), baseUrl: base };
  }

  // --- refs ------------------------------------------------------------------

  private resolveRef(ref: string): JsonObject | null {
    const cached = this.refCache.get(ref);
    if (cached !== undefined) return cached;

    let node: JsonObject | null = null;
    if (ref.startsWith("#/")) {
      const segments = ref.slice(2).split("/").map(decodePointerSegment);
      let cursor: unknown = this.root;
      for (const segment of segments) {
        if (!isObject(cursor)) {
          cursor = undefined;
          break;
        }
        cursor = cursor[segment];
      }
      node = isObject(cursor) ? cursor : null;
    }
    this.refCache.set(ref, node);

    if (node === null) {
      if (ref.startsWith("#/")) this.warn(`Could not resolve $ref "${ref}".`);
      else this.warn(`External $ref "${ref}" is not supported; the reference was skipped.`);
    }
    return node;
  }

  /** Follow a `$ref` chain to a concrete object, guarding against ref cycles. */
  private deref(node: unknown): JsonObject | null {
    let current: unknown = node;
    const guard = new Set<string>();
    while (isObject(current) && typeof current.$ref === "string") {
      const ref = current.$ref;
      if (guard.has(ref)) return null;
      guard.add(ref);
      current = this.resolveRef(ref);
    }
    return isObject(current) ? current : null;
  }

  // --- schemas ---------------------------------------------------------------

  /**
   * Resolve a schema to a concrete object: follow `$ref` (recording it in `seen`
   * so a cycle stops the walk) and flatten `allOf` into one object schema.
   */
  private buildSchema(node: unknown, seen: Set<string>): JsonObject | null {
    if (!isObject(node)) return null;
    if (typeof node.$ref === "string") {
      const ref = node.$ref;
      if (seen.has(ref)) return null;
      const target = this.resolveRef(ref);
      if (!target) return null;
      const next = new Set(seen);
      next.add(ref);
      return this.buildSchema(target, next);
    }
    if (!Array.isArray(node.allOf)) return node;

    const properties: JsonObject = {};
    const required: string[] = [];
    for (const part of node.allOf) {
      const sub = this.buildSchema(part, seen);
      if (!sub) continue;
      if (isObject(sub.properties)) Object.assign(properties, sub.properties);
      for (const name of asArray(sub.required)) {
        if (typeof name === "string") required.push(name);
      }
    }
    if (isObject(node.properties)) Object.assign(properties, node.properties);
    for (const name of asArray(node.required)) {
      if (typeof name === "string") required.push(name);
    }

    const merged: JsonObject = { ...node, type: "object", properties };
    merged.required = Array.from(new Set(required));
    delete merged.allOf;
    return merged;
  }

  /** The `type` of a schema, falling back to structural inference. */
  private schemaType(schema: JsonObject): string | null {
    const type = schema.type;
    if (typeof type === "string") return type;
    if (Array.isArray(type)) {
      const first = type.find((entry) => typeof entry === "string" && entry !== "null");
      if (typeof first === "string") return first;
    }
    if (isObject(schema.properties)) return "object";
    if (schema.items !== undefined) return "array";
    return null;
  }

  /** A representative value for a schema, used for param values and body examples. */
  private exampleFor(node: unknown, seen: Set<string>): unknown {
    if (!isObject(node)) return null;
    // Resolve the ref here (not in `buildSchema`) so the chain is recorded in
    // `seen`; otherwise a self-referential schema would never be cut off.
    if (typeof node.$ref === "string") {
      const ref = node.$ref;
      if (seen.has(ref)) return null;
      const target = this.resolveRef(ref);
      if (!target) return null;
      const next = new Set(seen);
      next.add(ref);
      return this.exampleFor(target, next);
    }

    const schema = this.buildSchema(node, seen);
    if (!schema) return null;

    if (schema.example !== undefined) return schema.example;
    const examples = asArray(schema.examples);
    if (examples.length > 0) {
      const first = examples[0];
      if (isObject(first) && first.value !== undefined) return first.value;
      return first;
    }
    if (schema.default !== undefined) return schema.default;
    const values = asArray(schema.enum);
    if (values.length > 0) return values[0];

    switch (this.schemaType(schema)) {
      case "object": {
        const properties = isObject(schema.properties) ? schema.properties : {};
        const out: JsonObject = {};
        for (const [key, value] of Object.entries(properties)) {
          out[key] = this.exampleFor(value, seen);
        }
        return out;
      }
      case "array": {
        const item = this.exampleFor(schema.items, seen);
        return item === null ? [] : [item];
      }
      case "integer":
      case "number":
        return 0;
      case "boolean":
        return false;
      case "string":
        return this.stringExample(schema);
      default:
        return null;
    }
  }

  /** A format-aware placeholder for a string schema. */
  private stringExample(schema: JsonObject): string {
    switch (asString(schema.format)) {
      case "date-time":
        return "1970-01-01T00:00:00Z";
      case "date":
        return "1970-01-01";
      case "email":
        return "user@example.com";
      case "uri":
      case "url":
        return "https://example.com";
      case "uuid":
        return "00000000-0000-0000-0000-000000000000";
      default:
        return "";
    }
  }

  /** Render an example value as a string for a key/value row. */
  private stringify(value: unknown): string {
    if (value === null || value === undefined) return "";
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    try {
      return JSON.stringify(value);
    } catch {
      return "";
    }
  }

  // --- security --------------------------------------------------------------

  private baseUrl(): string {
    if (this.version === 3) {
      const server = asArray(this.root.servers).find(isObject);
      if (!server) {
        this.warn("No server URL found; set the workspace base URL before sending.");
        return "";
      }
      return this.expandServer(asString(server.url) ?? "", server.variables);
    }
    const host = asString(this.root.host);
    if (!host) {
      this.warn("No host found; set the workspace base URL before sending.");
      return "";
    }
    const basePath = asString(this.root.basePath) ?? "";
    const scheme = asArray(this.root.schemes)
      .map(asString)
      .find((value): value is string => !!value);
    return `${scheme ?? "https"}://${host}${basePath}`;
  }

  /** The request URL: a `{{baseUrl}}` template by default, or the spec's own base. */
  private requestUrl(base: string, path: string): string {
    const templated = templatePath(path);
    return joinUrl(this.useBaseUrlVariable ? "{{baseUrl}}" : base, templated);
  }

  /** Substitute a server template's `{var}` placeholders with their defaults. */
  private expandServer(url: string, variables: unknown): string {
    if (!isObject(variables)) return url;
    return url.replace(/\{([^{}]+)\}/g, (match, name: string) => {
      const variable = variables[name];
      const fallback = isObject(variable) ? asString(variable.default) : null;
      return fallback ?? match;
    });
  }

  private securitySchemes(): JsonObject {
    if (this.version === 3) {
      const components = isObject(this.root.components) ? this.root.components : {};
      return isObject(components.securitySchemes) ? components.securitySchemes : {};
    }
    return isObject(this.root.securityDefinitions) ? this.root.securityDefinitions : {};
  }

  private authFor(operation: JsonObject): Auth {
    const requirement = this.pickSecurity(operation);
    if (!requirement) return createEmptyAuth();
    const name = Object.keys(requirement).find((key) => key !== "");
    if (!name) return createEmptyAuth();

    const scheme = this.deref(this.securitySchemes()[name]);
    if (!scheme) return createEmptyAuth();

    const type = asString(scheme.type);
    if (type === "http") {
      const httpScheme = (asString(scheme.scheme) ?? "").toLowerCase();
      if (httpScheme === "bearer") return buildAuth("bearer");
      if (httpScheme === "basic") return buildAuth("basic");
      this.warn(
        `Security scheme "${name}" uses HTTP ${httpScheme || "?"} — unsupported; the request has no auth.`
      );
      return createEmptyAuth();
    }
    if (type === "apiKey") {
      const location = asString(scheme.in);
      if (location === "header") {
        const auth = buildAuth("apiKey");
        auth.apiKeyName = asString(scheme.name) ?? "";
        return auth;
      }
      this.warn(
        `Security scheme "${name}" sends an API key in "${location ?? "unknown"}" — only headers are supported; the request has no auth.`
      );
      return createEmptyAuth();
    }
    if (type === "basic") return buildAuth("basic");

    this.warn(
      `Security scheme "${name}" (${type ?? "unknown"}) is not supported; the request has no auth.`
    );
    return createEmptyAuth();
  }

  /** The first security requirement of an operation, or the global one. */
  private pickSecurity(operation: JsonObject): JsonObject | null {
    const source = Array.isArray(operation.security)
      ? operation.security
      : asArray(this.root.security);
    const requirement = source.find(isObject);
    return requirement && Object.keys(requirement).length > 0 ? requirement : null;
  }

  // --- operations ------------------------------------------------------------

  private collectionName(): string {
    const info = isObject(this.root.info) ? this.root.info : {};
    const title = asString(info.title)?.trim();
    return title && title !== "" ? title : "Imported API";
  }

  private tagFor(operation: JsonObject): string {
    const tags = asArray(operation.tags)
      .map(asString)
      .filter((tag): tag is string => !!tag && tag.trim() !== "");
    return tags[0]?.trim() ?? DEFAULT_GROUP;
  }

  private operationName(method: string, path: string, operation: JsonObject): string {
    const summary = asString(operation.summary)?.trim();
    if (summary) return summary;
    const operationId = asString(operation.operationId)?.trim();
    if (operationId) return operationId;
    return `${method} ${path}`;
  }

  private collectParameters(pathItem: JsonObject, operation: JsonObject): JsonObject[] {
    const merged = new Map<string, JsonObject>();
    const order: string[] = [];
    for (const source of [pathItem.parameters, operation.parameters]) {
      for (const raw of asArray(source)) {
        const param = this.deref(raw);
        if (!param) continue;
        const name = asString(param.name);
        const location = asString(param.in);
        if (!name || !location) continue;
        const key = `${location}:${name}`;
        if (!merged.has(key)) order.push(key);
        merged.set(key, param);
      }
    }
    return order.map((key) => merged.get(key)!);
  }

  private paramValue(param: JsonObject): string {
    const source = this.version === 3 ? (param.schema ?? {}) : param;
    // OpenAPI 3 puts `example` on the parameter object itself as often as on
    // its schema; prefer the explicit one over a generated placeholder.
    if (this.version === 3 && param.example !== undefined) {
      return this.stringify(param.example);
    }
    return this.stringify(this.exampleFor(source, new Set()));
  }

  /**
   * The value the spec itself supplies for a parameter, or `""` when it only
   * has a schema type. Generated placeholders such as `0` are deliberately
   * excluded: a path variable seeded with them would look like a real id.
   */
  private explicitParamValue(param: JsonObject): string {
    const schema = this.version === 3 ? this.deref(param.schema) : this.deref(param);
    const source = schema ?? {};
    const candidates = [param.example, source.example, source.default];
    const enums = asArray(source.enum);
    if (enums.length > 0) candidates.push(enums[0]);
    for (const value of candidates) {
      if (value !== undefined) return this.stringify(value);
    }
    return "";
  }

  private buildRequest(
    method: string,
    path: string,
    pathItem: JsonObject,
    operation: JsonObject,
    base: string
  ): RequestDef {
    const parameters = this.collectParameters(pathItem, operation);
    const params: KeyValue[] = [];
    const headers: KeyValue[] = [];
    const variables: KeyValue[] = [];
    for (const param of parameters) {
      const location = asString(param.in);
      const name = asString(param.name) ?? "";
      if (name === "") continue;
      if (location === "query")
        params.push({ key: name, value: this.paramValue(param), enabled: true });
      else if (location === "header")
        headers.push({ key: name, value: this.paramValue(param), enabled: true });
      else if (location === "path") {
        // Only seed a variable when the spec gives a usable example; an empty
        // one is better left unresolved so the editor names it before sending.
        const value = this.explicitParamValue(param);
        if (value !== "") variables.push({ key: name, value, enabled: true });
      }
    }

    return {
      id: newId(),
      name: this.operationName(method, path, operation),
      method,
      url: this.requestUrl(base, path),
      params,
      headers,
      body: this.buildBody(operation, parameters),
      auth: this.authFor(operation),
      variables,
      timeoutMs: null,
      followRedirects: null,
    };
  }

  private buildBody(operation: JsonObject, parameters: JsonObject[]): RequestBody {
    if (this.version === 2) return this.buildSwaggerBody(operation, parameters);

    const requestBody = this.deref(operation.requestBody);
    if (!requestBody || !isObject(requestBody.content)) return emptyBody();
    const content = requestBody.content;
    const mediaType = this.pickContentType(Object.keys(content));
    if (!mediaType) return emptyBody();
    const media = isObject(content[mediaType]) ? content[mediaType] : {};
    return this.bodyFromContent(mediaType, media.schema);
  }

  private buildSwaggerBody(operation: JsonObject, parameters: JsonObject[]): RequestBody {
    const consumes = this.consumes(operation);
    const bodyParam = parameters.find((param) => asString(param.in) === "body");
    if (bodyParam) {
      const mediaType =
        consumes.find((value) => value.includes("json")) ?? consumes[0] ?? "application/json";
      return this.bodyFromContent(mediaType, bodyParam.schema);
    }
    const formParams = parameters.filter((param) => asString(param.in) === "formData");
    if (formParams.length > 0) {
      const multipart = consumes.includes("multipart/form-data");
      const rows: KeyValue[] = formParams.map((param) => ({
        key: asString(param.name) ?? "",
        value: this.paramValue(param),
        enabled: true,
      }));
      return {
        kind: multipart ? "multipart" : "form",
        text: "",
        rows,
        filePaths: {},
        rawContentType: multipart ? "multipart/form-data" : "application/x-www-form-urlencoded",
      };
    }
    return emptyBody();
  }

  /** The `consumes` list of a Swagger 2.0 operation, falling back to the root's. */
  private consumes(operation: JsonObject): string[] {
    const source = asArray(operation.consumes).length > 0 ? operation.consumes : this.root.consumes;
    return asArray(source)
      .map(asString)
      .filter((value): value is string => !!value);
  }

  private bodyFromContent(mediaType: string, schema: unknown): RequestBody {
    if (mediaType.includes("json")) {
      const example = this.exampleFor(schema, new Set());
      return {
        kind: "json",
        text: example === null ? "" : JSON.stringify(example, null, 2),
        rows: [],
        filePaths: {},
        rawContentType: "application/json",
      };
    }
    if (mediaType === "application/x-www-form-urlencoded") return this.formBody(schema, "form");
    if (mediaType === "multipart/form-data") return this.formBody(schema, "multipart");

    const example = this.exampleFor(schema, new Set());
    const text =
      typeof example === "string"
        ? example
        : example === null
          ? ""
          : JSON.stringify(example, null, 2);
    return { kind: "raw", text, rows: [], filePaths: {}, rawContentType: mediaType };
  }

  private formBody(schema: unknown, kind: "form" | "multipart"): RequestBody {
    const resolved = this.buildSchema(schema, new Set());
    const properties = resolved && isObject(resolved.properties) ? resolved.properties : {};

    const rows: KeyValue[] = [];
    for (const [key, value] of Object.entries(properties)) {
      rows.push({ key, value: this.stringify(this.exampleFor(value, new Set())), enabled: true });
    }
    const example = resolved ? resolved.example : undefined;
    if (rows.length === 0 && isObject(example)) {
      for (const [key, value] of Object.entries(example)) {
        rows.push({ key, value: this.stringify(value), enabled: true });
      }
    }

    return {
      kind,
      text: "",
      rows,
      filePaths: {},
      rawContentType: kind === "form" ? "application/x-www-form-urlencoded" : "multipart/form-data",
    };
  }

  /** Pick a request body content type: JSON first, then form kinds, then any. */
  private pickContentType(keys: string[]): string | null {
    if (keys.length === 0) return null;
    return (
      keys.find((key) => key === "application/json") ??
      keys.find((key) => key.includes("json")) ??
      keys.find((key) => key === "application/x-www-form-urlencoded") ??
      keys.find((key) => key === "multipart/form-data") ??
      keys[0]
    );
  }

  private warn(message: string): void {
    this.warnings.add(message);
  }
}

/** A fresh `Auth` set to `kind` with every value field at its default. */
function buildAuth(kind: Auth["kind"]): Auth {
  const auth = createEmptyAuth();
  auth.kind = kind;
  return auth;
}

/**
 * Convert the text of an OpenAPI 3.x or Swagger 2.0 document into an
 * `ImportResult`. Throws an `Error` with an English message when the text does
 * not parse or is not a supported spec.
 */
export function parseOpenApiDocument(
  text: string,
  options: OpenApiConvertOptions = {}
): ImportResult {
  const root = parseSpecSource(text);
  const version = detectVersion(root);
  return new SpecConverter(root, version, options).convert();
}

/** Convert an already-parsed spec object; exported for callers that hold one. */
export function convertOpenApiSpec(
  spec: unknown,
  options: OpenApiConvertOptions = {}
): ImportResult {
  if (!isObject(spec)) throw new Error("The spec document is not an object.");
  const version = detectVersion(spec);
  return new SpecConverter(spec, version, options).convert();
}
