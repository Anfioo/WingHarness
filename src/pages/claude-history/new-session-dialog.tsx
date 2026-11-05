/**
 * Names a copy before it is written.
 *
 * Both copy kinds land here: a clone of the whole session and a fork at one of
 * its messages. The name is the only thing the user chooses — the backend falls
 * back to "<source> (copy|branch)" when it is left empty, and never touches the
 * original.
 */

import { useState } from "react";
import { toast } from "sonner";
import { cloneClaudeSession, forkClaudeSession, type ClaudeNewSession } from "@/commands";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAppTranslation } from "@/hooks/use-app-translation";

/** What the user asked for, held until the copy is named and made. */
export interface CopyRequest {
  kind: "clone" | "fork";
  /** The message a fork leaves from. */
  forkUuid?: string;
  defaultTitle: string;
}

export function NewSessionDialog({
  request,
  project,
  sessionId,
  onClose,
  onCreated,
}: {
  request: CopyRequest;
  project: string;
  sessionId: string;
  onClose: () => void;
  onCreated: (session: ClaudeNewSession, title: string) => void;
}) {
  const { t } = useAppTranslation();
  const [title, setTitle] = useState(request.defaultTitle);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async () => {
    const label = title.trim() || request.defaultTitle;
    setBusy(true);
    setError("");
    try {
      const created =
        request.kind === "clone"
          ? await cloneClaudeSession(project, sessionId, label)
          : await forkClaudeSession(project, sessionId, request.forkUuid ?? "", label);
      toast.success(t("claudeHistory.copyDone"), {
        description: t("claudeHistory.copyDoneBody", { title: request.defaultTitle }),
      });
      onCreated(created, label);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {t(request.kind === "clone" ? "claudeHistory.clone" : "claudeHistory.fork")}
          </DialogTitle>
          <DialogDescription>
            {t(
              request.kind === "clone"
                ? "claudeHistory.cloneDescription"
                : "claudeHistory.forkDescription"
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2">
          <Label htmlFor="new-session-title">{t("claudeHistory.nameLabel")}</Label>
          <Input
            id="new-session-title"
            value={title}
            autoFocus
            disabled={busy}
            onChange={(event) => setTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void submit();
            }}
          />
          {error && <p className="text-destructive text-xs">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            {t("claudeHistory.cancel")}
          </Button>
          <Button onClick={() => void submit()} disabled={busy}>
            {t(request.kind === "clone" ? "claudeHistory.clone" : "claudeHistory.fork")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
