import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { KeyboardEvent } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { EditorState, Text } from "@codemirror/state";
import type { EditorView, Panel, ViewUpdate } from "@codemirror/view";
import {
  SearchQuery,
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  replaceAll,
  replaceNext,
  setSearchQuery,
} from "@codemirror/search";
import { CaseSensitive, ChevronDown, ChevronUp, Regex, Search, WholeWord, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/** Past this many hits the count stops being useful and the scan stops being cheap. */
const MATCH_LIMIT = 2000;

type Match = { from: number; to: number };

type QueryPatch = {
  search?: string;
  replace?: string;
  caseSensitive?: boolean;
  regexp?: boolean;
  wholeWord?: boolean;
};

type FindSnapshot = {
  search: string;
  replace: string;
  caseSensitive: boolean;
  regexp: boolean;
  wholeWord: boolean;
  readOnly: boolean;
  /** True when the pattern is a regular expression that does not compile. */
  invalid: boolean;
  matches: readonly Match[];
  truncated: boolean;
  /** Index into `matches` of the selection, or -1 when the selection is not a hit. */
  current: number;
};

function collectMatches(
  state: EditorState,
  query: SearchQuery
): { matches: Match[]; truncated: boolean } {
  if (!query.valid) return { matches: [], truncated: false };

  const matches: Match[] = [];
  const cursor = query.getCursor(state);
  while (true) {
    const next = cursor.next();
    if (next.done) break;
    if (matches.length >= MATCH_LIMIT) return { matches, truncated: true };
    matches.push({ from: next.value.from, to: next.value.to });
  }
  return { matches, truncated: false };
}

function commit(view: EditorView, patch: QueryPatch): void {
  const current = getSearchQuery(view.state);
  const next = new SearchQuery({
    search: patch.search ?? current.search,
    caseSensitive: patch.caseSensitive ?? current.caseSensitive,
    regexp: patch.regexp ?? current.regexp,
    wholeWord: patch.wholeWord ?? current.wholeWord,
    replace: patch.replace ?? current.replace,
    literal: current.literal,
  });
  if (!next.eq(current)) view.dispatch({ effects: setSearchQuery.of(next) });
}

/**
 * The find panel that replaces CodeMirror's built-in one: the same search
 * engine and match highlighting, drawn with the app's inputs and buttons.
 * It is a React root mounted inside the panel element CodeMirror owns, so the
 * view can open and close it exactly like the stock panel.
 */
export class MdFindPanel implements Panel {
  readonly dom: HTMLElement;
  /** CodeMirror reads this to place the panel above the document. */
  readonly top = true;

  private readonly root: Root;
  private readonly listeners = new Set<() => void>();
  private snapshot: FindSnapshot;

  // The match list depends on the document and the query only, so it is kept
  // across selection changes; recomputing it on every keystroke of the query
  // would scan the whole document twice.
  private cachedDoc: Text | null = null;
  private cachedQuery: SearchQuery | null = null;
  private cachedMatches: Match[] = [];
  private cachedTruncated = false;

  constructor(readonly view: EditorView) {
    this.dom = document.createElement("div");
    this.snapshot = this.read(view);
    this.root = createRoot(this.dom);
    this.root.render(<FindBar panel={this} />);
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): FindSnapshot => this.snapshot;

  update(update: ViewUpdate): void {
    this.snapshot = this.read(update.view);
    for (const listener of this.listeners) listener();
  }

  mount(): void {
    // The React tree renders on a microtask; wait a frame so the field exists.
    requestAnimationFrame(() => {
      const input = this.dom.querySelector<HTMLInputElement>("[main-field]");
      input?.focus();
      input?.select();
    });
  }

  destroy(): void {
    this.listeners.clear();
    this.root.unmount();
  }

  private read(view: EditorView): FindSnapshot {
    const state = view.state;
    const query = getSearchQuery(state);

    const queryChanged =
      !this.cachedQuery || this.cachedDoc !== state.doc || !query.eq(this.cachedQuery);
    if (queryChanged) {
      const { matches, truncated } = collectMatches(state, query);
      this.cachedQuery = query;
      this.cachedDoc = state.doc;
      this.cachedMatches = matches;
      this.cachedTruncated = truncated;
    }

    const { from, to } = state.selection.main;
    return {
      search: query.search,
      replace: query.replace,
      caseSensitive: query.caseSensitive,
      regexp: query.regexp,
      wholeWord: query.wholeWord,
      readOnly: state.readOnly,
      invalid: query.search !== "" && !query.valid,
      matches: this.cachedMatches,
      truncated: this.cachedTruncated,
      current: this.cachedMatches.findIndex((match) => match.from === from && match.to === to),
    };
  }
}

function FindBar({ panel }: { panel: MdFindPanel }): React.JSX.Element {
  const { t } = useTranslation();
  const snapshot = useSyncExternalStore(panel.subscribe, panel.getSnapshot, panel.getSnapshot);
  const view = panel.view;

  // Local copies so typing is not routed through the editor state; the effect
  // takes over again when CodeMirror seeds the query (e.g. from a selection).
  const [search, setSearch] = useState(snapshot.search);
  const [replace, setReplace] = useState(snapshot.replace);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setSearch(snapshot.search);
  }, [snapshot.search]);

  useEffect(() => {
    setReplace(snapshot.replace);
  }, [snapshot.replace]);

  const changeSearch = (value: string) => {
    setSearch(value);
    commit(view, { search: value });
  };

  const changeReplace = (value: string) => {
    setReplace(value);
    commit(view, { replace: value });
  };

  const toggle = (field: "caseSensitive" | "regexp" | "wholeWord") => {
    commit(view, { [field]: !snapshot[field] });
    searchRef.current?.focus();
  };

  const goNext = () => {
    findNext(view);
    searchRef.current?.focus();
  };

  const goPrevious = () => {
    findPrevious(view);
    searchRef.current?.focus();
  };

  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      if (event.shiftKey) findPrevious(view);
      else findNext(view);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeSearchPanel(view);
    }
  };

  const onReplaceKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      replaceNext(view);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeSearchPanel(view);
    }
  };

  const total = snapshot.matches.length;
  const totalLabel = snapshot.truncated ? `${total}+` : String(total);
  const countLabel = (() => {
    if (search === "") return "";
    if (snapshot.invalid) return t("mdEditor.find.invalid");
    if (total === 0) return t("mdEditor.find.noResults");
    if (snapshot.current >= 0) return `${snapshot.current + 1} / ${totalLabel}`;
    return totalLabel;
  })();

  const canNavigate = total > 0;
  const canReplace = canNavigate && search !== "" && !snapshot.invalid;

  return (
    <div className="bg-popover text-popover-foreground flex flex-col gap-1 px-2 py-1.5 font-sans">
      <div className="flex items-center gap-1">
        <div className="relative min-w-0 flex-1">
          <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2" />
          <Input
            ref={searchRef}
            {...{ "main-field": "true" }}
            value={search}
            onChange={(event) => changeSearch(event.target.value)}
            onKeyDown={onSearchKeyDown}
            placeholder={t("mdEditor.find.placeholder")}
            aria-label={t("mdEditor.find.placeholder")}
            autoComplete="off"
            spellCheck={false}
            className="h-7 pr-2 pl-7 text-xs"
          />
        </div>

        <span
          aria-live="polite"
          className="text-muted-foreground w-20 shrink-0 truncate text-right text-[11px] tabular-nums"
        >
          {countLabel}
        </span>

        <FindToggle
          active={snapshot.caseSensitive}
          label={t("mdEditor.find.caseSensitive")}
          onClick={() => toggle("caseSensitive")}
        >
          <CaseSensitive className="size-3.5" />
        </FindToggle>
        <FindToggle
          active={snapshot.wholeWord}
          label={t("mdEditor.find.wholeWord")}
          onClick={() => toggle("wholeWord")}
        >
          <WholeWord className="size-3.5" />
        </FindToggle>
        <FindToggle
          active={snapshot.regexp}
          label={t("mdEditor.find.regexp")}
          onClick={() => toggle("regexp")}
        >
          <Regex className="size-3.5" />
        </FindToggle>

        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={t("mdEditor.find.previous")}
          title={t("mdEditor.find.previous")}
          className="size-6"
          disabled={!canNavigate}
          onClick={goPrevious}
        >
          <ChevronUp className="size-3.5" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={t("mdEditor.find.next")}
          title={t("mdEditor.find.next")}
          className="size-6"
          disabled={!canNavigate}
          onClick={goNext}
        >
          <ChevronDown className="size-3.5" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={t("mdEditor.find.close")}
          title={t("mdEditor.find.close")}
          className="size-6"
          onClick={() => closeSearchPanel(view)}
        >
          <X className="size-3.5" />
        </Button>
      </div>

      {!snapshot.readOnly && (
        <div className="flex items-center gap-1">
          <Input
            value={replace}
            onChange={(event) => changeReplace(event.target.value)}
            onKeyDown={onReplaceKeyDown}
            placeholder={t("mdEditor.find.replacePlaceholder")}
            aria-label={t("mdEditor.find.replacePlaceholder")}
            autoComplete="off"
            spellCheck={false}
            className="h-7 min-w-0 flex-1 text-xs"
          />
          <Button
            type="button"
            variant="outline"
            size="xs"
            disabled={!canReplace}
            onClick={() => replaceNext(view)}
          >
            {t("mdEditor.find.replace")}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="xs"
            disabled={!canReplace}
            onClick={() => replaceAll(view)}
          >
            {t("mdEditor.find.replaceAll")}
          </Button>
        </div>
      )}
    </div>
  );
}

function FindToggle(props: {
  active: boolean;
  label: string;
  onClick(): void;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      aria-label={props.label}
      aria-pressed={props.active}
      title={props.label}
      className={cn("size-6", props.active && "bg-accent text-accent-foreground")}
      onClick={props.onClick}
    >
      {props.children}
    </Button>
  );
}
