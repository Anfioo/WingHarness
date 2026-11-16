import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAppTranslation } from "@/hooks/use-app-translation";
import type { ScoopPageController } from "@/hooks/use-scoop-page";
import { KNOWN_BUCKETS, parseBucketInput, type ScoopBucketParse } from "@/lib/scoop/input";

/**
 * The buckets cloned under the install folder, and the one line that manages
 * them: a bucket to clone, or an app to install from a cloned one.
 */
export function ScoopBucketsPanel({ page }: { page: ScoopPageController }) {
  const { t } = useAppTranslation();
  const status = page.status;
  const [line, setLine] = useState("");
  const [error, setError] = useState<string | null>(null);
  const busy = page.running !== null || page.preparing;
  const knownNames = Object.keys(KNOWN_BUCKETS).join(", ");
  const parsed = useMemo(() => parseBucketInput(line), [line]);

  if (!status) return null;

  const errorText = (failure: Extract<ScoopBucketParse, { ok: false }>) => {
    switch (failure.reason) {
      case "unknown":
        return t("scoop.buckets.error.unknown", { value: failure.value, buckets: knownNames });
      case "name":
        return t("scoop.buckets.error.name", { value: failure.value });
      case "url":
        return t("scoop.buckets.error.url", { value: failure.value });
      case "tooMany":
        return t("scoop.buckets.error.tooMany");
      default:
        return t("scoop.buckets.error.empty");
    }
  };

  const submit = () => {
    const result = parseBucketInput(line);
    if (!result.ok) {
      setError(errorText(result));
      return;
    }

    const action = result.action;
    if (action.kind === "install") {
      const cloned =
        !action.bucket || status.buckets.some((bucket) => bucket.name === action.bucket);
      if (!cloned) {
        setError(t("scoop.buckets.notAdded", { bucket: action.bucket }));
        return;
      }
    }

    setError(null);
    setLine("");
    if (action.kind === "add") void page.addBucket(action.name, action.url);
    else void page.installApp(action.spec);
  };

  const submitLabel =
    parsed.ok && parsed.action.kind === "install"
      ? t("scoop.buckets.install")
      : t("scoop.buckets.submit");

  return (
    <div className="space-y-4">
      <section className="border-border space-y-3 rounded-xl border p-4">
        <h2 className="text-sm font-semibold">{t("scoop.buckets.addTitle")}</h2>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={line}
            onChange={(event) => setLine(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") submit();
            }}
            placeholder={t("scoop.buckets.placeholder")}
            spellCheck={false}
            className="min-w-56 flex-1 font-mono text-xs"
            disabled={busy}
          />
          <Button disabled={busy || !line.trim()} onClick={submit}>
            {submitLabel}
          </Button>
        </div>
        {error && <p className="text-destructive text-xs">{error}</p>}
        <p className="text-muted-foreground text-xs">
          {t("scoop.buckets.hint", { buckets: knownNames })}
        </p>
      </section>

      <section className="border-border rounded-xl border">
        <header className="border-border flex items-center justify-between gap-2 border-b px-4 py-2">
          <h2 className="text-sm font-semibold">{t("scoop.buckets.title")}</h2>
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground text-xs">
              {t("scoop.buckets.count", { count: status.buckets.length })}
            </span>
            {status.buckets.length > 0 && (
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                title={t("scoop.buckets.updateAllTitle")}
                onClick={() => void page.updateBuckets()}
              >
                {t("scoop.buckets.updateAll")}
              </Button>
            )}
          </div>
        </header>

        {status.buckets.length === 0 ? (
          <p className="text-muted-foreground px-4 py-3 text-xs">{t("scoop.buckets.empty")}</p>
        ) : (
          <>
            <p className="text-muted-foreground border-border border-b px-4 py-2 text-xs">
              {t("scoop.buckets.updateHint")}
            </p>
            <ul className="divide-border divide-y">
              {status.buckets.map((bucket) => (
                <li key={bucket.name} className="flex items-start gap-3 px-4 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium">{bucket.name}</span>
                      <span className="text-muted-foreground text-xs">
                        {t("scoop.buckets.apps", { count: bucket.apps })}
                      </span>
                    </div>
                    <p className="text-muted-foreground mt-0.5 font-mono text-[11px] break-all">
                      {bucket.path}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </div>
  );
}
