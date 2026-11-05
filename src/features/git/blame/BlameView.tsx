import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { toast } from "sonner";
import { Copy, GitCommitHorizontal, Loader2, UserRoundSearch } from "lucide-react";
import type { BlameHunk, FileBlame } from "@/lib/git-core";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { fileBlame } from "@/commands";
import { useRepo } from "@/features/git/repository-store";
import { AuthorAvatar } from "@/features/git/inspector/author-avatar";
import { embeddedLanguages, highlightLine, languageOf } from "@/lib/git-core/highlight";
import { formatDate, timeAgo } from "@/features/git/utils";

const ROW_HEIGHT = 22;

export function BlameView({
  file,
  rev,
  onOpenCommit,
  onBlameAt,
  onResolvedRev,
}: {
  file: string;
  rev: string | null;
  onOpenCommit: (oid: string) => void;
  onBlameAt: (rev: string) => void;
  onResolvedRev: (oid: string) => void;
}) {
  const { t } = useAppTranslation();
  const path = useRepo((s) => s.repo?.path ?? "");
  const scrollRef = useRef<HTMLDivElement>(null);
  const seq = useRef(0);
  const resolved = useRef<string | null | undefined>(undefined);
  const [blame, setBlame] = useState<FileBlame | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; hunk: BlameHunk } | null>(null);

  useEffect(() => {
    if (!path) return;
    if (resolved.current !== undefined && resolved.current === rev) return;
    const mine = ++seq.current;
    setBlame(null);
    setError(null);
    fileBlame(path, file, rev ?? undefined)
      .then((result) => {
        if (seq.current !== mine) return;
        resolved.current = result.rev;
        setBlame(result);
        if (result.rev && result.rev !== rev) onResolvedRev(result.rev);
      })
      .catch((e: { message?: string }) => {
        if (seq.current !== mine) return;
        resolved.current = undefined;
        setError(e.message ?? String(e));
      });
  }, [path, file, rev, onResolvedRev]);

  const language = useMemo(() => languageOf(file), [file]);
  const lineLanguages = useMemo(
    () => (blame ? embeddedLanguages(blame.lines, language) : null),
    [blame, language]
  );

  const hunkOfLine = useMemo(() => {
    const map: (BlameHunk | undefined)[] = [];
    if (!blame) return map;
    for (const hunk of blame.hunks) {
      for (let i = 0; i < hunk.lineCount; i++) map[hunk.startLine - 1 + i] = hunk;
    }
    return map;
  }, [blame]);

  const virtualizer = useVirtualizer({
    count: blame?.lines.length ?? 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 24,
  });

  if (error) {
    return (
      <div className="text-destructive flex-1 p-6 text-sm" data-blame-pane>
        {error}
      </div>
    );
  }

  if (!blame) {
    return (
      <div className="flex flex-1 items-center justify-center" data-blame-pane>
        <Loader2 className="text-muted-foreground size-5 animate-spin" />
      </div>
    );
  }

  return (
    <div
      ref={scrollRef}
      className="min-h-0 min-w-0 flex-1 overflow-auto font-mono text-xs"
      data-blame-pane
    >
      <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {virtualizer.getVirtualItems().map((item) => {
          const hunk = hunkOfLine[item.index];
          const first = hunk?.startLine === item.index + 1;
          const active = !!hunk && hovered === hunk.oid;
          return (
            <div
              key={item.index}
              data-blame-line={item.index + 1}
              className={cn(
                "absolute left-0 flex w-full items-stretch whitespace-pre",
                first && item.index > 0 && "border-border border-t",
                active && "bg-primary/5"
              )}
              style={{ top: item.start, height: ROW_HEIGHT }}
              onMouseEnter={() => setHovered(hunk?.oid ?? null)}
              onMouseLeave={() => setHovered(null)}
              onContextMenu={(e) => {
                if (!hunk) return;
                e.preventDefault();
                setMenu({ x: e.clientX, y: e.clientY, hunk });
              }}
            >
              <div className="border-border bg-card/60 flex w-72 shrink-0 items-center border-r px-2">
                {first && hunk && (
                  <button
                    type="button"
                    title={`${hunk.summary}\n${hunk.authorName} · ${formatDate(hunk.time)}`}
                    aria-label={
                      hunk.committed
                        ? t("gitRepo.inspector.blame.openCommitAria", { oid: hunk.shortOid })
                        : t("gitRepo.inspector.blame.notCommitted")
                    }
                    disabled={!hunk.committed}
                    onClick={() => onOpenCommit(hunk.oid)}
                    className="mr-2 flex min-w-0 flex-1 items-center gap-2 rounded-sm px-1 text-left disabled:cursor-default"
                  >
                    {hunk.committed ? (
                      <AuthorAvatar name={hunk.authorName} email={hunk.authorEmail} size={16} />
                    ) : (
                      <span className="bg-primary/30 size-4 shrink-0 rounded-full" />
                    )}
                    <span
                      className={cn(
                        "min-w-0 flex-1 truncate",
                        hunk.committed ? "text-foreground" : "text-primary"
                      )}
                    >
                      {hunk.authorName}
                    </span>
                    <span className="text-faint w-14 shrink-0 truncate">{timeAgo(hunk.time)}</span>
                    <span className="text-faint w-14 shrink-0 truncate">{hunk.shortOid}</span>
                  </button>
                )}
              </div>
              <span className="text-faint w-12 shrink-0 pr-2 text-right tabular-nums select-none">
                {item.index + 1}
              </span>
              <span
                className="min-w-0 flex-1 overflow-hidden pl-2"
                dangerouslySetInnerHTML={{
                  __html: highlightLine(
                    blame.lines[item.index],
                    lineLanguages?.[item.index] ?? language
                  ),
                }}
              />
            </div>
          );
        })}
      </div>
      {menu && (
        <DropdownMenu open onOpenChange={(o) => !o && setMenu(null)}>
          <DropdownMenuTrigger asChild>
            <span style={{ position: "fixed", left: menu.x, top: menu.y }} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="bottom">
            <DropdownMenuLabel className="max-w-64 truncate">{menu.hunk.summary}</DropdownMenuLabel>
            <DropdownMenuItem
              disabled={!menu.hunk.committed}
              onClick={() => onOpenCommit(menu.hunk.oid)}
            >
              <GitCommitHorizontal className="text-muted-foreground size-4" />
              {t("gitRepo.inspector.blame.openCommitAria", { oid: menu.hunk.shortOid })}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!menu.hunk.committed}
              onClick={() => onBlameAt(menu.hunk.oid)}
            >
              <UserRoundSearch className="text-muted-foreground size-4" />
              {t("gitRepo.inspector.blame.blameAt")}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!menu.hunk.committed}
              onClick={() => onBlameAt(`${menu.hunk.oid}^`)}
            >
              <UserRoundSearch className="text-muted-foreground size-4" />
              {t("gitRepo.inspector.blame.blameBefore")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={!menu.hunk.committed}
              onClick={() => {
                void navigator.clipboard.writeText(menu.hunk.oid);
                toast.success(t("gitRepo.inspector.blame.hashCopied"));
              }}
            >
              <Copy className="text-muted-foreground size-4" />
              {t("gitRepo.inspector.blame.copyHash")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
