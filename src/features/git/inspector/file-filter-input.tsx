import { useEffect, useRef } from "react";
import { Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useAppTranslation } from "@/hooks/use-app-translation";

let consumedFocusSeq = 0;

export function FileFilterInput({
  value,
  onChange,
  onClose,
  focusSeq = 0,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  onClose?: () => void;
  focusSeq?: number;
  className?: string;
}) {
  const { t } = useAppTranslation();
  const placeholder = t("gitRepo.inspector.filter.placeholder");
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (focusSeq === 0 || focusSeq === consumedFocusSeq) return;
    consumedFocusSeq = focusSeq;
    inputRef.current?.focus();
  }, [focusSeq]);
  return (
    <div className={cn("relative min-w-0", className)}>
      <Search className="text-faint pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
      <Input
        ref={inputRef}
        value={value}
        aria-label={t("gitRepo.inspector.filter.aria")}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Escape") return;
          e.preventDefault();
          e.stopPropagation();
          if (value) onChange("");
          else onClose?.();
        }}
        className={cn("bg-muted h-7 border-transparent pl-8 text-xs", value && "pr-7")}
      />
      {value && (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("gitRepo.inspector.filter.clear")}
          className="absolute top-1/2 right-0.5 size-6 -translate-y-1/2"
          onClick={() => onChange("")}
        >
          <X className="size-3" />
        </Button>
      )}
    </div>
  );
}
