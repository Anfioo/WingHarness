import { aiCliRun, httpRequest } from "@/commands";
import { createAiProvider, type AiProvider } from "@/lib/git-core/ai";
import { useAi, type AiSettings } from "./store";

export function getAiProvider(): AiProvider {
  const { ai } = useAi.getState();
  return createAiProvider(
    {
      provider: ai.provider,
      apiKey: ai.apiKey,
      model: ai.model,
      baseUrl: ai.baseUrl || undefined,
      cliAgent: ai.cliAgent || undefined,
      cliPath: ai.cliPath || undefined,
    },
    (request) => httpRequest(request),
    (request) => aiCliRun(request)
  );
}

export function aiConfigured(): boolean {
  const { ai } = useAi.getState();
  if (ai.provider === "cli") return !!ai.cliAgent;
  if (ai.provider === "ollama" || ai.provider === "lmstudio") return !!ai.model;
  return !!ai.apiKey && !!ai.model;
}

/**
 * Identity of the settings a connection test covered. A result only describes
 * the configuration it ran against, so a different signature makes it stale.
 */
export function aiConfigSignature(ai: AiSettings = useAi.getState().ai): string {
  return [ai.provider, ai.baseUrl, ai.model, ai.apiKey, ai.cliAgent, ai.cliPath].join("\u0000");
}
