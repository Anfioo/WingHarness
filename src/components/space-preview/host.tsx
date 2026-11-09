import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { ArrowLeft, ExternalLink, Pencil, RotateCw, Save, X } from "lucide-react";
import { toast } from "sonner";
import {
  getPreviewPreferences,
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
import { inspectPath, readFullBytes } from "@/lib/space-preview/bridge";
import { decodeText, formatSize } from "@/lib/space-preview/engine/files";
import { detectKind } from "@/lib/space-preview/registry";
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
  readingWidth: 860,
  fontSize: 16,
  defaultEncoding: "auto",
};

// The bytes are decoded with the preferred encoding, so the write reuses it;
// with "auto" the BOM decides, and a file without one is written back as UTF-8.
function writeEncoding(bytes: Uint8Array, selected: TextEncoding): TextEncoding {
  if (selected !== "auto") return selected;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le";
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return "utf-16be";
  return "utf-8";
}

function failure(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

export function PreviewHost({
  mode,
  target,
  onClose,
  onEdited,
  className,
}: PreviewHostProps): ReactElement {
  const { t } = useAppTranslation();
  const [preferences, setPreferences] = useState<PreviewPreferences>(DEFAULT_PREFERENCES);
  const [file, setFile] = useState<PreviewFile | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const [stack, setStack] = useState<PreviewFile[]>([]);
  const [menuTarget, setMenuTarget] = useState<HTMLDivElement | null>(null);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const [original, setOriginal] = useState("");
  const [saving, setSaving] = useState(false);
  const [encoding, setEncoding] = useState<TextEncoding>("utf-8");
  const [etag, setEtag] = useState<string | undefined>(target?.etag);
  const lastSaved = useRef<PreviewPreferences | null>(null);

  useEffect(() => {
    let active = true;
    void getPreviewPreferences()
      .then((value) => {
        if (!active) return;
        lastSaved.current = value;
        setPreferences(value);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!lastSaved.current || lastSaved.current === preferences) return;
    const timer = window.setTimeout(() => {
      lastSaved.current = preferences;
      void savePreviewPreferences(preferences).catch(() => {});
    }, 400);
    return () => window.clearTimeout(timer);
  }, [preferences]);

  useEffect(() => {
    setStack([]);
    setEditing(false);
    setText("");
    setOriginal("");
    setEtag(target?.etag);
  }, [target]);

  useEffect(() => {
    if (!target) {
      setFile(null);
      setError("");
      setLoading(false);
      return;
    }
    let active = true;
    setLoading(true);
    setError("");
    void inspectPath(target.path)
      .then((value) => {
        if (active) setFile(value);
      })
      .catch((reason) => {
        if (active) setError(failure(reason));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [target, reload]);

  const update = useCallback(
    (next: Partial<Pick<PreviewPreferences, "readingWidth" | "fontSize" | "defaultEncoding">>) =>
      setPreferences((current) => ({ ...current, ...next })),
    []
  );

  const current = stack.length ? stack[stack.length - 1] : file;
  const kind = current ? detectKind(current.name) : "binary";
  const dirty = editing && text !== original;
  const canEdit =
    !!current && !current.directory && !!current.path && EDITABLE.includes(kind) && !loading;
  const gestureActive = editing || READABLE.includes(kind);

  const leaveEdit = useCallback(() => {
    if (editing && dirty && !window.confirm(t("spacePreview.host.discardChanges"))) return false;
    setEditing(false);
    return true;
  }, [dirty, editing, t]);

  const startEdit = useCallback(async () => {
    if (!current) return;
    try {
      const controller = new AbortController();
      const bytes = await readFullBytes(current, controller.signal);
      const preferred = preferences.defaultEncoding;
      const decoded = decodeText(bytes, preferred);
      setEncoding(writeEncoding(bytes, preferred));
      setText(decoded.text);
      setOriginal(decoded.text);
      setEditing(true);
    } catch (reason) {
      toast.error(t("spacePreview.host.editFailed"), { description: failure(reason) });
    }
  }, [current, preferences.defaultEncoding, t]);

  const save = useCallback(async () => {
    if (!current?.path || saving || text === original) return;
    setSaving(true);
    try {
      const result = await writeText(current.path, text, encoding, etag);
      setFile((value) =>
        value ? { ...value, size: result.size, modified: result.modified } : value
      );
      setEtag(result.etag);
      setOriginal(text);
      setEditing(false);
      setReload((value) => value + 1);
      onEdited?.({
        path: current.path,
        name: current.name,
        size: result.size,
        etag: result.etag,
      });
      toast.success(t("spacePreview.host.saved"));
    } catch (reason) {
      toast.error(t("spacePreview.host.saveFailed"), { description: failure(reason) });
    } finally {
      setSaving(false);
    }
  }, [current, encoding, etag, onEdited, original, saving, t, text]);

  const reloadFile = useCallback(() => {
    if (!leaveEdit()) return;
    setReload((value) => value + 1);
  }, [leaveEdit]);

  const openInWindow = useCallback(() => {
    if (!current?.path) return;
    void openPreview([current.path]).catch((reason: unknown) =>
      toast.error(t("spacePreview.host.openFailed"), { description: failure(reason) })
    );
  }, [current, t]);

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
                    aria-label={t("spacePreview.host.back")}
                    title={t("spacePreview.host.back")}
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
                      (loading ? t("spacePreview.host.loading") : t("spacePreview.host.noFile"))}
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
                        {t("spacePreview.host.save")}
                      </button>
                      <button
                        type="button"
                        className="hover:bg-accent flex items-center gap-1 rounded-md px-2 py-1.5 text-sm"
                        onClick={() => leaveEdit()}
                      >
                        <X className="size-4" />
                        {t("spacePreview.host.cancelEdit")}
                      </button>
                    </>
                  ) : (
                    <>
                      {canEdit && (
                        <button
                          type="button"
                          aria-label={t("spacePreview.host.edit")}
                          title={t("spacePreview.host.edit")}
                          className="hover:bg-accent rounded-md p-1.5"
                          onClick={() => void startEdit()}
                        >
                          <Pencil className="size-4" />
                        </button>
                      )}
                      <button
                        type="button"
                        aria-label={t("spacePreview.host.reload")}
                        title={t("spacePreview.host.reload")}
                        className="hover:bg-accent rounded-md p-1.5"
                        onClick={reloadFile}
                      >
                        <RotateCw className="size-4" />
                      </button>
                      {mode === "embedded" && current?.path && (
                        <button
                          type="button"
                          aria-label={t("spacePreview.host.openInWindow")}
                          title={t("spacePreview.host.openInWindow")}
                          className="hover:bg-accent rounded-md p-1.5"
                          onClick={openInWindow}
                        >
                          <ExternalLink className="size-4" />
                        </button>
                      )}
                      {mode === "window" && onClose && (
                        <button
                          type="button"
                          aria-label={t("spacePreview.host.close")}
                          title={t("spacePreview.host.close")}
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
                    ariaLabel={t("spacePreview.host.edit")}
                    onChange={setText}
                    onSave={() => void save()}
                  />
                ) : error ? (
                  <div className="text-muted-foreground grid flex-1 place-items-center p-8 text-center">
                    <div>
                      <p className="text-foreground font-medium">
                        {t("spacePreview.host.loadFailed")}
                      </p>
                      <p className="mt-1 text-xs">{error}</p>
                    </div>
                  </div>
                ) : loading && !current ? (
                  <div className="text-muted-foreground grid flex-1 place-items-center p-8 text-center">
                    {t("spacePreview.host.loading")}
                  </div>
                ) : current ? (
                  <Preview
                    key={`${current.id}:${reload}`}
                    file={current}
                    mode="auto"
                    onOpen={(next) => setStack((value) => [...value, next])}
                  />
                ) : (
                  <div className="text-muted-foreground grid flex-1 place-items-center p-8 text-center">
                    <div>
                      <p className="text-foreground font-medium">
                        {t("spacePreview.host.emptyTitle")}
                      </p>
                      <p className="mt-1 text-xs">{t("spacePreview.host.emptyBody")}</p>
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
