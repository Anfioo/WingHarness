import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ConfigJsonEditor } from "./provider-form-config-json";
import { ModelField } from "./provider-form-model-field";
import { useModelFetch } from "./use-model-fetch";

/// 供应商随切换生效的快捷开关（写入 settings.json 的 env）。
/// 只保留「随供应商切换」的三个：不做全局开关（隐藏 AI 署名 / 禁用自动升级）。
const QUICK_TOGGLES = [
  {
    key: "ENABLE_TOOL_SEARCH",
    label: "启用 Tool Search",
    on: "true",
    help: "MCP 工具多时按需加载工具定义，节省上下文。第三方地址默认关闭，上游支持 tool_reference 才能开。",
  },
  {
    key: "CLAUDE_CODE_DISABLE_ARTIFACT",
    label: "禁用 Artifact 工具",
    on: "1",
    help: "不把 Artifact 工具发给模型。部分第三方网关会因它的 schema 对每个请求报 400。",
  },
  {
    key: "CLAUDE_CODE_AUTO_MODE_SERVER",
    label: "关闭 auto mode 服务端检查",
    on: "0",
    help: "网关不支持服务端检查时，auto mode 每个会话会先停下提示一次。勾选后直接用本机检查。官方端点不要勾选。",
  },
] as const;

const AUTH_FIELDS = [
  { value: "ANTHROPIC_AUTH_TOKEN", label: "ANTHROPIC_AUTH_TOKEN（默认）" },
  { value: "ANTHROPIC_API_KEY", label: "ANTHROPIC_API_KEY" },
] as const;

/// 模型映射：角色 → env 键。留空表示用该角色的默认模型。
const MODEL_ROLES = [
  { key: "ANTHROPIC_MODEL", label: "主模型", placeholder: "例如：claude-sonnet-4" },
  { key: "ANTHROPIC_DEFAULT_SONNET_MODEL", label: "Sonnet", placeholder: "claude-sonnet-4" },
  { key: "ANTHROPIC_DEFAULT_OPUS_MODEL", label: "Opus", placeholder: "claude-opus-4" },
  { key: "ANTHROPIC_DEFAULT_HAIKU_MODEL", label: "Haiku", placeholder: "claude-haiku-4" },
] as const;

export interface ClaudeFormProps {
  name: string;
  onNameChange: (value: string) => void;
  notes: string;
  onNotesChange: (value: string) => void;
  websiteUrl: string;
  onWebsiteUrlChange: (value: string) => void;
  /// settingsConfig，作为唯一事实源；所有字段与开关都读写它。
  config: Record<string, unknown>;
  onConfigChange: (config: Record<string, unknown>) => void;
  apiKeyField: string;
  onApiKeyFieldChange: (field: string) => void;
}

function env(config: Record<string, unknown>): Record<string, unknown> {
  const e = config.env;
  return e && typeof e === "object" && !Array.isArray(e) ? (e as Record<string, unknown>) : {};
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/// 写 env 键：值非空则写入，空则删除该键（并清理空的 env）。
function withEnvKey(
  config: Record<string, unknown>,
  key: string,
  value: string
): Record<string, unknown> {
  const next = { ...env(config) };
  if (value) {
    next[key] = value;
  } else {
    delete next[key];
  }
  const out = { ...config };
  if (Object.keys(next).length === 0) {
    delete out.env;
  } else {
    out.env = next;
  }
  return out;
}

function toggleOn(config: Record<string, unknown>, key: string, on: string): boolean {
  const v = env(config)[key];
  return v === on || v === Number(on);
}

export function ClaudeForm({
  name,
  onNameChange,
  notes,
  onNotesChange,
  websiteUrl,
  onWebsiteUrlChange,
  config,
  onConfigChange,
  apiKeyField,
  onApiKeyFieldChange,
}: ClaudeFormProps) {
  const e = env(config);
  // 读鉴权键：优先按当前选择，其次回退另一个键，方便识别已有配置。
  const authKey = apiKeyField || "ANTHROPIC_AUTH_TOKEN";
  const apiKey =
    str(e[authKey]) ||
    str(e[authKey === "ANTHROPIC_AUTH_TOKEN" ? "ANTHROPIC_API_KEY" : "ANTHROPIC_AUTH_TOKEN"]);

  const setEnv = (key: string, value: string) => onConfigChange(withEnvKey(config, key, value));

  const toggleConfig = (key: string, on: string, checked: boolean) =>
    onConfigChange(withEnvKey(config, key, checked ? on : ""));

  // 获取模型列表：以当前表单配置构造临时 provider 交给后端探测。
  const {
    models,
    loading: modelsLoading,
    fetch: fetchModels,
  } = useModelFetch("claude", () => ({
    id: "temp",
    name: name || "temp",
    settingsConfig: config,
  }));

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <Label htmlFor="provider-name">名称</Label>
          <Input
            id="provider-name"
            value={name}
            onChange={(ev) => onNameChange(ev.target.value)}
            placeholder="例如：公司专用账号"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="provider-notes">备注</Label>
          <Input
            id="provider-notes"
            value={notes}
            onChange={(ev) => onNotesChange(ev.target.value)}
            placeholder="例如：公司专用账号"
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="provider-website">官网链接</Label>
        <Input
          id="provider-website"
          value={websiteUrl}
          onChange={(ev) => onWebsiteUrlChange(ev.target.value)}
          placeholder="https://example.com（可选）"
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="provider-api-key">API Key</Label>
        <Input
          id="provider-api-key"
          type="password"
          value={apiKey}
          onChange={(ev) => setEnv(authKey, ev.target.value)}
          placeholder="•••••••"
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="provider-base-url">请求地址</Label>
        <Input
          id="provider-base-url"
          value={str(e.ANTHROPIC_BASE_URL)}
          onChange={(ev) => setEnv("ANTHROPIC_BASE_URL", ev.target.value)}
          placeholder="https://..."
        />
        <p className="text-muted-foreground text-xs">
          填写兼容 Claude API 的服务端点地址，不要以斜杠结尾。
        </p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="provider-auth-field">认证字段</Label>
        <Select value={authKey} onValueChange={onApiKeyFieldChange}>
          <SelectTrigger id="provider-auth-field">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {AUTH_FIELDS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-muted-foreground text-xs">选择写入配置的认证环境变量名。</p>
      </div>

      <div className="space-y-2">
        <Label>模型映射</Label>
        <p className="text-muted-foreground text-xs">
          选择模型角色对应的实际请求模型；留空则使用该角色的默认模型。
        </p>
        <div className="space-y-2">
          {MODEL_ROLES.map((role, index) => (
            <div key={role.key} className="grid grid-cols-[88px_1fr] items-center gap-2">
              <span className="text-muted-foreground text-sm">{role.label}</span>
              <ModelField
                value={str(e[role.key])}
                onChange={(v) => setEnv(role.key, v)}
                placeholder={role.placeholder}
                models={models}
                loading={modelsLoading}
                // 只在第一行（主模型）旁显示获取按钮，避免每行都放一个。
                onFetch={index === 0 ? fetchModels : undefined}
              />
            </div>
          ))}
        </div>
      </div>

      <ConfigJsonEditor
        value={config}
        onChange={onConfigChange}
        hint="地址、Key、模型、上下文窗口和兼容开关随供应商切换；其余字段是 Claude Code 全局设置，保存后对所有供应商生效。"
      >
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pb-1">
          {QUICK_TOGGLES.map((t) => (
            <label key={t.key} className="inline-flex items-center gap-2 text-sm" title={t.help}>
              <input
                type="checkbox"
                checked={toggleOn(config, t.key, t.on)}
                onChange={(ev) => toggleConfig(t.key, t.on, ev.target.checked)}
                className="accent-primary size-4"
              />
              {t.label}
            </label>
          ))}
        </div>
      </ConfigJsonEditor>
    </div>
  );
}
