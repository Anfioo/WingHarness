import type { ScoopStatus } from "@/commands";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { samePath } from "@/lib/scoop/page";
import { InfoRow } from "./info-row";

/**
 * The two folders, their two links and the two variables, always in that
 * order: the link row shows `link → folder`, the variable row shows which link
 * it holds and the real path behind it.
 */
export function ScoopPathRows({ status }: { status: ScoopStatus }) {
  const { t } = useAppTranslation();

  const link = (linkPath: string, target: string) =>
    t("scoop.overview.linkValue", { link: linkPath, target });

  const env = (value: string | null, linkPath: string, target: string) => {
    if (!value) return t("scoop.overview.envMissing");
    return samePath(value, linkPath)
      ? t("scoop.overview.envValue", { link: value, target })
      : value;
  };

  return (
    <>
      <InfoRow label={t("scoop.overview.scoopFolder")} value={status.target} />
      <InfoRow label={t("scoop.overview.globalFolder")} value={status.globalTarget} />
      <InfoRow label={t("scoop.overview.scoopLink")} value={link(status.root, status.target)} />
      <InfoRow
        label={t("scoop.overview.globalLink")}
        value={link(status.globalRoot, status.globalTarget)}
      />
      <InfoRow
        label={t("scoop.overview.scoopEnv")}
        value={env(status.envScoop, status.root, status.target)}
      />
      <InfoRow
        label={t("scoop.overview.globalEnv")}
        value={env(status.envScoopGlobal, status.globalRoot, status.globalTarget)}
      />
    </>
  );
}
