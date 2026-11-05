import { useEffect, useReducer } from "react";
import type { EditorView } from "@codemirror/view";
import { ChevronDown, Check, Heading } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Separator } from "@/components/ui/separator";
import { getActiveView } from "@/features/md-editor/editor/view-registry";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { cn } from "@/lib/utils";
import { pickActions, type MdAction } from "./actions";

const TEXT_ACTIONS = pickActions("bold", "italic", "strike", "inlineCode");
const HEADING_ACTIONS = pickActions("h1", "h2", "h3", "h4", "h5", "h6");
const PARAGRAPH_ACTION = pickActions("paragraph")[0];
const BLOCK_ACTIONS = pickActions("quote", "ul", "ol", "task", "codeBlock");
const RULE_ACTIONS = pickActions("table", "hr");
const INSERT_ACTIONS = pickActions("link", "image");
const MATH_ACTIONS = pickActions("inlineMath", "blockMath", "mermaid");

function actionTitle(action: MdAction): string {
  const label = action.label();
  return action.shortcut ? `${label} (${action.shortcut})` : label;
}

/** Runs an action on the view that is active now, then hands focus back to it. */
function runAction(action: MdAction): void {
  const view = getActiveView();
  if (!view || view.state.readOnly) return;
  action.run(view);
  // Menu items restore focus to their trigger when they close; the editor wins.
  window.setTimeout(() => getActiveView()?.focus(), 0);
}

function isActive(action: MdAction, view: EditorView | null): boolean {
  return view !== null && action.isActive?.(view) === true;
}

function ActionButton(props: { action: MdAction; view: EditorView | null; disabled: boolean }) {
  const { action, view, disabled } = props;
  const active = isActive(action, view);
  const Icon = action.icon;
  const label = action.label();

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      disabled={disabled}
      aria-label={label}
      aria-pressed={action.isActive ? active : undefined}
      title={actionTitle(action)}
      // Keep the editor selection while the button is pressed.
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => runAction(action)}
      className={cn(
        "text-muted-foreground hover:text-foreground size-7",
        active && "bg-accent text-foreground"
      )}
    >
      {Icon ? <Icon className="size-3.5" /> : <span className="text-xs">{label}</span>}
    </Button>
  );
}

function HeadingItem(props: { action: MdAction; view: EditorView | null }) {
  const { action, view } = props;
  const active = isActive(action, view);

  return (
    <DropdownMenuItem onSelect={() => runAction(action)}>
      <span className="flex size-3.5 items-center justify-center">
        {active && <Check className="size-3.5" />}
      </span>
      <span className="flex-1">{action.label()}</span>
      {action.shortcut && <DropdownMenuShortcut>{action.shortcut}</DropdownMenuShortcut>}
    </DropdownMenuItem>
  );
}

function HeadingMenu(props: { view: EditorView | null; disabled: boolean }) {
  const { t } = useAppTranslation();
  const { view, disabled } = props;
  const activeHeading = HEADING_ACTIONS.find((action) => isActive(action, view));
  const label = t("mdEditor.toolbar.heading");

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          disabled={disabled}
          aria-label={label}
          title={label}
          className={cn(
            "text-muted-foreground hover:text-foreground h-7 w-auto gap-1 px-1.5",
            activeHeading && "bg-accent text-foreground"
          )}
        >
          <Heading className="size-3.5" />
          <span className="text-xs">{activeHeading ? activeHeading.id.toUpperCase() : ""}</span>
          <ChevronDown className="size-3 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-44">
        <DropdownMenuLabel>{label}</DropdownMenuLabel>
        <HeadingItem action={PARAGRAPH_ACTION} view={view} />
        <DropdownMenuSeparator />
        {HEADING_ACTIONS.map((action) => (
          <HeadingItem key={action.id} action={action} view={view} />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The formatting toolbar. It renders for the page at all times and disables
 * itself while no editor view is registered; the active state is re-read on a
 * throttled `selectionchange`.
 */
export function Toolbar(): React.JSX.Element {
  const { t } = useAppTranslation();
  const [, refresh] = useReducer((count: number) => count + 1, 0);
  const view = getActiveView();
  // A read-only view still holds the document; the toolbar only writes to it.
  const editable = view !== null && !view.state.readOnly;

  useEffect(() => {
    let timer: number | null = null;
    const schedule = () => {
      if (timer !== null) return;
      timer = window.setTimeout(() => {
        timer = null;
        refresh();
      }, 200);
    };

    document.addEventListener("selectionchange", schedule);
    return () => {
      document.removeEventListener("selectionchange", schedule);
      if (timer !== null) window.clearTimeout(timer);
    };
  }, []);

  // A tab opening or closing swaps the view without moving the DOM selection;
  // watch for identity and read-only changes so the buttons follow.
  useEffect(() => {
    let current = getActiveView();
    let currentReadOnly = current?.state.readOnly ?? false;
    const timer = window.setInterval(() => {
      const next = getActiveView();
      const nextReadOnly = next?.state.readOnly ?? false;
      if (next === current && nextReadOnly === currentReadOnly) return;
      current = next;
      currentReadOnly = nextReadOnly;
      refresh();
    }, 300);
    return () => window.clearInterval(timer);
  }, []);

  const row = "flex shrink-0 items-center gap-0.5 overflow-x-auto whitespace-nowrap px-2 py-1";

  return (
    <div
      className="bg-background flex shrink-0 items-center border-b"
      role="toolbar"
      aria-label={t("mdEditor.title")}
    >
      <div className={row}>
        {TEXT_ACTIONS.map((action) => (
          <ActionButton key={action.id} action={action} view={view} disabled={!editable} />
        ))}
        <Separator orientation="vertical" className="mx-1 h-4" />
        <HeadingMenu view={view} disabled={!editable} />
        <Separator orientation="vertical" className="mx-1 h-4" />
        {BLOCK_ACTIONS.map((action) => (
          <ActionButton key={action.id} action={action} view={view} disabled={!editable} />
        ))}
        <Separator orientation="vertical" className="mx-1 h-4" />
        {RULE_ACTIONS.map((action) => (
          <ActionButton key={action.id} action={action} view={view} disabled={!editable} />
        ))}
        <Separator orientation="vertical" className="mx-1 h-4" />
        {INSERT_ACTIONS.map((action) => (
          <ActionButton key={action.id} action={action} view={view} disabled={!editable} />
        ))}
        <Separator orientation="vertical" className="mx-1 h-4" />
        {MATH_ACTIONS.map((action) => (
          <ActionButton key={action.id} action={action} view={view} disabled={!editable} />
        ))}
      </div>
    </div>
  );
}
