import { useAppTranslation } from "@/hooks/use-app-translation";

export function AgentToolCard() {
  const { t } = useAppTranslation();
  return <div className="rounded-md border p-2 text-sm">{t("agentChat.tool.result")}</div>;
}
