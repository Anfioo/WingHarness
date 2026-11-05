import { useEffect, useRef } from "react";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { ensureEngineLine, useGitConsole } from "./git-console";

const two = (value: number) => value.toString().padStart(2, "0");

/** `09:47:00.423`, the stamp the IDE's console puts in front of every command. */
function stamp(at: number): string {
  const date = new Date(at);
  return `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}.${date
    .getMilliseconds()
    .toString()
    .padStart(3, "0")}`;
}

/**
 * The Git tool window's console: the commands the project page asked for, and
 * what came back.
 *
 * The window follows the output while it is scrolled to the bottom and stays
 * put once the reader scrolls up, so a refresh cannot yank the text away.
 */
export function ConsolePane({ repo }: { repo: string | null }) {
  const { t } = useAppTranslation();
  const entries = useGitConsole((state) => state.entries);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);

  useEffect(() => {
    ensureEngineLine();
  }, []);

  useEffect(() => {
    const element = scrollRef.current;
    if (element && pinnedRef.current) element.scrollTop = element.scrollHeight;
  }, [entries]);

  const onScroll = () => {
    const element = scrollRef.current;
    if (!element) return;
    pinnedRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
  };

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      className="min-h-0 flex-1 cursor-text overflow-auto px-2.5 py-1.5 font-mono text-[11px] leading-[18px] select-text"
    >
      {entries.length === 0 ? (
        <p className="text-muted-foreground font-sans text-xs">{t("projectGit.consoleEmpty")}</p>
      ) : (
        entries.map((entry) => (
          <div key={entry.id} className="[overflow-wrap:anywhere] whitespace-pre-wrap">
            <span className="text-faint">{stamp(entry.at)}: </span>
            <span className="text-muted-foreground">[{entry.repo ?? repo ?? "git"}] </span>
            <span className={entry.failed ? "text-destructive" : "text-foreground"}>
              {entry.command}
            </span>
            {entry.output && (
              <div className={entry.failed ? "text-destructive" : "text-muted-foreground"}>
                {entry.output}
              </div>
            )}
          </div>
        ))
      )}
    </div>
  );
}
