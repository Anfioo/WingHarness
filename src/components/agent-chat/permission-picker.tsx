// Permission-mode selection for the active tab's engine.
//
// Only the modes the engine declares are rendered; unsupported modes are
// absent rather than disabled, matching how each CLI differs.

import type { JSX } from "react";

import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { useAgentChatStore } from "@/features/agent-chat/store";
import { useAppTranslation } from "@/hooks/use-app-translation";

const PERMISSION_KEYS: Record<string, string> = {
  auto: "agentChat.permission.auto",
  manual: "agentChat.permission.manual",
  plan: "agentChat.permission.plan",
  bypass: "agentChat.permission.bypass",
};

export function AgentPermissionPicker(): JSX.Element {
  const { t } = useAppTranslation();
  const engine = useAgentChatStore(
    (state) => state.tabs.find((tab) => tab.tabId === state.activeTabId)?.engine ?? null
  );
  const engines = useAgentChatStore((state) => state.engines);
  const permission = useAgentChatStore((state) =>
    engine ? (state.enginePrefs[engine]?.permission ?? "") : ""
  );
  const setPermission = useAgentChatStore((state) => state.setPermission);

  const modes = engines.find((item) => item.id === engine)?.permissions ?? [];
  const mode = permission && modes.includes(permission) ? permission : (modes[0] ?? "");
  const labelOf = (value: string) => t(PERMISSION_KEYS[value] ?? value);

  return (
    <Select
      value={mode}
      onValueChange={(value) => {
        if (engine) void setPermission(engine, value);
      }}
      disabled={!engine || modes.length === 0}
    >
      <SelectTrigger
        size="sm"
        className="h-8 w-28"
        aria-label={t("agentChat.permission.label")}
        title={t("agentChat.permission.label")}
      >
        <span className="truncate">{mode ? labelOf(mode) : t("agentChat.permission.label")}</span>
      </SelectTrigger>
      <SelectContent>
        {modes.map((item) => (
          <SelectItem key={item} value={item}>
            {labelOf(item)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
