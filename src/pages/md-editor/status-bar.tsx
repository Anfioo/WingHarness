import { useAppTranslation } from "@/hooks/use-app-translation";
import type { MdTabState } from "./types";

function isCjkOrKana(code: number): boolean {
  return (
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0x3040 && code <= 0x30ff) ||
    (code >= 0xac00 && code <= 0xd7af)
  );
}

/** Counts CJK characters individually and everything else as space-separated words. */
export function countWords(text: string): number {
  let cjk = 0;
  let latin = 0;
  let inLatin = false;

  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (isCjkOrKana(code)) {
      cjk += 1;
      inLatin = false;
    } else if (/\s/.test(char)) {
      inLatin = false;
    } else if (!inLatin) {
      latin += 1;
      inLatin = true;
    }
  }

  return cjk + latin;
}

export interface StatusBarProps {
  tab: MdTabState | null;
  saving: boolean;
}

/** The bottom strip: caret, word count and the document's storage facts. */
export function StatusBar({ tab, saving }: StatusBarProps) {
  const { t } = useAppTranslation();

  if (!tab) {
    return <div className="h-7 shrink-0 border-t" />;
  }

  const dirty = tab.content !== tab.savedContent;
  const saveState = saving
    ? t("mdEditor.status.saving")
    : dirty
      ? t("mdEditor.status.unsaved")
      : t("mdEditor.status.saved");

  return (
    <div className="text-muted-foreground flex h-7 shrink-0 items-center gap-3 border-t px-3 text-xs whitespace-nowrap">
      <span>{t("mdEditor.status.line", { line: tab.cursor.line })}</span>
      <span>{t("mdEditor.status.column", { column: tab.cursor.column })}</span>
      <span className="bg-border h-3 w-px" />
      <span>{t("mdEditor.status.words", { count: countWords(tab.content) })}</span>
      <span className="bg-border h-3 w-px" />
      <span>{tab.encoding === "utf-8" ? "UTF-8" : "GB18030"}</span>
      <span>{tab.eol === "\n" ? "LF" : "CRLF"}</span>
      <span className="ml-auto">{saveState}</span>
    </div>
  );
}
