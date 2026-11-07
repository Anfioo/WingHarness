import { useAppTranslation } from "@/hooks/use-app-translation";

export function AgentQuestionCard() {
  const { t } = useAppTranslation();
  return <div className="rounded-md border p-2 text-sm">{t("agentChat.question.title")}</div>;
}
