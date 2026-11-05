import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ConfigJsonEditor } from "./provider-form-config-json";
import { ConfigTextEditor } from "./provider-form-config-text";
import { ModelField } from "./provider-form-model-field";
import { useModelFetch } from "./use-model-fetch";
import { getTomlValue, setTomlValue } from "./codex-toml";

export interface CodexFormProps {
  name: string;
  onNameChange: (value: string) => void;
  notes: string;
  onNotesChange: (value: string) => void;
  websiteUrl: string;
  onWebsiteUrlChange: (value: string) => void;
  /// settingsConfig：`{ config: "<config.toml 文本>", auth: {...} }`（新式），
  /// 或旧式直接是 config.toml 的 JSON 结构。
  config: Record<string, unknown>;
  onConfigChange: (config: Record<string, unknown>) => void;
}

const PROVIDER_SECTION = "model_providers.custom";

/// Codex 供应商表单：两个文件（config.toml + auth.json）+ 常用字段。
/// 与 Claude 不同——地址/模型落在 TOML 文本里，凭据落在 auth.json 里。
export function CodexForm({
  name,
  onNameChange,
  notes,
  onNotesChange,
  websiteUrl,
  onWebsiteUrlChange,
  config,
  onConfigChange,
}: CodexFormProps) {
  const configText = typeof config.config === "string" ? config.config : "";
  const auth =
    config.auth && typeof config.auth === "object" && !Array.isArray(config.auth)
      ? (config.auth as Record<string, unknown>)
      : {};

  const setConfigText = (next: string) => onConfigChange({ ...config, config: next });
  const setAuthObject = (next: Record<string, unknown>) =>
    onConfigChange({ ...config, auth: next });

  // 编辑地址/模型时补齐 Codex 必需的骨架：model_provider="custom" + wire_api="responses"。
  const scaffold = (text: string): string => {
    let t = text;
    if (!getTomlValue(t, null, "model_provider")) {
      t = setTomlValue(t, null, "model_provider", "custom");
    }
    if (!getTomlValue(t, PROVIDER_SECTION, "wire_api")) {
      t = setTomlValue(t, PROVIDER_SECTION, "wire_api", "responses");
    }
    return t;
  };

  const baseUrl = getTomlValue(configText, PROVIDER_SECTION, "base_url");
  const model = getTomlValue(configText, null, "model");
  const apiKey = typeof auth.OPENAI_API_KEY === "string" ? auth.OPENAI_API_KEY : "";

  const setBaseUrl = (v: string) =>
    setConfigText(scaffold(setTomlValue(configText, PROVIDER_SECTION, "base_url", v)));
  const setModel = (v: string) => setConfigText(setTomlValue(configText, null, "model", v));

  const {
    models,
    loading: modelsLoading,
    fetch: fetchModels,
  } = useModelFetch("codex", () => ({
    id: "temp",
    name: name || "temp",
    settingsConfig: config,
  }));

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <Label htmlFor="codex-name">名称</Label>
          <Input
            id="codex-name"
            value={name}
            onChange={(ev) => onNameChange(ev.target.value)}
            placeholder="例如：公司专用账号"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="codex-notes">备注</Label>
          <Input
            id="codex-notes"
            value={notes}
            onChange={(ev) => onNotesChange(ev.target.value)}
            placeholder="例如：公司专用账号"
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="codex-website">官网链接</Label>
        <Input
          id="codex-website"
          value={websiteUrl}
          onChange={(ev) => onWebsiteUrlChange(ev.target.value)}
          placeholder="https://example.com（可选）"
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="codex-api-key">API Key</Label>
        <Input
          id="codex-api-key"
          type="password"
          value={apiKey}
          onChange={(ev) => setAuthObject({ ...auth, OPENAI_API_KEY: ev.target.value })}
          placeholder="•••••••"
        />
        <p className="text-muted-foreground text-xs">
          切换时写入 config.toml 的 [model_providers.custom].experimental_bearer_token （Codex 0.149
          起自定义 provider 不再读 auth.json 里的 Key）。
        </p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="codex-base-url">API 请求地址</Label>
        <Input
          id="codex-base-url"
          value={baseUrl}
          onChange={(ev) => setBaseUrl(ev.target.value)}
          placeholder="https://.../v1"
        />
        <p className="text-muted-foreground text-xs">
          填写兼容 OpenAI Responses 格式的服务端点地址。
        </p>
      </div>

      <div className="space-y-1.5">
        <Label>默认模型</Label>
        <ModelField
          value={model}
          onChange={setModel}
          placeholder="例如：gpt-5.6-sol"
          models={models}
          loading={modelsLoading}
          onFetch={fetchModels}
        />
        <p className="text-muted-foreground text-xs">
          Codex 默认请求的模型，随时可改；留空则用 Codex 内置默认。
        </p>
      </div>

      <ConfigTextEditor
        value={configText}
        onChange={setConfigText}
        label="config.toml"
        hint="地址、Key、模型、推理档位与兼容开关随供应商切换；其余是 Codex 全局设置，保存后对所有供应商生效。"
        placeholder={
          'model_provider = "custom"\nmodel = "gpt-5.6-sol"\n\n[model_providers.custom]\nbase_url = "https://..."\nwire_api = "responses"'
        }
      />

      <ConfigJsonEditor
        value={auth}
        onChange={setAuthObject}
        label="auth.json"
        hint="写入 ~/.codex/auth.json；官方登录方式时留空即可。"
      />
    </div>
  );
}
