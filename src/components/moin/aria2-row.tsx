// Adapted from moin (MIT), https://github.com/exxvius/moin at 79e7587.
// See `src-tauri/moin-core/UPSTREAM.md` for the porting record.

import { useCallback, useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { LoaderCircle } from "lucide-react";
import { toast } from "sonner";
import {
  moinSetToolPath,
  moinToolStatus,
  type MoinToolSource,
  type MoinToolStatus,
} from "@/commands";
import { Field } from "@/components/moin/settings-sections";
import { Button } from "@/components/ui/button";
import { useAppTranslation } from "@/hooks/use-app-translation";

/** Where the probe found the binary, as an i18n key. */
const SOURCE_KEYS: Record<Exclude<MoinToolSource, null>, string> = {
  override: "moin.tool.source.override",
  env: "moin.tool.source.env",
  path: "moin.tool.source.path",
};

export type Aria2RowProps = {
  disabled?: boolean;
  /** Fires whenever the probe result changes, so the parent can re-read the engine list. */
  onStatusChange?: (status: MoinToolStatus) => void;
};

/**
 * The aria2c probe row: what was found, where it came from, and the three ways
 * to change it.
 *
 * This port never downloads aria2c for the user — the row only points the engine
 * at a local copy or hands the search back to automatic detection. When nothing
 * is found the engine keeps working through its built-in backend, which is what
 * the fallback hint says.
 */
export function Aria2Row({ disabled = false, onStatusChange }: Aria2RowProps) {
  const { t } = useAppTranslation();
  const [tool, setTool] = useState<MoinToolStatus | null>(null);
  const [busy, setBusy] = useState(false);

  // Held in a ref so a parent that rebuilds its callback every render cannot
  // retrigger the initial probe.
  const notify = useRef(onStatusChange);
  useEffect(() => {
    notify.current = onStatusChange;
  }, [onStatusChange]);

  const apply = useCallback((status: MoinToolStatus) => {
    setTool(status);
    notify.current?.(status);
  }, []);

  const probe = useCallback(async () => {
    try {
      apply(await moinToolStatus());
    } catch {
      setTool(null);
    }
  }, [apply]);

  useEffect(() => {
    void probe();
  }, [probe]);

  const save = async (path: string | null) => {
    setBusy(true);
    try {
      apply(await moinSetToolPath(path));
      toast.success(t("moin.settings.saveSuccess"));
    } catch {
      toast.error(t("moin.settings.saveFailed"));
    } finally {
      setBusy(false);
    }
  };

  const choose = async () => {
    try {
      const picked = await open({ multiple: false, directory: false });
      if (typeof picked !== "string") return;
      await save(picked);
    } catch {
      toast.error(t("moin.settings.saveFailed"));
    }
  };

  const present = tool?.present ?? false;
  const sourceKey = tool?.source ? SOURCE_KEYS[tool.source] : null;
  const version = tool?.version ? `${t("moin.tool.version")} ${tool.version}` : null;
  const source = sourceKey ? `${t("moin.tool.sourceLabel")}: ${t(sourceKey)}` : null;
  const state = present ? [version, source].filter(Boolean).join(" · ") : t("moin.tool.missing");

  return (
    <div className="flex flex-col gap-1 pb-2.5">
      <Field label={t("moin.backend.aria2")} hint={state}>
        <div className="flex flex-wrap items-center gap-2 sm:justify-end">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={disabled || busy}
            onClick={() => void choose()}
          >
            {t("moin.tool.choose")}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={disabled || busy}
            onClick={() => void save(null)}
          >
            {t("moin.tool.auto")}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={disabled || busy}
            onClick={() => void probe()}
          >
            {busy ? <LoaderCircle className="animate-spin" /> : null}
            {t("moin.tool.reprobe")}
          </Button>
        </div>
      </Field>

      {present && tool?.path && (
        <p className="text-muted-foreground truncate font-mono text-xs" title={tool.path}>
          {tool.path}
        </p>
      )}
      {!present && <p className="text-muted-foreground text-xs">{t("moin.tool.fallbackHint")}</p>}
    </div>
  );
}
