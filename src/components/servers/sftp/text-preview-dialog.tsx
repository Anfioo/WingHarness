// Read-only text preview for remote files up to the engine's 2 MB limit.

import { Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { basename } from "./paths";

export type TextPreviewDialogProps = {
  open: boolean;
  path: string;
  content: string | null;
  loading: boolean;
  error: string | null;
  onOpenChange: (open: boolean) => void;
};

export function TextPreviewDialog({
  open,
  path,
  content,
  loading,
  error,
  onOpenChange,
}: TextPreviewDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="truncate font-mono text-sm">{basename(path)}</DialogTitle>
          <DialogDescription className="truncate font-mono text-xs">{path}</DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="text-muted-foreground flex h-40 items-center justify-center">
            <Loader2 className="size-5 animate-spin" />
          </div>
        ) : error ? (
          <p className="border-destructive/30 bg-destructive/5 text-destructive rounded-md border px-2.5 py-2 text-xs break-words">
            {error}
          </p>
        ) : (
          <pre className="bg-muted/40 border-border max-h-[60vh] overflow-auto rounded-md border p-3 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap">
            {content ?? ""}
          </pre>
        )}
      </DialogContent>
    </Dialog>
  );
}
