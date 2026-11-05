import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

interface ConfigJsonEditorProps {
  /// settingsConfig（唯一事实源）；字段与开关都读写它。
  value: Record<string, unknown>;
  onChange: (value: Record<string, unknown>) => void;
  label?: string;
  hint?: string;
  /// 文本框上方的附加内容（如快捷开关行）。
  children?: ReactNode;
}

/// 供应商配置的原始 JSON 编辑框。
///
/// 文本框用本地态：用户输入过程中不重排；仅当外部（字段/开关）改动了 config
/// 时才重新格式化，避免每敲一个字符就把光标弹走。
export function ConfigJsonEditor({
  value,
  onChange,
  label = "配置 JSON",
  hint,
  children,
}: ConfigJsonEditorProps) {
  const [text, setText] = useState(() => JSON.stringify(value, null, 2));
  const lastRef = useRef(value);
  useEffect(() => {
    if (lastRef.current !== value) {
      lastRef.current = value;
      setText(JSON.stringify(value, null, 2));
    }
  }, [value]);

  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {hint && <p className="text-muted-foreground text-xs">{hint}</p>}
      {children}
      <Textarea
        className={cn("min-h-56 font-mono text-xs")}
        value={text}
        onChange={(ev) => {
          const next = ev.target.value;
          setText(next);
          try {
            const parsed = JSON.parse(next);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
              lastRef.current = parsed;
              onChange(parsed as Record<string, unknown>);
            }
          } catch {
            // 用户正在输入，忽略非法 JSON。
          }
        }}
      />
    </div>
  );
}
