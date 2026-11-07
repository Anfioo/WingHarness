import { useAppTranslation } from "@/hooks/use-app-translation";

export function AgentSessionTabs() {
  const { t } = useAppTranslation();
  return (
    <div className="text-muted-foreground shrink-0 border-b px-3 py-2 text-sm">
      {t("agentChat.tab.untitled")}
    </div>
  );
}
