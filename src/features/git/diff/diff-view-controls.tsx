import {
  Columns2,
  FileText,
  Files,
  Info,
  Rows3,
  SlidersHorizontal,
  Space,
  WholeWord,
  WrapText,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { useUi } from "@/features/git/ui-store";
import { Hint } from "./diff-ui";

function MenuNote({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-muted text-muted-foreground mx-1 mt-1 mb-0.5 flex items-start gap-2 rounded-md px-2 py-1.5 text-[11px] leading-snug">
      <Info className="text-faint mt-px size-3.5 shrink-0" />
      <span>{children}</span>
    </div>
  );
}

export function DiffLayoutToggle() {
  const { t } = useAppTranslation();
  const diffLayout = useUi((s) => s.diffLayout);
  const setDiffLayout = useUi((s) => s.setDiffLayout);
  const oneFileLabel = t("gitRepo.diff.controls.showOneFile");
  const allFilesLabel = t("gitRepo.diff.controls.showAllFiles");
  return (
    <div
      className="bg-muted/60 flex shrink-0 items-center rounded-md p-0.5"
      role="group"
      aria-label={t("gitRepo.diff.controls.layoutGroup")}
    >
      <Hint label={t("gitRepo.diff.controls.oneFileHint")}>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={oneFileLabel}
          aria-pressed={diffLayout === "file"}
          className={cn(
            "h-6 w-7",
            diffLayout === "file" && "bg-background text-foreground shadow-soft"
          )}
          onClick={() => setDiffLayout("file")}
        >
          <FileText className="size-3.5" />
        </Button>
      </Hint>
      <Hint label={t("gitRepo.diff.controls.allFilesHint")}>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={allFilesLabel}
          aria-pressed={diffLayout === "all"}
          className={cn(
            "h-6 w-7",
            diffLayout === "all" && "bg-background text-foreground shadow-soft"
          )}
          onClick={() => setDiffLayout("all")}
        >
          <Files className="size-3.5" />
        </Button>
      </Hint>
    </div>
  );
}

export function DiffViewControls({
  wrapDisabled = false,
  notes,
}: {
  wrapDisabled?: boolean;
  notes?: React.ReactNode;
}) {
  const { t } = useAppTranslation();
  const diffView = useUi((s) => s.diffView);
  const setDiffView = useUi((s) => s.setDiffView);
  const wordDiff = useUi((s) => s.wordDiff);
  const setWordDiff = useUi((s) => s.setWordDiff);
  const ignoreWhitespace = useUi((s) => s.ignoreWhitespace);
  const setIgnoreWhitespace = useUi((s) => s.setIgnoreWhitespace);
  const fullFileDiff = useUi((s) => s.fullFileDiff);
  const setFullFileDiff = useUi((s) => s.setFullFileDiff);
  const wrapLines = useUi((s) => s.wrapLines);
  const setWrapLines = useUi((s) => s.setWrapLines);
  const inlineLabel = t("gitRepo.diff.controls.inline");
  const splitLabel = t("gitRepo.diff.controls.split");
  const optionsLabel = t("gitRepo.diff.controls.viewOptions");
  return (
    <>
      <Hint label={inlineLabel}>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={inlineLabel}
          className={cn(diffView === "inline" && "bg-muted text-foreground")}
          onClick={() => setDiffView("inline")}
        >
          <Rows3 className="size-3.5" />
        </Button>
      </Hint>
      <Hint label={splitLabel}>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={splitLabel}
          className={cn(diffView === "split" && "bg-muted text-foreground")}
          onClick={() => setDiffView("split")}
        >
          <Columns2 className="size-3.5" />
        </Button>
      </Hint>
      <DropdownMenu>
        <Hint
          label={ignoreWhitespace ? t("gitRepo.diff.controls.ignoreWhitespaceNote") : optionsLabel}
        >
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={optionsLabel}
              className={cn(
                (wordDiff || wrapLines || fullFileDiff || ignoreWhitespace) && "text-primary"
              )}
            >
              <SlidersHorizontal className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
        </Hint>
        <DropdownMenuContent align="end" className="w-60">
          <DropdownMenuLabel>{optionsLabel}</DropdownMenuLabel>
          <DropdownMenuCheckboxItem
            checked={wordDiff}
            onCheckedChange={(v) => setWordDiff(v === true)}
          >
            <WholeWord className="text-muted-foreground size-4" />
            {t("gitRepo.diff.controls.wordDiff")}
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem
            checked={ignoreWhitespace}
            onCheckedChange={(v) => setIgnoreWhitespace(v === true)}
          >
            <Space className="text-muted-foreground size-4" />
            {t("gitRepo.diff.controls.ignoreWhitespace")}
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem
            checked={wrapLines}
            disabled={wrapDisabled}
            onCheckedChange={(v) => setWrapLines(v === true)}
          >
            <WrapText className="text-muted-foreground size-4" />
            {t("gitRepo.diff.controls.wrapLongLines")}
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem
            checked={fullFileDiff}
            onCheckedChange={(v) => setFullFileDiff(v === true)}
          >
            <FileText className="text-muted-foreground size-4" />
            {t("gitRepo.diff.controls.showWholeFile")}
          </DropdownMenuCheckboxItem>
          {notes}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}

export { MenuNote };
