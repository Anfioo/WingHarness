import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

export interface CopyButtonProps {
  /** Text placed on the clipboard; the button is disabled when this is empty. */
  text: string;
  /** Accessible label and tooltip, e.g. "Copy body". */
  label: string;
  className?: string;
}

/**
 * A small ghost icon button that copies `text` to the clipboard, swapping its
 * icon for a check mark briefly on success. Copy failures surface as a toast
 * because the icon swap alone would hide them.
 */
export function CopyButton({ text, label, className }: CopyButtonProps): ReactNode {
  const { t } = useTranslation("translation", { keyPrefix: "apiClient.response" });
  const { t: tCommon } = useTranslation("translation", { keyPrefix: "apiClient.common" });
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    []
  );

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      toast.success(tCommon("actions.copied"));
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error(t("copy.failed"));
    }
  };

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      className={className ?? "text-muted-foreground"}
      disabled={text === ""}
      aria-label={label}
      title={label}
      onClick={() => void onCopy()}
    >
      {copied ? <Check /> : <Copy />}
    </Button>
  );
}

export default CopyButton;
