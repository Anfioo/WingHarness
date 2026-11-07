import { useAppTranslation } from "@/hooks/use-app-translation";

export function AgentComposer() {
  const { t } = useAppTranslation();
  return (
    <div className="text-muted-foreground shrink-0 border-t p-3 text-sm">
      {t("agentChat.composer.placeholder")}
    </div>
  );
}
