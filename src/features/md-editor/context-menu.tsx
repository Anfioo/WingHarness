import { useRef, useState } from "react";
import type { EditorView } from "@codemirror/view";
import { redo, selectAll, undo } from "@codemirror/commands";
import { openSearchPanel } from "@codemirror/search";
import {
  ClipboardPaste,
  Copy,
  FileCode2,
  Image as ImageIcon,
  Printer,
  Redo2,
  Scissors,
  Search,
  TextSelect,
  Undo2,
} from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { getActiveView } from "@/features/md-editor/editor/view-registry";
import { useExportActions } from "@/features/md-editor/export/use-export-actions";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { pickActions, type MdAction } from "./toolbar/actions";

const TEXT_ACTIONS = pickActions("bold", "italic", "strike", "inlineCode");
const HEADING_ACTIONS = pickActions("h1", "h2", "h3", "h4", "h5", "h6");
const PARAGRAPH_ACTION = pickActions("paragraph")[0];
const LIST_ACTIONS = pickActions("ul", "ol", "task", "quote");
const INSERT_ACTIONS = pickActions("link", "image", "codeBlock", "table", "hr");

function runAction(action: MdAction): void {
  const view = getActiveView();
  if (!view) return;
  action.run(view);
  window.setTimeout(() => getActiveView()?.focus(), 0);
}

function actionItem(action: MdAction, disabled: boolean) {
  const Icon = action.icon;
  const label = action.label();

  return (
    <ContextMenuItem key={action.id} disabled={disabled} onSelect={() => runAction(action)}>
      {Icon ? <Icon className="size-4" /> : <span className="size-4" aria-hidden />}
      <span>{label}</span>
      {action.shortcut && <ContextMenuShortcut>{action.shortcut}</ContextMenuShortcut>}
    </ContextMenuItem>
  );
}

function execClipboard(command: "copy" | "cut"): void {
  try {
    document.execCommand(command);
  } catch (error) {
    console.warn("markdown editor: clipboard command failed", error);
  }
}

/**
 * The editor's right-click menu. Right-clicking outside the selection first
 * moves the caret to the pointer, so every item acts on what was clicked; a
 * read-only editor only keeps the non-mutating entries enabled.
 */
export function EditorContextMenu(props: { children: React.ReactNode }): React.JSX.Element {
  const { t } = useAppTranslation();
  const { canExport, runExport } = useExportActions();
  const [hasView, setHasView] = useState(false);
  const [readOnly, setReadOnly] = useState(true);
  const [hasSelection, setHasSelection] = useState(false);

  const handleContextMenu = (event: React.MouseEvent<HTMLSpanElement>) => {
    const view = getActiveView();
    if (!view) {
      setHasView(false);
      setReadOnly(true);
      setHasSelection(false);
      return;
    }

    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
    const insideSelection =
      pos !== null &&
      view.state.selection.ranges.some((range) => pos >= range.from && pos <= range.to);
    if (pos !== null && !insideSelection) {
      view.dispatch({ selection: { anchor: pos } });
    }
    view.focus();

    setHasView(true);
    setReadOnly(view.state.readOnly);
    setHasSelection(view.state.selection.ranges.some((range) => !range.empty));
  };

  const runCommand = (command: (view: EditorView) => boolean) => {
    const view = getActiveView();
    if (!view) return;
    command(view);
    view.focus();
  };

  const copy = () => {
    const view = getActiveView();
    if (!view) return;
    view.focus();
    execClipboard("copy");
  };

  const cut = () => {
    const view = getActiveView();
    if (!view) return;
    view.focus();
    execClipboard("cut");
  };

  const paste = () => {
    const view = getActiveView();
    if (!view) return;
    void navigator.clipboard
      .readText()
      .then((text) => {
        if (text) {
          view.dispatch({ ...view.state.replaceSelection(text), userEvent: "input.paste" });
        }
      })
      .catch((error: unknown) => {
        console.warn("markdown editor: failed to read the clipboard", error);
      })
      .finally(() => getActiveView()?.focus());
  };

  const find = () => {
    const view = getActiveView();
    if (view) openSearchPanel(view);
  };

  const canEdit = hasView && !readOnly;

  return (
    <ContextMenu>
      <ContextMenuTrigger className="contents" onContextMenu={handleContextMenu}>
        {props.children}
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-56">
        <ContextMenuItem disabled={!canEdit} onSelect={() => runCommand(undo)}>
          <Undo2 className="size-4" />
          <span>{t("mdEditor.context.undo")}</span>
          <ContextMenuShortcut>Ctrl+Z</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem disabled={!canEdit} onSelect={() => runCommand(redo)}>
          <Redo2 className="size-4" />
          <span>{t("mdEditor.context.redo")}</span>
          <ContextMenuShortcut>Ctrl+Y</ContextMenuShortcut>
        </ContextMenuItem>

        <ContextMenuSeparator />

        <ContextMenuItem disabled={!canEdit || !hasSelection} onSelect={cut}>
          <Scissors className="size-4" />
          <span>{t("mdEditor.context.cut")}</span>
          <ContextMenuShortcut>Ctrl+X</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem disabled={!hasSelection} onSelect={copy}>
          <Copy className="size-4" />
          <span>{t("mdEditor.context.copy")}</span>
          <ContextMenuShortcut>Ctrl+C</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem disabled={!canEdit} onSelect={paste}>
          <ClipboardPaste className="size-4" />
          <span>{t("mdEditor.context.paste")}</span>
          <ContextMenuShortcut>Ctrl+V</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem disabled={!hasView} onSelect={() => runCommand(selectAll)}>
          <TextSelect className="size-4" />
          <span>{t("mdEditor.context.selectAll")}</span>
          <ContextMenuShortcut>Ctrl+A</ContextMenuShortcut>
        </ContextMenuItem>

        <ContextMenuSeparator />

        <ContextMenuSub>
          <ContextMenuSubTrigger disabled={!canEdit}>
            {t("mdEditor.context.format")}
          </ContextMenuSubTrigger>
          <ContextMenuSubContent className="min-w-48">
            {TEXT_ACTIONS.map((action) => actionItem(action, !canEdit))}
          </ContextMenuSubContent>
        </ContextMenuSub>

        <ContextMenuSub>
          <ContextMenuSubTrigger disabled={!canEdit}>
            {t("mdEditor.toolbar.heading")}
          </ContextMenuSubTrigger>
          <ContextMenuSubContent className="min-w-48">
            {actionItem(PARAGRAPH_ACTION, !canEdit)}
            <ContextMenuSeparator />
            {HEADING_ACTIONS.map((action) => actionItem(action, !canEdit))}
          </ContextMenuSubContent>
        </ContextMenuSub>

        <ContextMenuSub>
          <ContextMenuSubTrigger disabled={!canEdit}>
            {t("mdEditor.context.list")}
          </ContextMenuSubTrigger>
          <ContextMenuSubContent className="min-w-48">
            {LIST_ACTIONS.map((action) => actionItem(action, !canEdit))}
          </ContextMenuSubContent>
        </ContextMenuSub>

        <ContextMenuSub>
          <ContextMenuSubTrigger disabled={!canEdit}>
            {t("mdEditor.context.insert")}
          </ContextMenuSubTrigger>
          <ContextMenuSubContent className="min-w-48">
            {INSERT_ACTIONS.map((action) => actionItem(action, !canEdit))}
          </ContextMenuSubContent>
        </ContextMenuSub>

        <ContextMenuSub>
          <ContextMenuSubTrigger disabled={!canExport}>
            {t("mdEditor.export.title")}
          </ContextMenuSubTrigger>
          <ContextMenuSubContent className="min-w-48">
            <ContextMenuItem disabled={!canExport} onSelect={() => runExport("html")}>
              <FileCode2 className="size-4" />
              <span>{t("mdEditor.export.html")}</span>
            </ContextMenuItem>
            <ContextMenuItem disabled={!canExport} onSelect={() => runExport("image")}>
              <ImageIcon className="size-4" />
              <span>{t("mdEditor.export.image")}</span>
            </ContextMenuItem>
            <ContextMenuItem disabled={!canExport} onSelect={() => runExport("pdf")}>
              <Printer className="size-4" />
              <span>{t("mdEditor.export.pdf")}</span>
            </ContextMenuItem>
          </ContextMenuSubContent>
        </ContextMenuSub>

        <ContextMenuSeparator />

        <ContextMenuItem disabled={!hasView} onSelect={find}>
          <Search className="size-4" />
          <span>{t("mdEditor.context.find")}</span>
          <ContextMenuShortcut>Ctrl+F</ContextMenuShortcut>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

async function writeClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch (error) {
    console.warn("markdown editor: failed to write the clipboard", error);
  }
}

/** The preview's right-click menu: clipboard only, nothing that edits the document. */
export function PreviewContextMenu(props: { children: React.ReactNode }): React.JSX.Element {
  const { t } = useAppTranslation();
  const { canExport, runExport } = useExportActions();
  const rootRef = useRef<HTMLElement | null>(null);
  const [hasSelection, setHasSelection] = useState(false);

  const handleContextMenu = (event: React.MouseEvent<HTMLSpanElement>) => {
    rootRef.current = event.currentTarget;
    const selection = window.getSelection();
    setHasSelection(
      Boolean(selection && !selection.isCollapsed && selection.toString().length > 0)
    );
  };

  const copy = () => {
    const text = window.getSelection()?.toString() ?? "";
    if (text) void writeClipboard(text);
  };

  const selectAll = () => {
    const root = rootRef.current;
    const selection = window.getSelection();
    if (!root || !selection) return;
    const range = document.createRange();
    range.selectNodeContents(root);
    selection.removeAllRanges();
    selection.addRange(range);
    setHasSelection(true);
  };

  const copyAsHtml = () => {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return;

    const range = selection.getRangeAt(0);
    const container = document.createElement("div");
    container.appendChild(range.cloneContents());
    const plain = selection.toString();

    void navigator.clipboard
      .write([
        new ClipboardItem({
          "text/html": new Blob([container.innerHTML], { type: "text/html" }),
          "text/plain": new Blob([plain], { type: "text/plain" }),
        }),
      ])
      .catch((error: unknown) => {
        console.warn("markdown editor: failed to copy as HTML", error);
      });
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger className="contents" onContextMenu={handleContextMenu}>
        {props.children}
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-44">
        <ContextMenuItem disabled={!hasSelection} onSelect={copy}>
          <Copy className="size-4" />
          <span>{t("mdEditor.context.copy")}</span>
        </ContextMenuItem>
        <ContextMenuItem onSelect={selectAll}>
          <TextSelect className="size-4" />
          <span>{t("mdEditor.context.selectAll")}</span>
        </ContextMenuItem>
        <ContextMenuItem disabled={!hasSelection} onSelect={copyAsHtml}>
          <FileCode2 className="size-4" />
          <span>{t("mdEditor.context.copyAsHtml")}</span>
        </ContextMenuItem>

        <ContextMenuSeparator />

        <ContextMenuSub>
          <ContextMenuSubTrigger disabled={!canExport}>
            {t("mdEditor.export.title")}
          </ContextMenuSubTrigger>
          <ContextMenuSubContent className="min-w-48">
            <ContextMenuItem disabled={!canExport} onSelect={() => runExport("html")}>
              <FileCode2 className="size-4" />
              <span>{t("mdEditor.export.html")}</span>
            </ContextMenuItem>
            <ContextMenuItem disabled={!canExport} onSelect={() => runExport("image")}>
              <ImageIcon className="size-4" />
              <span>{t("mdEditor.export.image")}</span>
            </ContextMenuItem>
            <ContextMenuItem disabled={!canExport} onSelect={() => runExport("pdf")}>
              <Printer className="size-4" />
              <span>{t("mdEditor.export.pdf")}</span>
            </ContextMenuItem>
          </ContextMenuSubContent>
        </ContextMenuSub>
      </ContextMenuContent>
    </ContextMenu>
  );
}
