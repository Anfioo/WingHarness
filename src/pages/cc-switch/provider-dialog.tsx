import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { ccsAddProvider, ccsUpdateProvider, ccsEditorBase, ccsEditorDelta } from "@/commands";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { AppId, Provider } from "@/commands/services/ccs/types";
import { FORM_SCHEMAS, newProviderId, type FormValues } from "./form-schema";
import { ClaudeForm } from "./provider-form-claude";
import { CodexForm } from "./provider-form-codex";

interface ProviderDialogProps {
  app: AppId;
  editing: Provider | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}

export function ProviderDialog(props: ProviderDialogProps) {
  if (props.app === "claude") {
    return <StructuredProviderDialog {...props} renderForm={(s) => <ClaudeForm {...s} />} />;
  }
  if (props.app === "codex") {
    return <StructuredProviderDialog {...props} renderForm={(s) => <CodexForm {...s} />} />;
  }
  return <GenericProviderDialog {...props} />;
}

// --------------------------------------------------------------------------
// Claude / Codex：名称 / 备注 / 官网 /（应用专属表单：凭据、地址、模型映射、配置 JSON）
// --------------------------------------------------------------------------

/// 结构化表单的共享状态，字段名与各应用表单的 props 对齐，便于直接 spread。
interface StructuredState {
  name: string;
  onNameChange: (v: string) => void;
  notes: string;
  onNotesChange: (v: string) => void;
  websiteUrl: string;
  onWebsiteUrlChange: (v: string) => void;
  config: Record<string, unknown>;
  onConfigChange: (v: Record<string, unknown>) => void;
  apiKeyField: string;
  onApiKeyFieldChange: (v: string) => void;
}

function StructuredProviderDialog({
  app,
  editing,
  open,
  onOpenChange,
  onSaved,
  renderForm,
}: ProviderDialogProps & { renderForm: (state: StructuredState) => ReactNode }) {
  const [name, setName] = useState(editing?.name ?? "");
  const [notes, setNotes] = useState(editing?.notes ?? "");
  const [websiteUrl, setWebsiteUrl] = useState(editing?.websiteUrl ?? "");
  const [config, setConfig] = useState<Record<string, unknown>>(
    () => (editing?.settingsConfig ?? {}) as Record<string, unknown>
  );
  const [apiKeyField, setApiKeyField] = useState(
    editing?.meta?.apiKeyField ?? "ANTHROPIC_AUTH_TOKEN"
  );
  const [saving, setSaving] = useState(false);
  // 编辑器视图（显示/编辑用）与基准（保存算增量用），由后端按 live 计算。
  const baselineRef = useRef<unknown>(null);

  // 打开时取编辑器视图：live 套上该供应商的投影，用户的 mcp/hooks/permissions/[projects]
  // 等内容随之展示。用户在编辑器里的改动最终只以增量保存。
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    ccsEditorBase(app, editing?.settingsConfig ? editing : undefined)
      .then((res) => {
        if (cancelled) return;
        if (res?.view == null) return;
        baselineRef.current = res.baseline ?? null;
        setConfig(res.view as Record<string, unknown>);
      })
      .catch(() => {
        // 读不了 live：保留原配置。
      });
    return () => {
      cancelled = true;
    };
  }, [open, app, editing]);

  const canSave = name.trim().length > 0;

  const handleSave = async () => {
    // 只存增量：去掉与基准相同的部分，避免把 live 带入的字段（mcp/projects 等）落库。
    let settingsConfig: Record<string, unknown> = config;
    try {
      if (baselineRef.current !== null) {
        settingsConfig = (await ccsEditorDelta(app, config, baselineRef.current)) as Record<
          string,
          unknown
        >;
      }
    } catch {
      // 算增量失败时退回整份保存。
    }

    const provider: Provider = {
      id: editing?.id ?? newProviderId(),
      name: name.trim(),
      settingsConfig,
      websiteUrl: websiteUrl.trim() || undefined,
      category: editing?.category,
      createdAt: editing?.createdAt ?? Date.now(),
      notes: notes.trim() || undefined,
      meta: app === "claude" ? { ...editing?.meta, apiKeyField } : editing?.meta,
      icon: editing?.icon,
      iconColor: editing?.iconColor,
    };

    setSaving(true);
    try {
      if (editing) {
        await ccsUpdateProvider(app, editing.id, provider);
        toast.success("供应商已更新");
      } else {
        await ccsAddProvider(app, provider);
        toast.success("供应商已添加");
      }
      onSaved();
      onOpenChange(false);
    } catch (error) {
      toast.error(String(error));
    } finally {
      setSaving(false);
    }
  };

  const state: StructuredState = {
    name,
    onNameChange: setName,
    notes,
    onNotesChange: setNotes,
    websiteUrl,
    onWebsiteUrlChange: setWebsiteUrl,
    config,
    onConfigChange: setConfig,
    apiKeyField,
    onApiKeyFieldChange: setApiKeyField,
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>{editing ? "编辑供应商" : "新增供应商"}</DialogTitle>
          <DialogDescription>保存后会立即写入 {app} 的配置文件，下一次请求生效。</DialogDescription>
        </DialogHeader>

        {renderForm(state)}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            取消
          </Button>
          <Button onClick={handleSave} disabled={!canSave || saving}>
            {editing ? "保存" : "添加"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// --------------------------------------------------------------------------
// 其余应用：通用精简表单（简单字段 + 高级 JSON）
// --------------------------------------------------------------------------

function GenericProviderDialog({ app, editing, open, onOpenChange, onSaved }: ProviderDialogProps) {
  const schema = FORM_SCHEMAS[app];

  const [name, setName] = useState(editing?.name ?? "");
  const [values, setValues] = useState<FormValues>(() =>
    editing ? schema.fromSettings(editing.settingsConfig ?? {}) : {}
  );
  const hasSimpleFields = schema.fields.length > 0;
  const [mode, setMode] = useState<"simple" | "advanced">(hasSimpleFields ? "simple" : "advanced");
  const [advancedText, setAdvancedText] = useState(() =>
    JSON.stringify(editing?.settingsConfig ?? {}, null, 2)
  );
  const [saving, setSaving] = useState(false);

  const setField = (key: keyof FormValues, value: string) => {
    setValues((prev) => ({ ...prev, [key]: value }));
  };

  const switchToAdvanced = () => {
    const settings = schema.toSettings(values, name);
    setAdvancedText(JSON.stringify(settings, null, 2));
    setMode("advanced");
  };

  const parsedAdvanced = useMemo<Record<string, unknown> | null>(() => {
    try {
      const v = JSON.parse(advancedText);
      return typeof v === "object" && v !== null ? v : null;
    } catch {
      return null;
    }
  }, [advancedText]);

  const canSave = name.trim().length > 0 && (mode === "simple" || parsedAdvanced != null);

  const handleSave = async () => {
    const settingsConfig =
      mode === "simple"
        ? schema.toSettings(values, name.trim())
        : (parsedAdvanced as Record<string, unknown>);

    const provider: Provider = {
      id: editing?.id ?? newProviderId(),
      name: name.trim(),
      settingsConfig,
      websiteUrl: editing?.websiteUrl,
      category: editing?.category,
      createdAt: editing?.createdAt ?? Date.now(),
      notes: editing?.notes,
      meta: editing?.meta,
      icon: editing?.icon,
      iconColor: editing?.iconColor,
    };

    setSaving(true);
    try {
      if (editing) {
        await ccsUpdateProvider(app, editing.id, provider);
        toast.success("供应商已更新");
      } else {
        await ccsAddProvider(app, provider);
        toast.success("供应商已添加");
      }
      onSaved();
      onOpenChange(false);
    } catch (error) {
      toast.error(String(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{editing ? "编辑供应商" : "新增供应商"}</DialogTitle>
          <DialogDescription>
            配置该供应商的连接地址、凭据与模型；切换时会写入 {app} 的配置文件。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="provider-name">供应商名称</Label>
            <Input
              id="provider-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如：我的中转站"
            />
          </div>

          {mode === "simple" ? (
            <>
              {schema.fields.map((field) => (
                <div key={field.key} className="space-y-1.5">
                  <Label>{field.label}</Label>
                  {field.type === "select" ? (
                    <Select
                      value={values[field.key] ?? ""}
                      onValueChange={(v) => setField(field.key, v)}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="请选择" />
                      </SelectTrigger>
                      <SelectContent>
                        {field.options?.map((opt) => (
                          <SelectItem key={opt.value} value={opt.value}>
                            {opt.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <Input
                      type={field.type === "password" ? "password" : "text"}
                      value={values[field.key] ?? ""}
                      placeholder={field.placeholder}
                      onChange={(e) => setField(field.key, e.target.value)}
                    />
                  )}
                </div>
              ))}

              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="w-full"
                onClick={switchToAdvanced}
              >
                切换到高级 JSON 编辑
              </Button>
            </>
          ) : (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label>连接配置（JSON）</Label>
                {hasSimpleFields && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    onClick={() => setMode("simple")}
                  >
                    返回简单表单
                  </Button>
                )}
              </div>
              <Textarea
                className="min-h-56 font-mono text-xs"
                value={advancedText}
                onChange={(e) => setAdvancedText(e.target.value)}
              />
              {mode === "advanced" && parsedAdvanced == null && (
                <p className="text-destructive text-xs">JSON 格式有误，请检查。</p>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            取消
          </Button>
          <Button onClick={handleSave} disabled={!canSave || saving}>
            {editing ? "保存" : "添加"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
