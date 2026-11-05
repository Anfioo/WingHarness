// Breadcrumb plus an editable absolute path, shared by both panes.

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronRight, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { pathSegments } from "./paths";
import type { Side } from "./types";

export type PathBarProps = {
  side: Side;
  path: string;
  onNavigate: (path: string) => void;
};

export function PathBar({ side, path, onNavigate }: PathBarProps) {
  const { t } = useAppTranslation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(path);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!editing) setDraft(path);
  }, [path, editing]);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const segments = useMemo(() => pathSegments(side, path), [side, path]);

  const commit = () => {
    const target = draft.trim();
    setEditing(false);
    if (target) onNavigate(target);
  };

  if (editing) {
    return (
      <div className="flex min-w-0 flex-1 items-center gap-1">
        <Input
          ref={inputRef}
          value={draft}
          spellCheck={false}
          className="h-7 min-w-0 flex-1 font-mono text-xs"
          aria-label={t("servers.sftp.editPath", { defaultValue: "Edit path" })}
          placeholder={t("servers.sftp.pathPlaceholder", {
            defaultValue: "Enter an absolute path and press Enter",
          })}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commit();
            } else if (event.key === "Escape") {
              event.preventDefault();
              setEditing(false);
            }
          }}
        />
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          title={t("servers.sftp.go", { defaultValue: "Go" })}
          aria-label={t("servers.sftp.go", { defaultValue: "Go" })}
          onClick={commit}
        >
          <Check />
        </Button>
      </div>
    );
  }

  return (
    <div className="border-border bg-muted/30 flex min-w-0 flex-1 items-center gap-1 rounded-md border px-1.5 py-0.5">
      <div className="flex min-w-0 flex-1 items-center overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {segments.map((segment, index) => (
          <Fragment key={segment.path}>
            {index > 0 && <ChevronRight className="text-muted-foreground size-3 shrink-0" />}
            <button
              type="button"
              className="text-muted-foreground hover:bg-accent hover:text-foreground shrink-0 rounded px-1 py-0.5 font-mono text-xs"
              title={segment.path}
              onClick={() => onNavigate(segment.path)}
            >
              {segment.label}
            </button>
          </Fragment>
        ))}
      </div>
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        className="shrink-0"
        title={t("servers.sftp.editPath", { defaultValue: "Edit path" })}
        aria-label={t("servers.sftp.editPath", { defaultValue: "Edit path" })}
        onClick={() => setEditing(true)}
      >
        <Pencil />
      </Button>
    </div>
  );
}
