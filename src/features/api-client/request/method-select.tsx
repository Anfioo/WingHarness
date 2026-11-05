import { useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { useTranslation } from "react-i18next";
import { MethodBadge } from "@/components/api-client/method-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { HTTP_METHODS, type HttpMethod } from "@/lib/api-core/types";

export interface MethodSelectProps {
  /** The current verb; any string is accepted so custom methods round-trip. */
  value: string;
  onChange: (method: string) => void;
  disabled?: boolean;
  /** Marks the trigger invalid for `aria-invalid`. */
  invalid?: boolean;
}

/**
 * The method picker: a colour-coded trigger that opens a searchable list of the
 * seven standard verbs. Typing a verb that is not on the list offers it as a
 * custom method, so imported/custom methods are never forced away.
 */
export function MethodSelect({ value, onChange, disabled, invalid }: MethodSelectProps) {
  const { t } = useTranslation("translation", { keyPrefix: "apiClient.request.method" });
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const trimmed = query.trim();
  const upper = trimmed.toUpperCase();
  const current = value.trim().toUpperCase();
  const filtered =
    trimmed === "" ? HTTP_METHODS : HTTP_METHODS.filter((method) => method.includes(upper));
  const custom = trimmed !== "" && !HTTP_METHODS.includes(upper as HttpMethod);

  const select = (method: string) => {
    onChange(method);
    setOpen(false);
    setQuery("");
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          aria-invalid={invalid || undefined}
          aria-label={t("label")}
          className="h-9 w-28 shrink-0 justify-between gap-1 px-2"
        >
          <MethodBadge method={value} />
          <ChevronDown className="size-3.5 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56 p-0">
        <div className="border-b p-2">
          <Input
            value={query}
            autoFocus
            placeholder={t("search")}
            aria-label={t("search")}
            className="h-8 text-xs"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              const method = custom ? upper : filtered[0];
              if (method) select(method);
            }}
          />
        </div>
        <div className="max-h-64 overflow-y-auto p-1">
          {filtered.map((method) => (
            <button
              key={method}
              type="button"
              onClick={() => select(method)}
              className="hover:bg-accent flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs"
            >
              <MethodBadge method={method} />
              <span className="flex-1">{method}</span>
              {method === current ? <Check className="size-3.5" /> : null}
            </button>
          ))}
          {custom ? (
            <button
              type="button"
              onClick={() => select(upper)}
              className="hover:bg-accent flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs"
            >
              <span className="truncate">{t("custom", { value: upper })}</span>
            </button>
          ) : null}
          {filtered.length === 0 && !custom ? (
            <p className="text-muted-foreground px-2 py-6 text-center text-xs">{t("empty")}</p>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export default MethodSelect;
