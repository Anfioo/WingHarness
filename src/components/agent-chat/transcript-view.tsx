import { AgentMarkdownBody } from "./markdown-body";
import { useAppTranslation } from "@/hooks/use-app-translation";

export function AgentTranscriptView() {
  const { t } = useAppTranslation();
  return (
    <div className="text-muted-foreground flex-1 overflow-auto p-4 text-sm">
      <p>{t("agentChat.history.empty")}</p>
      <AgentMarkdownBody />
    </div>
  );
}
