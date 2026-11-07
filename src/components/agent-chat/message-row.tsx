import { useAppTranslation } from "@/hooks/use-app-translation";

export function AgentMessageRow() {
  const { t } = useAppTranslation();
  return <div className="py-1 text-sm">{t("agentChat.message.assistant")}</div>;
}
