import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

interface ConfigTextEditorProps {
  /// 唯一事实源（config.toml 文本）。
  value: string;
  onChange: (value: string) => void;
  label?: string;
  hint?: string;
  placeholder?: string;
  /// 文本框上方的附加内容。
  children?: ReactNode;
}

/// 原始文本编辑框（TOML 等）。本地态避免用户输入过程中被外部格式化打断。
export function ConfigTextEditor({
  value,
  onChange,
  label = "配置",
  hint,
  placeholder,
  children,
}: ConfigTextEditorProps) {
  const [text, setText] = useState(value);
  const lastRef = useRef(value);
  useEffect(() => {
    if (lastRef.current !== value) {
      lastRef.current = value;
      setText(value);
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
        placeholder={placeholder}
        onChange={(ev) => {
          const next = ev.target.value;
          setText(next);
          lastRef.current = next;
          onChange(next);
        }}
      />
    </div>
  );
}
