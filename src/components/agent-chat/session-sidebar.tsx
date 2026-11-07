import { useAppTranslation } from "@/hooks/use-app-translation";

export function AgentSessionSidebar() {
  const { t } = useAppTranslation();
  return (
    <aside className="text-muted-foreground w-[260px] shrink-0 border-r p-3 text-sm">
      {t("agentChat.sidebar.title")}
    </aside>
  );
}
