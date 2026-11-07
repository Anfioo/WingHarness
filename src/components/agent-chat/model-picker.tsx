// Model selection for the active tab's engine.
//
// Candidates come from `AgentEngineInfo.models`; an empty value means "let the
// CLI pick". "Custom" swaps the select for a free-text input because variants
// behind a proxy are not always listed by the CLI.

import { useEffect, useState } from "react";
import type { JSX } from "react";
import { Check } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { useAgentChatStore } from "@/features/agent-chat/store";
import { useAppTranslation } from "@/hooks/use-app-translation";

const CLI_DEFAULT = "__cli_default__";
const CUSTOM = "__custom_model__";

export function AgentModelPicker(): JSX.Element {
  const { t } = useAppTranslation();
  const engine = useAgentChatStore(
    (state) => state.tabs.find((tab) => tab.tabId === state.activeTabId)?.engine ?? null
  );
  const engines = useAgentChatStore((state) => state.engines);
  const model = useAgentChatStore((state) =>
    engine ? (state.enginePrefs[engine]?.model ?? "") : ""
  );
  const setModel = useAgentChatStore((state) => state.setModel);
  const [custom, setCustom] = useState(false);
  const [draft, setDraft] = useState(model);

  useEffect(() => setDraft(model), [model]);
  useEffect(() => setCustom(false), [engine]);

  const models = engines.find((item) => item.id === engine)?.models ?? [];
  // A stored custom id has no matching item; leave the root unselected so the
  // "custom" row still fires when the user reopens it.
  const selectValue = model === "" ? CLI_DEFAULT : models.includes(model) ? model : "";

  function commit() {
    setCustom(false);
    const next = draft.trim();
    if (engine && next !== model) void setModel(engine, next);
  }

  function cancel() {
    setDraft(model);
    setCustom(false);
  }

  if (custom) {
    return (
      <div className="flex items-center gap-1">
        <Input
          className="h-8 w-44 font-mono text-xs"
          value={draft}
          autoFocus
          placeholder={t("agentChat.model.placeholder")}
          aria-label={t("agentChat.model.label")}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commit();
            } else if (event.key === "Escape") {
              event.preventDefault();
              cancel();
            }
          }}
        />
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={commit}
          aria-label={t("agentChat.question.submit")}
        >
          <Check />
        </Button>
      </div>
    );
  }

  return (
    <Select
      value={selectValue}
      onValueChange={(value) => {
        if (value === CUSTOM) {
          setDraft(model);
          setCustom(true);
          return;
        }
        if (!engine) return;
        void setModel(engine, value === CLI_DEFAULT ? "" : value);
      }}
      disabled={!engine}
    >
      <SelectTrigger
        size="sm"
        className="h-8 w-44"
        aria-label={t("agentChat.model.label")}
        title={model || t("agentChat.model.placeholder")}
      >
        <span className={model ? "truncate font-mono text-xs" : "text-muted-foreground truncate"}>
          {model || t("agentChat.model.placeholder")}
        </span>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={CLI_DEFAULT}>{t("agentChat.model.placeholder")}</SelectItem>
        {models.map((id) => (
          <SelectItem key={id} value={id} className="font-mono text-xs">
            {id}
          </SelectItem>
        ))}
        <SelectItem value={CUSTOM}>{t("agentChat.model.custom")}</SelectItem>
      </SelectContent>
    </Select>
  );
}
