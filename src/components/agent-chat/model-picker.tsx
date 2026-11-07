import { useAppTranslation } from "@/hooks/use-app-translation";

export function AgentModelPicker() {
  const { t } = useAppTranslation();
  return <div className="text-muted-foreground text-sm">{t("agentChat.model.label")}</div>;
}
