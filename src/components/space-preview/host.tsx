import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { listen } from "@tauri-apps/api/event";
import { ArrowLeft, ExternalLink, Pencil, RotateCw, Save, X } from "lucide-react";
import { toast } from "sonner";
import {
  getPreviewPreferences,
  inspectFile,
  openPreview,
  savePreviewPreferences,
  writeText,
  type PreviewPreferences,
  type TextEncoding,
} from "@/commands";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { languageOf } from "@/lib/git-core/highlight";
import { cn } from "@/lib/utils";
import { CodeEditor } from "@/components/code-editor";
import type { PreviewFile } from "@/lib/space-preview/bridge";
import { readFullBytes } from "@/lib/space-preview/bridge";
import { decodeText, formatSize } from "@/lib/space-preview/engine/files";
import { detectKind } from "@/lib/space-preview/registry";
import { errorText, previewErrorCodeKey } from "./viewers/errors";
import Preview from "./viewers/Preview";
import { PreviewLoadingIndicator, PreviewLoadingProvider } from "./viewers/PreviewLoading";
import { PreviewMenuTarget } from "./viewers/PreviewToolbar";
import { TextAppearanceProvider } from "./viewers/TextAppearance";
import { ViewerPreferencesProvider } from "./viewers/preferences";
import FileIcon from "./viewers/FileIcon";
import "./space-preview.css";

export interface PreviewTarget {
  path: string;
  name: string;
  size?: number;
  etag?: string;
}

export interface PreviewHostProps {
  mode: "embedded" | "window";
  target: PreviewTarget | null;
  /** Open in the text view, as Shift+Space asks for. */
  text?: boolean;
  /** The hand-off held only folders, so the empty state says why nothing opened. */
  folderOnly?: boolean;
  /**
   * Whether unsaved edits would be lost if the target changed. The host cannot
   * veto a prop change, so the caller asks before switching; the preview window
   * also uses it to confirm before hiding.
   */
  onDirtyChange?: (dirty: boolean) => void;
  onClose?: () => void;
  onEdited?: (next: PreviewTarget) => void;
  className?: string;
}

const EDITABLE = ["text", "markdown", "csv", "asciidoc"];
const READABLE = [
  "text",
  "markdown",
  "csv",
  "asciidoc",
  "docx",
  "odt",
  "rtf",
  "fb2",
  "notebook",
  "legacy-doc",
];

const DEFAULT_PREFERENCES: PreviewPreferences = {
  version: 1,
  spaceEnabled: true,
  readingWidth: 900,
  fontSize: 15,
  defaultEncoding: "auto",
};

const ENCODINGS: { value: TextEncoding; key: string; fallback: string }[] = [
  { value: "auto", key: "spacePreview.encoding.auto", fallback: "Detect automatically" },
  { value: "utf-8", key: "spacePreview.encoding.utf8", fallback: "UTF-8" },
  { value: "utf-16le", key: "spacePreview.encoding.utf16le", fallback: "UTF-16 LE" },
  { value: "utf-16be", key: "spacePreview.encoding.utf16be", fallback: "UTF-16 BE" },
  { value: "gb18030", key: "spacePreview.encoding.gb18030", fallback: "GB18030" },
  { value: "big5", key: "spacePreview.encoding.big5", fallback: "Big5" },
  { value: "windows-1252", key: "spacePreview.encoding.windows1252", fallback: "Windows-1252" },
  { value: "shift_jis", key: "spacePreview.encoding.shiftJis", fallback: "Shift-JIS" },
];

// `decodeText` reports what "auto" settled on; writing back reuses it so a
// guessed GB18030 or UTF-16 file keeps its encoding instead of becoming UTF-8.
function detectedEncoding(label: string): TextEncoding {
  if (label.startsWith("UTF-16 LE")) return "utf-16le";
  if (label.startsWith("UTF-16 BE")) return "utf-16be";
  if (label.startsWith("GB18030")) return "gb18030";
  return "utf-8";
}

export function PreviewHost({
  mode,
  target,
  text: textMode = false,
  folderOnly = false,
  onDirtyChange,
  onClose,
  onEdited,
  className,
}: PreviewHostProps): ReactElement {
  const { t } = useAppTranslation();
  // The backend rejects with a stable code and an English message; the code is
  // what the UI translates, the message only covers a code it does not know.
  const describe = useCallback(
    (reason: unknown) => {
      const key = previewErrorCodeKey(reason);
      return key ? t(key, { defaultValue: errorText(reason) }) : errorText(reason);
    },
    [t]
  );
  const [preferences, setPreferences] = useState<PreviewPreferences>(DEFAULT_PREFERENCES);
  const [file, setFile] = useState<PreviewFile | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [reload, setReload] = useState(0);
  const [stack, setStack] = useState<PreviewFile[]>([]);
  const [menuTarget, setMenuTarget] = useState<HTMLDivElement | null>(null);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const [original, setOriginal] = useState("");
  const [saving, setSaving] = useState(false);
  const [encoding, setEncoding] = useState<TextEncoding>("utf-8");
  const [detected, setDetected] = useState<TextEncoding>("utf-8");
  const [etag, setEtag] = useState<string | undefined>(target?.etag);
  const lastSaved = useRef<PreviewPreferences | null>(null);
  const sourceBytes = useRef<Uint8Array | null>(null);
  const reading = useRef<AbortController | null>(null);
  const targetPath = target?.path ?? null;
  // Read by the path-keyed reset below without making the target object a
  // dependency; callers often pass an inline literal.
  const latestTarget = useRef(target);

  useEffect(() => {
    latestTarget.current = target;
  });

  useEffect(() => {
    let active = true;
    void getPreviewPreferences()
      .then((value) => {
        // A broadcast that beat this read is newer; keep it.
        if (!active || lastSaved.current) return;
        lastSaved.current = value;
        setPreferences(value);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  // The settings window and the tray write the same file. Follow their changes
  // without echoing them back through the save below.
  useEffect(() => {
    let stop: (() => void) | undefined;
    let active = true;
    void listen<PreviewPreferences>("sp:preferences-changed", (event) => {
      lastSaved.current = event.payload;
      setPreferences(event.payload);
    }).then((unlisten) => {
      if (active) stop = unlisten;
      else unlisten();
    });
    return () => {
      active = false;
      stop?.();
    };
  }, []);

  useEffect(() => {
    if (!lastSaved.current || lastSaved.current === preferences) return;
    const timer = window.setTimeout(() => {
      lastSaved.current = preferences;
      // Re-read before writing: the tray and the settings window save the same
      // object, and a stale copy here would revert the space switch.
      const { readingWidth, fontSize, defaultEncoding: encoding } = preferences;
      void getPreviewPreferences()
        .then((latest) =>
          savePreviewPreferences({
            ...latest,
            readingWidth,
            fontSize,
            defaultEncoding: encoding,
          })
        )
        .catch(() => {});
    }, 400);
    return () => window.clearTimeout(timer);
  }, [preferences]);

  // Keyed on the path, not the target object: a caller that passes an inline
  // object would otherwise reset the edit state on every parent render.
  useEffect(() => {
    reading.current?.abort();
    sourceBytes.current = null;
    setFile(null);
    setStack([]);
    setEditing(false);
    setText("");
    setOriginal("");
    setError(null);
    setEtag(latestTarget.current?.etag);
  }, [targetPath]);

  useEffect(() => {
    if (!targetPath) {
      setLoading(false);
      return;
    }
    let active = true;
    setLoading(true);
    setError(null);
    void inspectFile(targetPath)
      .then((info) => {
        if (!active) return;
        setFile({
          id: info.id,
          name: info.name,
          size: info.size,
          modified: info.modified,
          mime: info.mime,
          path: info.path,
          directory: info.directory,
        });
        // inspectPath drops the etag; the write conflict check needs it.
        setEtag(info.etag);
      })
      .catch((reason) => {
        if (active) setError(reason);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [targetPath, reload]);

  useEffect(() => () => reading.current?.abort(), []);

  const update = useCallback(
    (next: Partial<Pick<PreviewPreferences, "readingWidth" | "fontSize" | "defaultEncoding">>) =>
      setPreferences((current) => ({ ...current, ...next })),
    []
  );

  const current = stack.length ? stack[stack.length - 1] : file;
  const kind = current ? detectKind(current.name) : "binary";
  const dirty = editing && text !== original;
  const dirtyHandler = useRef(onDirtyChange);
  useEffect(() => {
    dirtyHandler.current = onDirtyChange;
  });
  useEffect(() => {
    dirtyHandler.current?.(dirty);
  }, [dirty]);
  const canEdit =
    !!current && !current.directory && !!current.path && EDITABLE.includes(kind) && !loading;
  const gestureActive = editing || READABLE.includes(kind);

  const leaveEdit = useCallback(() => {
    if (
      editing &&
      dirty &&
      !window.confirm(
        t("spacePreview.host.discardChanges", { defaultValue: "Discard the unsaved changes?" })
      )
    )
      return false;
    setEditing(false);
    sourceBytes.current = null;
    return true;
  }, [dirty, editing, t]);

  const decodeInto = useCallback((bytes: Uint8Array, selected: TextEncoding) => {
    const decoded = decodeText(bytes, selected);
    setEncoding(selected);
    setDetected(detectedEncoding(decoded.encoding));
    setText(decoded.text);
    setOriginal(decoded.text);
  }, []);

  const startEdit = useCallback(async () => {
    if (!current) return;
    reading.current?.abort();
    const controller = new AbortController();
    reading.current = controller;
    try {
      const bytes = await readFullBytes(current, controller.signal);
      if (controller.signal.aborted) return;
      sourceBytes.current = bytes;
      decodeInto(bytes, preferences.defaultEncoding);
      setEditing(true);
    } catch (reason) {
      if (!controller.signal.aborted)
        toast.error(
          t("spacePreview.host.editFailed", {
            defaultValue: "The file cannot be opened for editing.",
          }),
          { description: describe(reason) }
        );
    } finally {
      if (reading.current === controller) reading.current = null;
    }
  }, [current, decodeInto, describe, preferences.defaultEncoding, t]);

  // Re-decode the bytes read when the edit started; unsaved edits are dropped.
  const changeEncoding = useCallback(
    (next: TextEncoding) => {
      const bytes = sourceBytes.current;
      if (!bytes || next === encoding) return;
      if (
        dirty &&
        !window.confirm(
          t("spacePreview.host.discardChanges", { defaultValue: "Discard the unsaved changes?" })
        )
      )
        return;
      decodeInto(bytes, next);
    },
    [decodeInto, dirty, encoding, t]
  );

  const save = useCallback(async () => {
    if (!current?.path || saving || text === original) return;
    setSaving(true);
    try {
      const effective = encoding === "auto" ? detected : encoding;
      const result = await writeText(current.path, text, effective, etag);
      setFile((value) =>
        value ? { ...value, size: result.size, modified: result.modified } : value
      );
      setEtag(result.etag);
      setOriginal(text);
      setEditing(false);
      sourceBytes.current = null;
      setReload((value) => value + 1);
      onEdited?.({
        path: current.path,
        name: current.name,
        size: result.size,
        etag: result.etag,
      });
      toast.success(t("spacePreview.host.saved", { defaultValue: "Saved" }));
    } catch (reason) {
      toast.error(
        t("spacePreview.host.saveFailed", { defaultValue: "The file could not be saved." }),
        {
          description: describe(reason),
        }
      );
    } finally {
      setSaving(false);
    }
  }, [current, describe, detected, encoding, etag, onEdited, original, saving, t, text]);

  const reloadFile = useCallback(() => {
    if (!leaveEdit()) return;
    setReload((value) => value + 1);
  }, [leaveEdit]);

  const openInWindow = useCallback(() => {
    if (!current?.path) return;
    void openPreview([current.path]).catch((reason: unknown) =>
      toast.error(
        t("spacePreview.host.openFailed", { defaultValue: "The window could not be opened." }),
        {
          description: describe(reason),
        }
      )
    );
  }, [current, describe, t]);

  const close = useCallback(() => {
    if (!leaveEdit()) return;
    onClose?.();
  }, [leaveEdit, onClose]);

  return (
    <ViewerPreferencesProvider
      preferences={{
        readingWidth: preferences.readingWidth,
        fontSize: preferences.fontSize,
        defaultEncoding: preferences.defaultEncoding,
      }}
      update={update}
    >
      <TextAppearanceProvider active={gestureActive}>
        <PreviewLoadingProvider>
          <PreviewMenuTarget.Provider value={menuTarget}>
            <div className={cn("sp-preview flex h-full min-h-0 w-full flex-col", className)}>
              <header className="border-border bg-card flex h-12 shrink-0 items-center gap-2 border-b px-3">
                {stack.length > 0 && (
                  <button
                    type="button"
                    aria-label={t("spacePreview.host.back", {
                      defaultValue: "Back to the parent file",
                    })}
                    title={t("spacePreview.host.back", { defaultValue: "Back to the parent file" })}
                    className="hover:bg-accent rounded-md p-1.5"
                    onClick={() => {
                      if (leaveEdit()) setStack((value) => value.slice(0, -1));
                    }}
                  >
                    <ArrowLeft className="size-4" />
                  </button>
                )}
                {current && <FileIcon name={current.name} path={current.path} size={22} />}
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium" title={current?.path}>
                    {current?.name ??
                      (loading
                        ? t("spacePreview.host.loading", { defaultValue: "Loading…" })
                        : t("spacePreview.host.noFile", { defaultValue: "No file selected" }))}
                  </p>
                  {current && (
                    <p className="text-muted-foreground text-xs">
                      {t("spacePreview.host.fileMeta", {
                        defaultValue: "{{size}} · {{type}}",
                        size: formatSize(current.size),
                        type: kind.toUpperCase(),
                      })}
                    </p>
                  )}
                </div>
                <div
                  ref={setMenuTarget}
                  className="flex min-w-0 flex-1 items-center justify-end gap-2"
                />
                <div className="flex shrink-0 items-center gap-1">
                  {editing ? (
                    <>
                      <button
                        type="button"
                        className="hover:bg-accent flex items-center gap-1 rounded-md px-2 py-1.5 text-sm disabled:opacity-50"
                        disabled={saving || !dirty}
                        onClick={() => void save()}
                      >
                        <Save className="size-4" />
                        {t("spacePreview.host.save", { defaultValue: "Save" })}
                      </button>
                      <button
                        type="button"
                        className="hover:bg-accent flex items-center gap-1 rounded-md px-2 py-1.5 text-sm"
                        onClick={() => leaveEdit()}
                      >
                        <X className="size-4" />
                        {t("spacePreview.host.cancelEdit", { defaultValue: "Cancel" })}
                      </button>
                      <select
                        aria-label={t("spacePreview.viewer.textEncoding", {
                          defaultValue: "Text encoding",
                        })}
                        title={t("spacePreview.viewer.fileEncoding", {
                          defaultValue: "File encoding",
                        })}
                        value={encoding}
                        disabled={saving}
                        onChange={(event) => changeEncoding(event.target.value as TextEncoding)}
                        className="border-border bg-background text-foreground h-8 rounded-md border px-2 text-xs disabled:opacity-50"
                      >
                        {ENCODINGS.map((item) => (
                          <option key={item.value} value={item.value}>
                            {t(item.key, { defaultValue: item.fallback })}
                          </option>
                        ))}
                      </select>
                    </>
                  ) : (
                    <>
                      {canEdit && (
                        <button
                          type="button"
                          aria-label={t("spacePreview.host.edit", { defaultValue: "Edit" })}
                          title={t("spacePreview.host.edit", { defaultValue: "Edit" })}
                          className="hover:bg-accent rounded-md p-1.5"
                          onClick={() => void startEdit()}
                        >
                          <Pencil className="size-4" />
                        </button>
                      )}
                      <button
                        type="button"
                        aria-label={t("spacePreview.host.reload", { defaultValue: "Reload" })}
                        title={t("spacePreview.host.reload", { defaultValue: "Reload" })}
                        className="hover:bg-accent rounded-md p-1.5"
                        onClick={reloadFile}
                      >
                        <RotateCw className="size-4" />
                      </button>
                      {mode === "embedded" && current?.path && (
                        <button
                          type="button"
                          aria-label={t("spacePreview.host.openInWindow", {
                            defaultValue: "Open in a window",
                          })}
                          title={t("spacePreview.host.openInWindow", {
                            defaultValue: "Open in a window",
                          })}
                          className="hover:bg-accent rounded-md p-1.5"
                          onClick={openInWindow}
                        >
                          <ExternalLink className="size-4" />
                        </button>
                      )}
                      {mode === "window" && onClose && (
                        <button
                          type="button"
                          aria-label={t("spacePreview.host.close", { defaultValue: "Close" })}
                          title={t("spacePreview.host.close", { defaultValue: "Close" })}
                          className="hover:bg-accent rounded-md p-1.5"
                          onClick={close}
                        >
                          <X className="size-4" />
                        </button>
                      )}
                    </>
                  )}
                </div>
              </header>
              <div className="relative flex min-h-0 flex-1 flex-col">
                {editing && current ? (
                  <CodeEditor
                    value={text}
                    language={languageOf(current.name)}
                    ariaLabel={t("spacePreview.host.edit", { defaultValue: "Edit" })}
                    showFind
                    onChange={setText}
                    onSave={() => void save()}
                  />
                ) : error !== null ? (
                  <div className="text-muted-foreground grid flex-1 place-items-center p-8 text-center">
                    <div>
                      <p className="text-foreground font-medium">
                        {t("spacePreview.host.loadFailed", {
                          defaultValue: "The file could not be opened.",
                        })}
                      </p>
                      <p className="mt-1 text-xs">{describe(error)}</p>
                    </div>
                  </div>
                ) : loading && !current ? (
                  <div className="text-muted-foreground grid flex-1 place-items-center p-8 text-center">
                    {t("spacePreview.host.loading", { defaultValue: "Loading…" })}
                  </div>
                ) : current ? (
                  <Preview
                    key={`${current.id}:${reload}`}
                    file={current}
                    mode={textMode ? "text" : "auto"}
                    onOpen={(next) => setStack((value) => [...value, next])}
                  />
                ) : (
                  <div className="text-muted-foreground grid flex-1 place-items-center p-8 text-center">
                    <div>
                      <p className="text-foreground font-medium">
                        {folderOnly
                          ? t("spacePreview.host.folderTitle", {
                              defaultValue: "Folders are not previewed",
                            })
                          : t("spacePreview.host.emptyTitle", {
                              defaultValue: "Nothing to preview",
                            })}
                      </p>
                      <p className="mt-1 text-xs">
                        {folderOnly
                          ? t("spacePreview.viewer.folderNotPreviewed", {
                              defaultValue:
                                "Folders are explored in the project file tree, not in the preview.",
                            })
                          : t("spacePreview.host.emptyBody", {
                              defaultValue: "Select a file to preview it here.",
                            })}
                      </p>
                    </div>
                  </div>
                )}
                <PreviewLoadingIndicator />
              </div>
            </div>
          </PreviewMenuTarget.Provider>
        </PreviewLoadingProvider>
      </TextAppearanceProvider>
    </ViewerPreferencesProvider>
  );
}
