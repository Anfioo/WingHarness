// The right-hand metadata sheet for one package or one bucket, opened from a
// row. A bucket lists its own manifests, so a package opens on top of it and
// the header grows a back button.

import { ExternalLink, ChevronLeft } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { scoopBucketInfo, scoopPackageInfo } from "@/commands";
import type { ScoopBucketInfo, ScoopDetailTarget, ScoopPackageInfo } from "@/commands";
import { useAppTranslation } from "@/hooks/use-app-translation";
import type { ScoopPageController } from "@/hooks/use-scoop-page";
import { cn } from "@/lib/utils";

type DetailData =
  | { kind: "bucket"; info: ScoopBucketInfo }
  | { kind: "package"; info: ScoopPackageInfo };

/** One label/value line inside a detail card. */
function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 text-sm">
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span className="min-w-0 text-right break-words">{children}</span>
    </div>
  );
}

function SectionTitle({ children }: { children: ReactNode }) {
  return <h3 className="text-foreground text-sm font-medium">{children}</h3>;
}

function Card({ children }: { children: ReactNode }) {
  return <div className="bg-muted/40 flex flex-col gap-1.5 rounded-lg p-3">{children}</div>;
}

/** A long value printed under its label, so paths and URLs can wrap. */
function LongField({
  label,
  value,
  unknown,
}: {
  label: string;
  value: string | null;
  unknown: string;
}) {
  return (
    <div className="border-border/60 flex flex-col gap-1 border-t pt-1.5">
      <span className="text-muted-foreground text-xs">{label}</span>
      {value ? (
        <span className="font-mono text-xs break-all select-text">{value}</span>
      ) : (
        <span className="text-sm">{unknown}</span>
      )}
    </div>
  );
}

/** A website or repository address, linked when it is one. */
function LinkValue({ value, unknown }: { value: string | null; unknown: string }) {
  if (!value) return <span>{unknown}</span>;
  if (!/^https?:\/\//i.test(value)) {
    return <span className="font-mono text-xs break-all select-text">{value}</span>;
  }
  return (
    <a
      href={value}
      target="_blank"
      rel="noreferrer"
      className="text-primary inline-flex items-center gap-1 break-all hover:underline"
    >
      <span className="font-mono text-xs">{value}</span>
      <ExternalLink className="size-3 shrink-0" />
    </a>
  );
}

function Chips({ values, unknown }: { values: string[]; unknown: string }) {
  if (values.length === 0) return <span className="text-muted-foreground">{unknown}</span>;
  return (
    <span className="flex flex-wrap justify-end gap-1">
      {values.map((value) => (
        <Badge key={value} variant="secondary" className="font-mono text-[10px]">
          {value}
        </Badge>
      ))}
    </span>
  );
}

function DetailSkeleton() {
  return (
    <div className="flex flex-col gap-5">
      {[0, 1, 2].map((section) => (
        <div key={section} className="flex flex-col gap-2">
          <Skeleton className="h-4 w-24" />
          <div className="bg-muted/40 flex flex-col gap-2 rounded-lg p-3">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-4/5" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        </div>
      ))}
    </div>
  );
}

function PackageBody({ info }: { info: ScoopPackageInfo }) {
  const { t } = useAppTranslation();
  const unknown = t("scoop.detail.unknown");
  const license = info.license ?? info.licenseUrl;

  return (
    <Tabs defaultValue="details" className="gap-3">
      <TabsList>
        <TabsTrigger value="details">{t("scoop.detail.tabs.details")}</TabsTrigger>
        <TabsTrigger value="manifest">{t("scoop.detail.tabs.manifest")}</TabsTrigger>
      </TabsList>

      <TabsContent value="details" className="flex flex-col gap-5">
        <section className="flex flex-col gap-2">
          <SectionTitle>{t("scoop.detail.section.package")}</SectionTitle>
          <Card>
            <InfoRow label={t("scoop.detail.field.version")}>
              <span className="font-mono">{info.version ?? unknown}</span>
            </InfoRow>
            {info.installed && (
              <InfoRow label={t("scoop.detail.field.installedVersion")}>
                <span className="font-mono">{info.installedVersion ?? unknown}</span>
              </InfoRow>
            )}
            <InfoRow label={t("scoop.detail.field.bucket")}>{info.bucket ?? unknown}</InfoRow>
            <InfoRow label={t("scoop.detail.field.homepage")}>
              <LinkValue value={info.homepage} unknown={unknown} />
            </InfoRow>
            <InfoRow label={t("scoop.detail.field.license")}>
              {info.licenseUrl ? (
                <a
                  href={info.licenseUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-primary hover:underline"
                >
                  {license}
                </a>
              ) : (
                (license ?? unknown)
              )}
            </InfoRow>
          </Card>
          {info.description && <p className="text-sm">{info.description}</p>}
        </section>

        {(info.depends.length > 0 || info.suggests.length > 0 || info.bins.length > 0) && (
          <section className="flex flex-col gap-2">
            <SectionTitle>{t("scoop.detail.section.dependencies")}</SectionTitle>
            <Card>
              {info.depends.length > 0 && (
                <InfoRow label={t("scoop.detail.field.depends")}>
                  <Chips values={info.depends} unknown={unknown} />
                </InfoRow>
              )}
              {info.suggests.length > 0 && (
                <InfoRow label={t("scoop.detail.field.suggests")}>
                  <Chips values={info.suggests} unknown={unknown} />
                </InfoRow>
              )}
              {info.bins.length > 0 && (
                <InfoRow label={t("scoop.detail.field.bins")}>
                  <Chips values={info.bins} unknown={unknown} />
                </InfoRow>
              )}
            </Card>
          </section>
        )}

        {info.notes && (
          <section className="flex flex-col gap-2">
            <SectionTitle>{t("scoop.detail.section.notes")}</SectionTitle>
            <pre className="bg-muted/40 rounded-lg p-3 font-mono text-xs whitespace-pre-wrap select-text">
              {info.notes}
            </pre>
          </section>
        )}

        <section className="flex flex-col gap-2">
          <SectionTitle>{t("scoop.detail.section.source")}</SectionTitle>
          <Card>
            <LongField
              label={t("scoop.detail.field.manifestPath")}
              value={info.manifestPath}
              unknown={unknown}
            />
          </Card>
        </section>
      </TabsContent>

      <TabsContent value="manifest">
        <pre className="bg-muted/40 max-h-full overflow-auto rounded-lg p-3 font-mono text-[11px] select-text">
          {info.manifest}
        </pre>
      </TabsContent>
    </Tabs>
  );
}

function BucketBody({
  info,
  onOpenPackage,
}: {
  info: ScoopBucketInfo;
  onOpenPackage: (name: string) => void;
}) {
  const { t, language } = useAppTranslation();
  const unknown = t("scoop.detail.unknown");
  const [filter, setFilter] = useState("");

  const packages = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return info.packages;
    return info.packages.filter((name) => name.includes(needle));
  }, [filter, info.packages]);

  const committedAt =
    info.committedAt != null ? new Date(info.committedAt * 1000).toLocaleString(language) : null;

  return (
    <>
      <section className="flex flex-col gap-2">
        <SectionTitle>{t("scoop.detail.section.repository")}</SectionTitle>
        <Card>
          <InfoRow label={t("scoop.detail.field.remote")}>
            <LinkValue value={info.remote} unknown={unknown} />
          </InfoRow>
          <InfoRow label={t("scoop.detail.field.branch")}>
            <span className="font-mono">{info.branch ?? unknown}</span>
          </InfoRow>
          <InfoRow label={t("scoop.detail.field.commit")}>
            <span className="font-mono">{info.commit ?? unknown}</span>
          </InfoRow>
          <InfoRow label={t("scoop.detail.field.committedAt")}>{committedAt ?? unknown}</InfoRow>
          <LongField
            label={t("scoop.detail.field.subject")}
            value={info.subject}
            unknown={unknown}
          />
          <LongField label={t("scoop.detail.field.path")} value={info.path} unknown={unknown} />
        </Card>
      </section>

      <section className="flex flex-col gap-2">
        <header className="flex flex-wrap items-center justify-between gap-2">
          <SectionTitle>{t("scoop.detail.section.packages")}</SectionTitle>
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground text-xs">
              {t("scoop.detail.packageCount", { count: info.packages.length })}
            </span>
            <Input
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder={t("scoop.detail.filter")}
              spellCheck={false}
              className="h-8 w-40 font-mono text-xs"
            />
          </div>
        </header>

        {info.packages.length === 0 ? (
          <p className="text-muted-foreground text-xs">{t("scoop.detail.noPackages")}</p>
        ) : packages.length === 0 ? (
          <p className="text-muted-foreground text-xs">{t("scoop.detail.noMatches")}</p>
        ) : (
          <ul className="divide-border border-border divide-y rounded-lg border">
            {packages.map((name) => (
              <li key={name}>
                <button
                  type="button"
                  onClick={() => onOpenPackage(name)}
                  className={cn(
                    "hover:bg-muted/60 flex w-full items-center justify-between gap-2 px-3 py-1.5 text-start",
                    "focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none"
                  )}
                >
                  <span className="truncate font-mono text-xs">{name}</span>
                  <ChevronLeft className="text-muted-foreground size-3.5 shrink-0 rotate-180" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

export function ScoopDetailSheet({ page }: { page: ScoopPageController }) {
  const { t } = useAppTranslation();
  const [trail, setTrail] = useState<ScoopDetailTarget[]>([]);
  const [data, setData] = useState<DetailData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // `page.detail` seeds the trail; a bucket then pushes its packages on top of
  // itself instead of opening a second sheet.
  useEffect(() => {
    setTrail(page.detail ? [page.detail] : []);
  }, [page.detail]);

  const current = trail.length > 0 ? trail[trail.length - 1] : null;

  useEffect(() => {
    if (current === null) {
      setData(null);
      setError(null);
      setLoading(false);
      return;
    }

    // A response that lands after the sheet closed or moved on is stale.
    let cancelled = false;
    setData(null);
    setError(null);
    setLoading(true);

    const request: Promise<DetailData> =
      current.kind === "bucket"
        ? scoopBucketInfo(current.name).then((info) => ({ kind: "bucket", info }))
        : scoopPackageInfo(current.name, current.bucket, current.global).then((info) => ({
            kind: "package",
            info,
          }));

    request
      .then((next) => {
        if (!cancelled) setData(next);
      })
      .catch((failure: unknown) => {
        if (!cancelled) setError(failure instanceof Error ? failure.message : String(failure));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [current]);

  const back = trail.length > 1 ? () => setTrail((entries) => entries.slice(0, -1)) : null;

  const close = () => page.closeDetail();

  const openPackage = (name: string) => {
    if (!current || current.kind !== "bucket") return;
    setTrail((entries) => [
      ...entries,
      { kind: "package", name, bucket: current.name, global: false },
    ]);
  };

  const installable = data?.kind === "package" && !data.info.installed ? data.info.name : null;
  const busy = page.running !== null || page.preparing;

  return (
    <Sheet
      open={current !== null}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <SheetContent className="w-full gap-0 sm:max-w-lg">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            {back && (
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={back}
                title={t("scoop.detail.back")}
                aria-label={t("scoop.detail.back")}
              >
                <ChevronLeft />
              </Button>
            )}
            <span className="truncate font-mono">{current?.name ?? ""}</span>
            {data?.kind === "package" && data.info.installed && (
              <Badge variant="outline" className="text-[10px]">
                {t("scoop.detail.installed")}
              </Badge>
            )}
          </SheetTitle>
          <SheetDescription>
            {current?.kind === "bucket"
              ? t("scoop.detail.bucketSubtitle")
              : t("scoop.detail.packageSubtitle")}
          </SheetDescription>
        </SheetHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-4 pb-4">
          {loading ? (
            <DetailSkeleton />
          ) : error !== null ? (
            <div
              role="alert"
              className="border-destructive/40 bg-destructive/5 text-destructive rounded-lg border px-3 py-2 text-sm"
            >
              {t("scoop.detail.loadFailed")} {error}
            </div>
          ) : data?.kind === "bucket" ? (
            <BucketBody info={data.info} onOpenPackage={openPackage} />
          ) : data?.kind === "package" ? (
            <PackageBody info={data.info} />
          ) : null}
        </div>

        <SheetFooter className="flex-row items-center justify-end gap-2 border-t">
          <Button variant="outline" onClick={close}>
            {t("scoop.detail.close")}
          </Button>
          {installable && (
            <Button
              disabled={busy}
              onClick={() => {
                page.installApp(installable);
                close();
              }}
            >
              {t("scoop.detail.install")}
            </Button>
          )}
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
