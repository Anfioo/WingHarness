import { Input } from "@/components/ui/input";
import { useAppTranslation } from "@/hooks/use-app-translation";
import type { ScoopPageController } from "@/hooks/use-scoop-page";
import type { ScoopLocation, ScoopProxyMode } from "@/commands";
import {
  joinWindows,
  proxySummary,
  type ScoopPathKind,
  type ScoopPathPrefs,
} from "@/lib/scoop/page";
import { cn } from "@/lib/utils";

const LOCATIONS: ScoopLocation[] = ["data", "user", "custom"];
const PROXY_MODES: ScoopProxyMode[] = ["inherit", "none", "custom"];

type PickerProps = {
  page: ScoopPageController;
  disabled?: boolean;
};

const optionClass = (active: boolean) =>
  cn(
    "rounded-md px-3 py-1.5 text-sm transition-colors",
    active
      ? "bg-background text-foreground shadow-sm"
      : "text-muted-foreground hover:text-foreground"
  );

/**
 * The three base folders for one root, with the real path the choice means.
 *
 * `scoop` and `scoopg` are deliberately separate choices: `SCOOP_GLOBAL` had
 * its own folder long before this page existed, and pointing it elsewhere must
 * not move the normal install as well.
 */
export function PathPicker({
  page,
  kind,
  disabled = false,
}: PickerProps & { kind: ScoopPathKind }) {
  const { t } = useAppTranslation();
  const { status } = page;
  const choice = kind === "scoop" ? page.prefs.scoop : page.prefs.global;

  const update = (patch: Partial<ScoopPathPrefs>) => {
    page.setPrefs(
      kind === "scoop" ? { scoop: { ...choice, ...patch } } : { global: { ...choice, ...patch } }
    );
  };

  const hint = (location: ScoopLocation) => {
    switch (location) {
      case "user": {
        const path = kind === "scoop" ? status?.userDir : status?.userGlobalDir;
        return path ?? t("scoop.location.unknown");
      }
      case "custom":
        return choice.customPath || t("scoop.location.customPlaceholder");
      default:
        return status
          ? joinWindows(status.dataDir, kind === "scoop" ? "scoop" : "scoopg")
          : t("scoop.location.unknown");
    }
  };

  return (
    <div className="space-y-3">
      <div>
        <p className="text-sm font-medium">{t(`scoop.path.${kind}`)}</p>
        <p className="text-muted-foreground mt-0.5 text-xs">{t(`scoop.path.${kind}Hint`)}</p>
      </div>

      <div className="bg-muted/70 flex flex-wrap items-center gap-0.5 rounded-lg p-0.5">
        {LOCATIONS.map((location) => (
          <button
            key={location}
            type="button"
            disabled={disabled}
            onClick={() => update({ location })}
            className={optionClass(choice.location === location)}
          >
            {t(`scoop.location.${location}`)}
          </button>
        ))}
      </div>

      <p className="text-muted-foreground font-mono text-xs break-all">{hint(choice.location)}</p>

      {choice.location === "custom" && (
        <Input
          value={choice.customPath}
          disabled={disabled}
          onChange={(event) => update({ customPath: event.target.value })}
          placeholder={t("scoop.location.customPlaceholder")}
          spellCheck={false}
          className="font-mono text-xs"
        />
      )}
    </div>
  );
}

/** Follow the app setting, go direct, or name an address for this page. */
export function ProxyPicker({ page, disabled = false }: PickerProps) {
  const { t } = useAppTranslation();
  const { status, prefs } = page;
  const resolved = proxySummary(prefs, status);

  const hint = (() => {
    if (!resolved.url) {
      return resolved.mode === "none" ? t("scoop.proxy.direct") : t("scoop.proxy.system");
    }
    return resolved.url;
  })();

  return (
    <div className="space-y-3">
      <div className="bg-muted/70 flex flex-wrap items-center gap-0.5 rounded-lg p-0.5">
        {PROXY_MODES.map((mode) => (
          <button
            key={mode}
            type="button"
            disabled={disabled}
            onClick={() => page.setPrefs({ proxyMode: mode })}
            className={optionClass(prefs.proxyMode === mode)}
          >
            {t(`scoop.proxy.mode.${mode}`)}
          </button>
        ))}
      </div>

      <p className="text-muted-foreground font-mono text-xs break-all">
        {hint} ·{" "}
        {resolved.source === "settings" ? t("scoop.proxy.fromSettings") : t("scoop.proxy.fromPage")}
      </p>

      {prefs.proxyMode === "custom" && (
        <Input
          value={prefs.proxyUrl}
          disabled={disabled}
          onChange={(event) => page.setPrefs({ proxyUrl: event.target.value })}
          placeholder={t("scoop.proxy.placeholder")}
          spellCheck={false}
          className="font-mono text-xs"
        />
      )}
    </div>
  );
}
