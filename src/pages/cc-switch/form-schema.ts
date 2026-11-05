/// 各应用供应商表单的字段定义与 settings_config 双向转换。

import type { AppId, Provider } from "@/commands/services/ccs/types";

/// 表单里的通用可编辑值（简单字段）。
export interface FormValues {
  providerId?: string;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  smallModel?: string;
  wireApi?: string;
  authType?: string;
}

export type FieldType = "text" | "password" | "select";

export interface FieldDef {
  /// 对应 FormValues 的键。
  key: keyof FormValues;
  label: string;
  type: FieldType;
  placeholder?: string;
  required?: boolean;
  options?: { value: string; label: string }[];
}

export interface AppFormSchema {
  fields: FieldDef[];
  /// 是否提供高级 JSON 编辑（恒为 true，保留字段以便扩展）。
  allowAdvanced: boolean;
  /// 表单值 → settings_config。
  toSettings: (values: FormValues, name: string) => Record<string, unknown>;
  /// settings_config → 表单值。
  fromSettings: (settings: Record<string, unknown>) => FormValues;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

/// 沿 path 取值。
function getPath(obj: unknown, path: string[]): unknown {
  let cur: unknown = obj;
  for (const key of path) {
    if (cur && typeof cur === "object") {
      cur = (cur as Record<string, unknown>)[key];
    } else {
      return undefined;
    }
  }
  return cur;
}

const WIRE_API_OPTIONS = [
  { value: "responses", label: "Responses API" },
  { value: "chat", label: "Chat Completions" },
];

const AUTH_TYPE_OPTIONS = [
  { value: "gemini-api-key", label: "Gemini API Key" },
  { value: "oauth-personal", label: "OAuth（个人账号）" },
  { value: "oauth-plan", label: "OAuth（付费套餐）" },
  { value: "vertex-ai", label: "Vertex AI" },
];

export const FORM_SCHEMAS: Record<AppId, AppFormSchema> = {
  // ---------------------------------------------------------------- Claude
  claude: {
    allowAdvanced: true,
    fields: [
      { key: "baseUrl", label: "Base URL", type: "text", placeholder: "https://api.example.com" },
      { key: "apiKey", label: "API Key / Token", type: "password" },
      { key: "model", label: "主模型", type: "text", placeholder: "claude-sonnet-4" },
      { key: "smallModel", label: "轻量模型", type: "text", placeholder: "claude-haiku-4" },
    ],
    toSettings: (v) => {
      const env: Record<string, unknown> = {};
      if (v.baseUrl) env.ANTHROPIC_BASE_URL = v.baseUrl;
      if (v.apiKey) env.ANTHROPIC_AUTH_TOKEN = v.apiKey;
      if (v.model) env.ANTHROPIC_MODEL = v.model;
      if (v.smallModel) env.ANTHROPIC_SMALL_FAST_MODEL = v.smallModel;
      return { env };
    },
    fromSettings: (s) => ({
      baseUrl: str(getPath(s, ["env", "ANTHROPIC_BASE_URL"])),
      apiKey:
        str(getPath(s, ["env", "ANTHROPIC_AUTH_TOKEN"])) ??
        str(getPath(s, ["env", "ANTHROPIC_API_KEY"])),
      model: str(getPath(s, ["env", "ANTHROPIC_MODEL"])),
      smallModel: str(getPath(s, ["env", "ANTHROPIC_SMALL_FAST_MODEL"])),
    }),
  },

  // ---------------------------------------------------------------- Codex
  codex: {
    allowAdvanced: true,
    fields: [
      { key: "model", label: "模型", type: "text", placeholder: "gpt-5" },
      { key: "baseUrl", label: "Base URL", type: "text" },
      { key: "apiKey", label: "API Key", type: "password" },
      { key: "wireApi", label: "Wire API", type: "select", options: WIRE_API_OPTIONS },
    ],
    toSettings: (v, name) => {
      const custom: Record<string, unknown> = { name };
      if (v.baseUrl) custom.base_url = v.baseUrl;
      if (v.apiKey) custom.experimental_bearer_token = v.apiKey;
      custom.wire_api = v.wireApi ?? "responses";
      const out: Record<string, unknown> = {
        model_provider: "custom",
        model_providers: { custom },
      };
      if (v.model) out.model = v.model;
      return out;
    },
    fromSettings: (s) => ({
      model: str(getPath(s, ["model"])),
      baseUrl: str(getPath(s, ["model_providers", "custom", "base_url"])),
      apiKey: str(getPath(s, ["model_providers", "custom", "experimental_bearer_token"])),
      wireApi: str(getPath(s, ["model_providers", "custom", "wire_api"])),
    }),
  },

  // ---------------------------------------------------------------- Gemini
  gemini: {
    allowAdvanced: true,
    fields: [
      { key: "baseUrl", label: "Base URL", type: "text" },
      { key: "apiKey", label: "API Key", type: "password" },
      { key: "model", label: "模型", type: "text", placeholder: "gemini-2.5-pro" },
      { key: "authType", label: "认证类型", type: "select", options: AUTH_TYPE_OPTIONS },
    ],
    toSettings: (v) => {
      const env: Record<string, unknown> = {};
      if (v.baseUrl) env.GOOGLE_GEMINI_BASE_URL = v.baseUrl;
      if (v.apiKey) env.GEMINI_API_KEY = v.apiKey;
      if (v.model) env.GEMINI_MODEL = v.model;
      const out: Record<string, unknown> = {
        env,
        authType: v.authType ?? "gemini-api-key",
      };
      if (v.model) out.model = { name: v.model };
      return out;
    },
    fromSettings: (s) => ({
      baseUrl: str(getPath(s, ["env", "GOOGLE_GEMINI_BASE_URL"])),
      apiKey: str(getPath(s, ["env", "GEMINI_API_KEY"])),
      model: str(getPath(s, ["env", "GEMINI_MODEL"])) ?? str(getPath(s, ["model", "name"])),
      authType: str(getPath(s, ["authType"])),
    }),
  },

  // ---------------------------------------------------------------- Grok
  grokbuild: {
    allowAdvanced: true,
    fields: [
      { key: "model", label: "模型 / 表名", type: "text" },
      { key: "baseUrl", label: "Base URL", type: "text" },
      { key: "apiKey", label: "API Key", type: "password" },
    ],
    toSettings: (v) => {
      const id = v.model ?? "custom";
      const table: Record<string, unknown> = { model: id };
      if (v.baseUrl) table.base_url = v.baseUrl;
      if (v.apiKey) table.api_key = v.apiKey;
      return {
        models: { default: id },
        model: { [id]: table },
      };
    },
    fromSettings: (s) => {
      const defaultId = str(getPath(s, ["models", "default"]));
      return {
        model: defaultId,
        baseUrl: str(getPath(s, ["model", defaultId ?? "", "base_url"])),
        apiKey: str(getPath(s, ["model", defaultId ?? "", "api_key"])),
      };
    },
  },

  // ---------------------------------------------------------------- OpenCode
  opencode: {
    allowAdvanced: true,
    fields: [
      { key: "providerId", label: "Provider ID", type: "text", placeholder: "my-provider" },
      { key: "baseUrl", label: "Base URL", type: "text" },
      { key: "apiKey", label: "API Key", type: "password" },
      { key: "model", label: "模型", type: "text" },
    ],
    toSettings: (v) => {
      const out: Record<string, unknown> = {
        providerId: v.providerId ?? "custom",
        npm: "@ai-sdk/openai-compatible",
      };
      if (v.baseUrl) out.baseURL = v.baseUrl;
      if (v.apiKey) out.apiKey = v.apiKey;
      if (v.model) out.model = v.model;
      return out;
    },
    fromSettings: (s) => ({
      providerId: str(s.providerId),
      baseUrl: str(s.baseURL),
      apiKey: str(s.apiKey),
      model: str(s.model),
    }),
  },

  // ---------------------------------------------------------------- OpenClaw
  openclaw: {
    allowAdvanced: true,
    fields: [
      { key: "providerId", label: "Provider ID", type: "text" },
      { key: "baseUrl", label: "Base URL", type: "text" },
      { key: "apiKey", label: "API Key", type: "password" },
      { key: "model", label: "模型", type: "text" },
    ],
    toSettings: (v) => {
      const out: Record<string, unknown> = {
        providerId: v.providerId ?? "custom",
      };
      if (v.baseUrl) out.baseURL = v.baseUrl;
      if (v.apiKey) out.apiKey = v.apiKey;
      if (v.model) out.model = v.model;
      return out;
    },
    fromSettings: (s) => ({
      providerId: str(s.providerId),
      baseUrl: str(s.baseURL),
      apiKey: str(s.apiKey),
      model: str(s.model),
    }),
  },

  // ---------------------------------------------------------------- 第二批：高级编辑
  hermes: {
    allowAdvanced: true,
    fields: [],
    toSettings: () => ({}),
    fromSettings: () => ({}),
  },
  pi: {
    allowAdvanced: true,
    fields: [],
    toSettings: () => ({}),
    fromSettings: () => ({}),
  },
  mcode: {
    allowAdvanced: true,
    fields: [],
    toSettings: () => ({}),
    fromSettings: () => ({}),
  },
};

/// 生成新供应商的默认 ID。
export function newProviderId(): string {
  // 与后端 uuid 风格一致即可；后端 add 也会兜底。
  return globalThis.crypto?.randomUUID?.() ?? `p-${Date.now()}`;
}

/// 编辑时把 Provider 转成表单初始值与高级配置。
export function providerToForm(
  app: AppId,
  provider: Provider
): {
  values: FormValues;
  advanced: Record<string, unknown>;
} {
  const settings = provider.settingsConfig ?? {};
  return {
    values: FORM_SCHEMAS[app].fromSettings(settings),
    advanced: settings,
  };
}
