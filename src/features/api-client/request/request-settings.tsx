import { useState } from "react";
import { RotateCcw, Settings2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";

export interface RequestSettingsProps {
  timeoutMs: number | null;
  followRedirects: boolean | null;
  onChange: (patch: { timeoutMs?: number | null; followRedirects?: boolean | null }) => void;
}

/**
 * Per-request transport settings: the timeout in milliseconds and whether the
 * engine follows redirects. Both are nullable, where `null` means "use the
 * engine default" (30 s, follow). The timeout field buffers keystrokes and only
 * writes a positive integer on blur or Enter.
 */
export function RequestSettings({ timeoutMs, followRedirects, onChange }: RequestSettingsProps) {
  const { t } = useTranslation("translation", { keyPrefix: "apiClient.request.settings" });
  const [open, setOpen] = useState(false);
  const [buffer, setBuffer] = useState<string | null>(null);

  const timeoutText = buffer ?? (timeoutMs === null ? "" : String(timeoutMs));

  const commitTimeout = () => {
    if (buffer === null) return;
    const text = buffer.trim();
    const value = text === "" ? 0 : Number(text);
    onChange({ timeoutMs: value > 0 ? value : null });
    setBuffer(null);
  };

  const reset = () => {
    setBuffer(null);
    onChange({ timeoutMs: null, followRedirects: null });
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={t("label")}
          title={t("label")}
        >
          <Settings2 className="size-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 space-y-3 p-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="request-timeout" className="text-xs">
            {t("timeout")}
          </Label>
          <Input
            id="request-timeout"
            value={timeoutText}
            inputMode="numeric"
            autoComplete="off"
            spellCheck={false}
            placeholder={t("timeoutPlaceholder")}
            className="h-8 text-xs"
            onChange={(event) => setBuffer(event.target.value.replace(/\D/g, ""))}
            onBlur={commitTimeout}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              commitTimeout();
            }}
          />
          <p className="text-muted-foreground text-[11px]">{t("timeoutHint")}</p>
        </div>

        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor="request-follow-redirects" className="text-xs">
              {t("followRedirects")}
            </Label>
            <Switch
              id="request-follow-redirects"
              checked={followRedirects ?? true}
              onCheckedChange={(checked) => onChange({ followRedirects: checked })}
            />
          </div>
          <p className="text-muted-foreground text-[11px]">{t("followRedirectsHint")}</p>
        </div>

        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="w-full"
          onClick={reset}
          disabled={timeoutMs === null && followRedirects === null}
        >
          <RotateCcw />
          {t("reset")}
        </Button>
      </PopoverContent>
    </Popover>
  );
}

export default RequestSettings;
