import { useAppTranslation } from "@/hooks/use-app-translation";
import type { ScoopPageController } from "@/hooks/use-scoop-page";

/** The buckets cloned under the install folder. */
export function ScoopBucketsPanel({ page }: { page: ScoopPageController }) {
  const { t } = useAppTranslation();
  const status = page.status;
  if (!status) return null;

  return (
    <section className="border-border rounded-xl border">
      <header className="border-border flex items-center justify-between gap-2 border-b px-4 py-2">
        <h2 className="text-sm font-semibold">{t("scoop.buckets.title")}</h2>
        <span className="text-muted-foreground text-xs">
          {t("scoop.buckets.count", { count: status.buckets.length })}
        </span>
      </header>

      {status.buckets.length === 0 ? (
        <p className="text-muted-foreground px-4 py-3 text-xs">{t("scoop.buckets.empty")}</p>
      ) : (
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
      )}
    </section>
  );
}
