import { useAppTranslation } from "@/hooks/use-app-translation";

export function AgentThinkingBlock() {
  const { t } = useAppTranslation();
  return <div className="text-muted-foreground text-xs">{t("agentChat.thinking.title")}</div>;
}
