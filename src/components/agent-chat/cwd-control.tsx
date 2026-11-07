import { useAppTranslation } from "@/hooks/use-app-translation";

export function AgentCwdControl() {
  const { t } = useAppTranslation();
  return <div className="text-muted-foreground text-sm">{t("agentChat.cwd.label")}</div>;
}
