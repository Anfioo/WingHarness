import { useAppTranslation } from "@/hooks/use-app-translation";

export function AgentGrantCard() {
  const { t } = useAppTranslation();
  return <div className="rounded-md border p-2 text-sm">{t("agentChat.grant.title")}</div>;
}
