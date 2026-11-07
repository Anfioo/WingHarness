import { useAppTranslation } from "@/hooks/use-app-translation";

export function AgentEnginePicker() {
  const { t } = useAppTranslation();
  return <div className="text-muted-foreground text-sm">{t("agentChat.engine.label")}</div>;
}
