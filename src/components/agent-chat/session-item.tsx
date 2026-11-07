import { useAppTranslation } from "@/hooks/use-app-translation";

export function AgentSessionItem() {
  const { t } = useAppTranslation();
  return <div className="text-muted-foreground text-sm">{t("agentChat.sidebar.untitled")}</div>;
}
