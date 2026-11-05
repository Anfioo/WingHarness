// The toolbar's "Export" dropdown: HTML, long image and PDF.

import { ChevronDown, Download, FileCode2, Image as ImageIcon, Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { useExportActions } from "./use-export-actions";

export function ExportMenu(): React.JSX.Element {
  const { t } = useAppTranslation();
  const { busy, canExport, runExport } = useExportActions();
  const disabled = !canExport || busy;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled}
          className="text-muted-foreground hover:text-foreground h-7 gap-1 px-2"
        >
          <Download className="size-3.5" />
          <span className="text-xs">{t("mdEditor.export.title")}</span>
          <ChevronDown className="size-3 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        <DropdownMenuItem onSelect={() => runExport("html")}>
          <FileCode2 className="size-4" />
          <span>{t("mdEditor.export.html")}</span>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => runExport("image")}>
          <ImageIcon className="size-4" />
          <span>{t("mdEditor.export.image")}</span>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => runExport("pdf")}>
          <Printer className="size-4" />
          <span>{t("mdEditor.export.pdf")}</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
