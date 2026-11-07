import { useAppTranslation } from "@/hooks/use-app-translation";

export function AgentPermissionPicker() {
  const { t } = useAppTranslation();
  return <div className="text-muted-foreground text-sm">{t("agentChat.permission.label")}</div>;
}
