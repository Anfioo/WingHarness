import { EditorState, StateEffect, type Extension } from "@codemirror/state";
import { EditorView, type ViewUpdate } from "@codemirror/view";
import { useEffect, useRef } from "react";
import { buildExtensions } from "./extensions";
import type { MdFileCommand } from "./keymap";
import { getActiveView, setActiveView } from "./view-registry";

/** 1-based caret position, matching the store's `MdCursor`. */
export type MdEditorCursor = { line: number; column: number };

export interface CmHostProps {
  /** Tab id: changing it swaps the document without rebuilding the view. */
  docKey: string;
  doc: string;
  readOnly?: boolean;
  onChange(value: string): void;
  onCursor(pos: MdEditorCursor): void;
  onScroll(top: number): void;
  /**
   * F1 wiring on top of the frozen props: the behaviour settings and the file
   * commands the keymap reports. Both are optional so the component still
   * works with the plain five-prop contract.
   */
  behavior?: { lineNumbers: boolean; lineWrap: boolean; tabSize: number };
  onCommand?(command: MdFileCommand): void;
}

type LiveCallbacks = {
  onChange(value: string): void;
  onCursor(pos: MdEditorCursor): void;
  onScroll(top: number): void;
  onCommand?(command: MdFileCommand): void;
};

type Throttled<Args extends unknown[]> = {
  call(...args: Args): void;
  cancel(): void;
};

type Throttles = {
  reportCursor: Throttled<[EditorState]>;
  reportScroll: Throttled<[number]>;
};

/** Leading-edge with a trailing flush, so the last event is never lost. */
function createThrottle<Args extends unknown[]>(
  wait: number,
  run: (...args: Args) => void
): Throttled<Args> {
  let last = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: Args | null = null;

  const flush = () => {
    if (pending === null) return;
    const args = pending;
    pending = null;
    last = Date.now();
    run(...args);
  };

  return {
    call(...args: Args) {
      pending = args;
      const remaining = wait - (Date.now() - last);
      if (remaining <= 0) {
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
        flush();
      } else if (timer === null) {
        timer = setTimeout(() => {
          timer = null;
          flush();
        }, remaining);
      }
    },
    cancel() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      pending = null;
    },
  };
}

/**
 * Builds the extension set for one view. Called from effects only, so the
 * callbacks it closes over read the live refs when an update actually happens.
 */
function createExtensions(params: {
  behavior: CmHostProps["behavior"];
  readOnly: boolean;
  getLive: () => LiveCallbacks;
  getThrottles: () => Throttles | null;
}): Extension[] {
  const { behavior, readOnly, getLive, getThrottles } = params;

  return buildExtensions({
    lineNumbers: behavior?.lineNumbers ?? true,
    lineWrap: behavior?.lineWrap ?? true,
    tabSize: behavior?.tabSize ?? 2,
    readOnly,
    onCommand: (command: MdFileCommand) => getLive().onCommand?.(command),
    onUpdate: (update: ViewUpdate) => {
      const live = getLive();
      if (update.docChanged) live.onChange(update.state.doc.toString());
      if (update.selectionSet || update.docChanged) {
        getThrottles()?.reportCursor.call(update.state);
      }
    },
  });
}

/**
 * Owns one CodeMirror view for the whole page. Switching tabs calls
 * `view.setState()` rather than destroying the view, so the DOM, scroll
 * container and focus survive.
 */
export function CmHost(props: CmHostProps): React.JSX.Element {
  const { docKey, doc, readOnly = false, behavior } = props;

  const parentRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const activeKeyRef = useRef<string | null>(null);
  const extensionsRef = useRef<Extension[]>([]);
  const throttlesRef = useRef<Throttles | null>(null);
  const reconfigureOnceRef = useRef(false);

  // The latest render's values, read by the long-lived listeners instead of
  // being baked into handlers, which would rebuild them on every render.
  const live = useRef<LiveCallbacks>({
    onChange: props.onChange,
    onCursor: props.onCursor,
    onScroll: props.onScroll,
    onCommand: props.onCommand,
  });
  const docRef = useRef(doc);
  const docKeyRef = useRef(docKey);
  const behaviorRef = useRef(behavior);
  const readOnlyRef = useRef(readOnly);

  useEffect(() => {
    live.current = {
      onChange: props.onChange,
      onCursor: props.onCursor,
      onScroll: props.onScroll,
      onCommand: props.onCommand,
    };
    docRef.current = doc;
    docKeyRef.current = docKey;
    behaviorRef.current = behavior;
    readOnlyRef.current = readOnly;
  });

  const buildCurrent = (): Extension[] =>
    createExtensions({
      behavior: behaviorRef.current,
      readOnly: readOnlyRef.current,
      getLive: () => live.current,
      getThrottles: () => throttlesRef.current,
    });

  useEffect(() => {
    const parent = parentRef.current;
    if (!parent) return;

    const reportCursor = createThrottle<[EditorState]>(200, (state) => {
      const head = state.selection.main.head;
      const line = state.doc.lineAt(head);
      live.current.onCursor({ line: line.number, column: head - line.from + 1 });
    });
    const reportScroll = createThrottle<[number]>(100, (top) => {
      live.current.onScroll(top);
    });
    throttlesRef.current = { reportCursor, reportScroll };

    const extensions = buildCurrent();
    extensionsRef.current = extensions;

    const view = new EditorView({
      state: EditorState.create({ doc: docRef.current, extensions }),
      parent,
    });
    viewRef.current = view;
    activeKeyRef.current = docKeyRef.current;
    setActiveView(view);

    const handleFocus = () => setActiveView(view);
    const handleScroll = () => reportScroll.call(view.scrollDOM.scrollTop);
    view.contentDOM.addEventListener("focus", handleFocus);
    view.scrollDOM.addEventListener("scroll", handleScroll, { passive: true });

    return () => {
      view.contentDOM.removeEventListener("focus", handleFocus);
      view.scrollDOM.removeEventListener("scroll", handleScroll);
      reportCursor.cancel();
      reportScroll.cancel();
      throttlesRef.current = null;
      if (getActiveView() === view) setActiveView(null);
      view.destroy();
      viewRef.current = null;
    };
    // The view is created once; everything else is applied by the effects below.
  }, []);

  // A different tab replaces the state; the view itself stays.
  useEffect(() => {
    const view = viewRef.current;
    if (!view || activeKeyRef.current === docKey) return;
    activeKeyRef.current = docKey;
    view.setState(EditorState.create({ doc, extensions: extensionsRef.current }));
  }, [docKey, doc]);

  // Changing a behaviour or read-only setting reconfigures the existing state.
  useEffect(() => {
    if (!reconfigureOnceRef.current) {
      reconfigureOnceRef.current = true;
      return;
    }
    const view = viewRef.current;
    if (!view) return;
    const extensions = buildCurrent();
    extensionsRef.current = extensions;
    view.dispatch({ effects: StateEffect.reconfigure.of(extensions) });
  }, [behavior?.lineNumbers, behavior?.lineWrap, behavior?.tabSize, readOnly]);

  // The document can also change from outside the editor; apply it only when
  // it really differs.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === doc) return;
    view.dispatch({ changes: { from: 0, to: current.length, insert: doc } });
  }, [doc]);

  return <div ref={parentRef} className="h-full min-h-0 overflow-hidden" />;
}
