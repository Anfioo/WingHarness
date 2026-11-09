// The port settings dialog: pinned-port chips, the pin limit and the pinned-only view.

import { Plus, RotateCcw, X } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { DEFAULT_PINNED_PORTS, MAX_PINNED_PORTS, portsErrorCode } from "@/commands";
import type { PortsSettings } from "@/commands";
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
import { Switch } from "@/components/ui/switch";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { portsErrorKey } from "@/hooks/use-ports-page";
import { cn } from "@/lib/utils";

import type { PortSettingsDialogProps } from "./props";

const MAX_PORT = 65_535;

function draftFrom(settings: PortsSettings | null): PortsSettings {
  return settings
    ? { pinnedPorts: [...settings.pinnedPorts], pinnedOnly: settings.pinnedOnly }
    : { pinnedPorts: [...DEFAULT_PINNED_PORTS], pinnedOnly: false };
}

export function PortSettingsDialog({
  open,
  onOpenChange,
  settings,
  onSave,
}: PortSettingsDialogProps) {
  const { t } = useAppTranslation();

  const [draft, setDraft] = useState<PortsSettings>(() => draftFrom(settings));
  const [input, setInput] = useState("");
  const [saving, setSaving] = useState(false);

  // Reopen on the persisted values; closing drops whatever was not saved.
  useEffect(() => {
    if (!open) return;
    setDraft(draftFrom(settings));
    setInput("");
    setSaving(false);
  }, [open, settings]);

  const full = draft.pinnedPorts.length >= MAX_PINNED_PORTS;

  const addPort = () => {
    const trimmed = input.trim();
    const parsed = Number.parseInt(trimmed, 10);
    if (!/^\d+$/.test(trimmed) || parsed < 1 || parsed > MAX_PORT) {
      toast.error(t("ports.settings.invalid"));
      return;
    }
    if (draft.pinnedPorts.includes(parsed)) {
      toast.error(t("ports.settings.duplicate"));
      return;
    }
    if (full) {
      toast.error(t("ports.settings.full"));
      return;
    }
    setDraft((current) => ({
      ...current,
      pinnedPorts: [...current.pinnedPorts, parsed].sort((left, right) => left - right),
    }));
    setInput("");
  };

  const removePort = (port: number) => {
    setDraft((current) => ({
      ...current,
      pinnedPorts: current.pinnedPorts.filter((value) => value !== port),
    }));
  };

  const resetPorts = () => {
    setDraft((current) => ({ ...current, pinnedPorts: [...DEFAULT_PINNED_PORTS] }));
  };

  const save = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await onSave(draft);
      onOpenChange(false);
    } catch (failure) {
      toast.error(t(portsErrorKey(portsErrorCode(failure))));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("ports.settings.title")}</DialogTitle>
          <DialogDescription>{t("ports.settings.description")}</DialogDescription>
        </DialogHeader>

        <section className="flex flex-col gap-3">
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-0.5">
              <h3 className="text-sm font-medium">{t("ports.settings.pinned")}</h3>
              <p className="text-muted-foreground text-xs">{t("ports.settings.pinnedHint")}</p>
            </div>
            <Button variant="ghost" size="xs" onClick={resetPorts}>
              <RotateCcw />
              {t("ports.settings.reset")}
            </Button>
          </div>

          <div className="flex items-center gap-2">
            <Input
              inputMode="numeric"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                addPort();
              }}
              placeholder={t("ports.settings.addPlaceholder")}
              aria-label={t("ports.settings.addPlaceholder")}
              className="font-mono"
            />
            <Button variant="outline" disabled={input.trim().length === 0} onClick={addPort}>
              <Plus />
              {t("ports.settings.add")}
            </Button>
          </div>

          <div className="border-border max-h-56 overflow-y-auto rounded-lg border p-2">
            {draft.pinnedPorts.length === 0 ? (
              <p className="text-muted-foreground px-1 py-2 text-xs">{t("ports.settings.empty")}</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {draft.pinnedPorts.map((port) => (
                  <span
                    key={port}
                    className="bg-muted inline-flex h-7 items-center gap-1 rounded-md pr-1 pl-2 font-mono text-xs"
                  >
                    {port}
                    <button
                      type="button"
                      onClick={() => removePort(port)}
                      aria-label={t("ports.row.unpinAria", { port })}
                      className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive flex size-5 items-center justify-center rounded transition-colors"
                    >
                      <X className="size-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>

          <div className="flex items-center gap-2">
            <div className="bg-muted h-1 flex-1 overflow-hidden rounded-full">
              <div
                className={cn(
                  "h-full rounded-full transition-all",
                  full ? "bg-destructive" : "bg-foreground/40"
                )}
                style={{ width: `${(draft.pinnedPorts.length / MAX_PINNED_PORTS) * 100}%` }}
              />
            </div>
            <span className="text-muted-foreground font-mono text-[11px] tabular-nums">
              {t("ports.settings.count", {
                count: draft.pinnedPorts.length,
                max: MAX_PINNED_PORTS,
              })}
            </span>
          </div>
        </section>

        <section className="border-border flex items-start justify-between gap-4 border-t pt-3">
          <div className="space-y-0.5">
            <h3 id="ports-pinned-only-label" className="text-sm font-medium">
              {t("ports.settings.pinnedOnly")}
            </h3>
            <p className="text-muted-foreground text-xs">{t("ports.settings.pinnedOnlyHint")}</p>
          </div>
          <Switch
            checked={draft.pinnedOnly}
            onCheckedChange={(checked) =>
              setDraft((current) => ({ ...current, pinnedOnly: checked }))
            }
            aria-labelledby="ports-pinned-only-label"
          />
        </section>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("ports.actions.cancel")}
          </Button>
          <Button disabled={saving} onClick={() => void save()}>
            {t("ports.actions.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
