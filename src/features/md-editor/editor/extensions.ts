import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { bracketMatching, defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { search, searchKeymap } from "@codemirror/search";
import { EditorState, type Extension } from "@codemirror/state";
import {
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  type ViewUpdate,
} from "@codemirror/view";
import { MdFindPanel } from "./find-panel";
import { mdKeymap, type MdFileCommand } from "./keymap";
import { mdEditorTheme } from "./theme";

export type MdEditorExtensionOptions = {
  lineNumbers: boolean;
  lineWrap: boolean;
  tabSize: number;
  readOnly: boolean;
  onCommand: (command: MdFileCommand) => void;
  onUpdate: (update: ViewUpdate) => void;
};

/**
 * The editor's extension set. Autocompletion and linting are deliberately left
 * out: this is a Markdown source editor, not an IDE surface.
 */
export function buildExtensions(options: MdEditorExtensionOptions): Extension[] {
  return [
    markdown(),
    history(),
    EditorState.tabSize.of(options.tabSize),
    EditorState.readOnly.of(options.readOnly),
    EditorView.editable.of(!options.readOnly),
    keymap.of([
      ...mdKeymap(options.onCommand),
      ...defaultKeymap,
      ...historyKeymap,
      ...searchKeymap,
      indentWithTab,
    ]),
    search({ createPanel: (view) => new MdFindPanel(view) }),
    options.lineNumbers ? lineNumbers() : [],
    options.lineWrap ? EditorView.lineWrapping : [],
    highlightActiveLine(),
    highlightActiveLineGutter(),
    bracketMatching(),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    EditorView.updateListener.of(options.onUpdate),
    mdEditorTheme,
  ];
}
