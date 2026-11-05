import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { KeyValue } from "@/lib/api-core/types";

/**
 * The response header table: a read-only two-column list of the headers the
 * server returned. Every header is shown; response headers carry no per-row
 * enable flag, so the whole list is rendered.
 */
export function HeadersView({ headers }: { headers: KeyValue[] }): ReactNode {
  const { t } = useTranslation("translation", { keyPrefix: "apiClient.response" });

  if (headers.length === 0) {
    return <p className="text-muted-foreground px-1 py-2 text-[11px]">{t("headers.empty")}</p>;
  }

  return (
    <div className="flex flex-col">
      <div className="text-muted-foreground border-border grid grid-cols-[minmax(0,0.4fr)_minmax(0,0.6fr)] gap-x-3 border-b px-1 pb-1.5 text-[10px] font-semibold tracking-wide uppercase">
        <span>{t("headers.name")}</span>
        <span>{t("headers.value")}</span>
      </div>
      {headers.map((header, index) => (
        <div
          key={index}
          className="border-border/50 grid grid-cols-[minmax(0,0.4fr)_minmax(0,0.6fr)] gap-x-3 border-b px-1 py-1 text-xs"
        >
          <span className="text-muted-foreground font-mono break-all">{header.key}</span>
          <span className="font-mono break-all">{header.value}</span>
        </div>
      ))}
    </div>
  );
}

export default HeadersView;
