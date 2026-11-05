/**
 * The model field: a free-text box plus a dropdown of the models the active
 * Claude provider really serves.
 *
 * The list comes from the provider's own `GET /v1/models` (the same call the
 * CC Switch provider form uses), not from a hard-coded alias table: the CLI does
 * accept `opus`/`sonnet`/`haiku`, but a provider behind `ANTHROPIC_BASE_URL`
 * usually serves entirely different names, and a variant id such as
 * `deepseek-v4.1-flash[1M]` only exists as free text — which is why the input
 * stays editable.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, Loader2 } from "lucide-react";
import { ccsFetchModels, ccsGetCurrentProvider, ccsGetProviders } from "@/commands";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useAppTranslation } from "@/hooks/use-app-translation";

/** One row of the dropdown; `id` of "" is the "follow the CLI config" entry. */
function ModelItem({
  label,
  hint,
  onSelect,
}: {
  label: string;
  hint?: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className="hover:bg-accent flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-sm"
    >
      <span className="truncate font-mono text-xs">{label}</span>
      {hint && <span className="text-muted-foreground shrink-0 text-xs">{hint}</span>}
    </button>
  );
}

export function ModelPicker({
  value,
  disabled,
  onChange,
}: {
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const { t } = useAppTranslation();
  const [draft, setDraft] = useState(value);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [models, setModels] = useState<string[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  // The field is free text, so it follows the committed value from outside.
  useEffect(() => setDraft(value), [value]);

  const load = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      const [providers, current] = await Promise.all([
        ccsGetProviders("claude"),
        ccsGetCurrentProvider("claude"),
      ]);
      const provider = providers.find((item) => item.id === current) ?? providers[0];
      if (!provider) {
        setModels([]);
        return;
      }
      const list = await ccsFetchModels("claude", provider);
      setModels(list.map((model) => model.id));
    } catch {
      setFailed(true);
      setModels([]);
    } finally {
      setLoading(false);
    }
  }, []);

  // Fetched the first time the list opens: the chat page rarely needs it, and an
  // unreachable provider must not delay the conversation.
  useEffect(() => {
    if (open && models === null && !loading) void load();
  }, [open, models, loading, load]);

  const commit = () => {
    const next = draft.trim();
    if (next !== value) onChange(next);
  };

  const q = query.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (!q) return models ?? [];
    return (models ?? []).filter((id) => id.toLowerCase().includes(q));
  }, [models, q]);

  const choose = (next: string) => {
    setDraft(next);
    onChange(next);
    setOpen(false);
    setQuery("");
  };

  return (
    <div className="flex items-center gap-1">
      <Input
        className="h-9 w-44 font-mono text-xs"
        value={draft}
        disabled={disabled}
        placeholder={t("claudeChat.modelDefault")}
        title={t("claudeChat.modelHint")}
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
      />
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            size="icon"
            className="size-9 shrink-0"
            disabled={disabled}
            aria-label={t("claudeChat.modelDefault")}
            title={t("claudeChat.modelDefault")}
          >
            {loading ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <ChevronDown className="size-4" />
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-72 p-0">
          <div className="border-b p-2">
            <Input
              className="h-8"
              value={query}
              placeholder={t("claudeChat.modelSearch")}
              onChange={(event) => setQuery(event.target.value)}
              autoFocus
            />
          </div>
          <div className="max-h-64 overflow-y-auto p-1">
            {loading && models === null ? (
              <p className="text-muted-foreground px-2 py-6 text-center text-sm">
                {t("claudeChat.modelLoading")}
              </p>
            ) : (
              <>
                {!q && (
                  <ModelItem label={t("claudeChat.modelDefault")} onSelect={() => choose("")} />
                )}
                {filtered.length === 0 ? (
                  <p className="text-muted-foreground px-2 py-6 text-center text-sm">
                    {failed ? t("claudeChat.modelFetchFailed") : t("claudeChat.modelEmpty")}
                  </p>
                ) : (
                  filtered.map((id) => (
                    <ModelItem key={id} label={id} onSelect={() => choose(id)} />
                  ))
                )}
              </>
            )}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
