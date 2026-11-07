import { useEffect } from "react";

import { AppShell } from "@/components/app-shell";
import { AgentSessionSidebar } from "@/components/agent-chat/session-sidebar";
import { AgentSessionTabs } from "@/components/agent-chat/session-tabs";
import { AgentTranscriptView } from "@/components/agent-chat/transcript-view";
import { AgentComposer } from "@/components/agent-chat/composer";
import { useAgentChatStore } from "@/features/agent-chat/store";

export default function AgentChatPage() {
  useEffect(() => {
    void useAgentChatStore.getState().init();
  }, []);

  return (
    <AppShell>
      <section className="flex h-full w-full overflow-hidden">
        <AgentSessionSidebar />
        <div className="flex min-w-0 flex-1 flex-col">
          <AgentSessionTabs />
          <AgentTranscriptView />
          <AgentComposer />
        </div>
      </section>
    </AppShell>
  );
}
