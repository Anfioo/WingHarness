// Part of the one-mail module, adapted from OneMail
// (https://github.com/zhihui-hu/one-mail), AGPL-3.0-only.
// See `src-tauri/one-mail-core/UPSTREAM.md` for the porting record.

import { File, FileArchive, FileImage, FileText } from "lucide-react";
import type { AttachmentInfo } from "@/commands";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useAppTranslation } from "@/hooks/use-app-translation";

/**
 * The attachment metadata of one message: name, MIME type and size.
 *
 * This version stores metadata only — there is no download path — so a row is
 * a read-only summary and the tooltip says so.
 */

export interface MessageAttachmentsProps {
  attachments: AttachmentInfo[];
}

function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size < 0) return "—";
  if (size < 1024) return `${Math.round(size)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = size / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[unit]}`;
}

function AttachmentIcon({ mimeType }: { mimeType: string | null }) {
  const mime = (mimeType ?? "").toLowerCase();
  if (mime.startsWith("image/")) return <FileImage aria-hidden className="size-4 shrink-0" />;
  if (mime.startsWith("text/")) return <FileText aria-hidden className="size-4 shrink-0" />;
  if (mime.includes("zip") || mime.includes("compressed") || mime.includes("archive")) {
    return <FileArchive aria-hidden className="size-4 shrink-0" />;
  }
  return <File aria-hidden className="size-4 shrink-0" />;
}

export default function MessageAttachments({ attachments }: MessageAttachmentsProps) {
  const { t } = useAppTranslation();

  if (attachments.length === 0) return null;

  const hint = t("oneMail.thread.attachmentUnavailable");

  return (
    <TooltipProvider delayDuration={200}>
      <div className="space-y-1.5">
        <p className="text-muted-foreground text-xs font-medium">
          {t("oneMail.thread.attachments")}
        </p>
        <ul className="space-y-1">
          {attachments.map((attachment) => (
            <li key={attachment.attachmentId}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    tabIndex={0}
                    className="border-border bg-muted/40 flex max-w-md cursor-default items-center gap-2 rounded-md border px-2 py-1.5 text-xs"
                  >
                    <AttachmentIcon mimeType={attachment.mimeType} />
                    <span className="min-w-0 flex-1 truncate font-medium">
                      {attachment.filename}
                    </span>
                    {attachment.mimeType && (
                      <span className="text-muted-foreground hidden shrink-0 sm:inline">
                        {attachment.mimeType}
                      </span>
                    )}
                    <span className="text-muted-foreground shrink-0 tabular-nums">
                      {formatBytes(attachment.sizeBytes)}
                    </span>
                  </span>
                </TooltipTrigger>
                <TooltipContent side="bottom">{hint}</TooltipContent>
              </Tooltip>
            </li>
          ))}
        </ul>
      </div>
    </TooltipProvider>
  );
}
