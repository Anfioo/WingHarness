import { useState } from "react";
import { ChevronDown, Download, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { FetchedModel } from "@/commands/services/ccs/types";

interface ModelFieldProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  models: FetchedModel[];
  loading: boolean;
  /// 传入时显示获取按钮。
  onFetch?: () => void;
}

/// 模型输入框 + 「获取模型」按钮 + 可搜索下拉，对齐 cc-switch 的模型字段。
export function ModelField({
  value,
  onChange,
  placeholder,
  models,
  loading,
  onFetch,
}: ModelFieldProps) {
  return (
    <div className="flex gap-1">
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="flex-1"
        autoComplete="off"
      />
      {models.length > 0 && <ModelDropdown models={models} onSelect={onChange} />}
      {onFetch && (
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="shrink-0"
          onClick={onFetch}
          disabled={loading}
          aria-label="获取模型列表"
        >
          {loading ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
        </Button>
      )}
    </div>
  );
}

/// 搜索式模型下拉（按 ownedBy 分组；平铺无 vendor 时直接列出）。
function ModelDropdown({
  models,
  onSelect,
}: {
  models: FetchedModel[];
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const filtered = q ? models.filter((m) => m.id.toLowerCase().includes(q)) : models;

  return (
    <Popover modal open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="shrink-0"
          aria-label="选择模型"
        >
          <ChevronDown className="size-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-0">
        <div className="border-b p-2">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索模型…"
            className="h-8"
            autoFocus
          />
        </div>
        <div className="max-h-64 overflow-y-auto p-1">
          {filtered.length === 0 ? (
            <p className="text-muted-foreground px-2 py-6 text-center text-sm">没有匹配的模型。</p>
          ) : (
            filtered.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => {
                  onSelect(m.id);
                  setOpen(false);
                  setQuery("");
                }}
                className="hover:bg-accent flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-sm"
              >
                <span className="truncate">{m.id}</span>
                {m.ownedBy && (
                  <span className="text-muted-foreground shrink-0 text-xs">{m.ownedBy}</span>
                )}
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
