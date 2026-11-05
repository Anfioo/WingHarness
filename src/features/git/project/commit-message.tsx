import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { History } from "lucide-react";
import { create } from "zustand";
import { gitStoreRead, gitStoreWrite } from "@/commands";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { modKey } from "@/features/git/utils";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { joinCommitMessage, splitCommitMessage } from "@/lib/git-core";

/** How many past messages are kept. */
const HISTORY_LIMIT = 20;
const HISTORY_KEY = "git-commit-history";

interface CommitHistoryState {
  entries: string[];
  loaded: boolean;
  load: () => Promise<void>;
  remember: (message: string) => Promise<void>;
}

/** Recent commit messages, persisted in the git engine's data directory. */
export const useCommitMessageHistory = create<CommitHistoryState>((set, get) => ({
  entries: [],
  loaded: false,
  load: async () => {
    if (get().loaded) return;
    try {
      const raw = await gitStoreRead(HISTORY_KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      const entries = Array.isArray(parsed)
        ? parsed.filter((value): value is string => typeof value === "string")
        : [];
      set({ entries, loaded: true });
    } catch (error) {
      console.error("commit message history:", error);
      set({ loaded: true });
    }
  },
  remember: async (message) => {
    const entry = message.trim();
    if (!entry) return;
    const entries = [entry, ...get().entries.filter((value) => value !== entry)].slice(
      0,
      HISTORY_LIMIT
    );
    set({ entries, loaded: true });
    try {
      await gitStoreWrite(HISTORY_KEY, JSON.stringify(entries));
    } catch (error) {
      console.error("commit message history:", error);
    }
  },
}));

export function rememberCommitMessage(message: string): void {
  void useCommitMessageHistory.getState().remember(message);
}

interface CommitMessageProps {
  message: string;
  /** Number of files the commit will include, for the button label. */
  included: number;
  amend: boolean;
  amendEnabled: boolean;
  busy: boolean;
  canCommit: boolean;
  onChange: (message: string) => void;
  onAmendChange: (amend: boolean) => void;
  onCommit: () => void;
}

/**
 * The commit message and its actions: summary and body fields, the amend
 * switch, the message history, and the commit button.
 */
export function CommitMessage({
  message,
  included,
  amend,
  amendEnabled,
  busy,
  canCommit,
  onChange,
  onAmendChange,
  onCommit,
}: CommitMessageProps) {
  const { t } = useAppTranslation();
  const entries = useCommitMessageHistory((state) => state.entries);
  const loadHistory = useCommitMessageHistory((state) => state.load);
  const [historyOpen, setHistoryOpen] = useState(false);
  const summaryRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  useEffect(() => {
    if (amend) summaryRef.current?.focus();
  }, [amend]);

  const { summary, body } = splitCommitMessage(message);
  const setSummary = (text: string) => onChange(joinCommitMessage(text, body));
  const setBody = (text: string) => onChange(joinCommitMessage(summary, text));

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      if (canCommit && !busy) onCommit();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "m") {
      event.preventDefault();
      if (entries.length) setHistoryOpen(true);
    }
  };

  const label =
    included > 0
      ? t("gitRepo.commit.commit.button", { count: included })
      : t("gitRepo.commit.commit.buttonEmpty");

  return (
    <div className="border-border flex flex-col gap-1.5 border-t px-2 py-2">
      <div className="flex items-center gap-1">
        <label className="text-muted-foreground flex items-center gap-1.5 text-[11px]">
          <input
            type="checkbox"
            className="accent-primary size-3"
            checked={amend}
            disabled={!amendEnabled || busy}
            onChange={(event) => onAmendChange(event.target.checked)}
          />
          {t("gitRepo.commit.commit.amend")}
        </label>
        <span className="flex-1" />
        <DropdownMenu open={historyOpen} onOpenChange={setHistoryOpen}>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              disabled={entries.length === 0}
              aria-label={t("projectGit.commitHistory")}
              title={t("projectGit.commitHistory")}
            >
              <History className="size-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="max-w-80">
            <DropdownMenuLabel>{t("projectGit.commitHistory")}</DropdownMenuLabel>
            {entries.length === 0 ? (
              <DropdownMenuItem disabled>{t("projectGit.commitHistoryEmpty")}</DropdownMenuItem>
            ) : (
              entries.map((entry, index) => (
                <DropdownMenuItem
                  key={`${index}:${entry}`}
                  className="block max-w-80 truncate"
                  title={entry}
                  onClick={() => {
                    onChange(entry);
                    setHistoryOpen(false);
                    summaryRef.current?.focus();
                  }}
                >
                  {entry.split("\n")[0] || entry}
                </DropdownMenuItem>
              ))
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <Input
        ref={summaryRef}
        value={summary}
        placeholder={
          amend
            ? t("gitRepo.commit.commit.summaryPlaceholderAmend")
            : t("gitRepo.commit.commit.summaryPlaceholder")
        }
        aria-label={t("gitRepo.commit.commit.summaryAria")}
        className="h-7 text-xs"
        disabled={busy}
        onChange={(event) => setSummary(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <Textarea
        value={body}
        placeholder={t("gitRepo.commit.commit.bodyPlaceholder")}
        aria-label={t("gitRepo.commit.commit.bodyAria")}
        className="min-h-12 resize-y text-xs"
        disabled={busy}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={onKeyDown}
      />

      <Button
        size="xs"
        className="w-full"
        disabled={!canCommit || busy}
        title={t("projectGit.commitHint", { mod: modKey() })}
        onClick={onCommit}
      >
        <span className="truncate">{label}</span>
      </Button>
    </div>
  );
}
