import { Component, useEffect, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, FileText, Loader2, Save } from "lucide-react";
import { toast } from "sonner";
import {
  pluginsList,
  pluginsOpenFile,
  pluginsSaveFileConfig,
  type PluginConfigFileView,
  type PluginView,
} from "@/commands";
import { ConfigFieldRow } from "@/components/config-field-row";
import { TitleBar } from "@/components/title-bar";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { WindowFrame } from "@/components/window-frame";
import { useAppTranslation } from "@/hooks/use-app-translation";

/** How long to wait after the last keystroke before writing a file. */
const SAVE_DELAY = 400;

/**
 * Keeps a bad manifest from taking the whole window with it.
 *
 * Everything below renders data a plugin declared, and the window is frameless
 * and transparent: an uncaught render error unmounts the tree, and an unmounted
 * tree in a transparent window does not read as a crash — it reads as a window
 * that opens and then vanishes, with nothing to go on. A boundary turns that
 * into a message naming what went wrong.
 */
class RenderGuard extends Component<
  { message: string; children: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error("The plugin config window failed to render:", error);
  }

  render() {
    const { error } = this.state;
    if (!error) {
      return this.props.children;
    }

    return (
      <div className="flex items-start gap-2 p-4 text-sm">
        <AlertTriangle className="text-destructive size-4 shrink-0" />
        <div className="min-w-0 space-y-1">
          <div className="text-destructive font-medium">{this.props.message}</div>
          <div className="text-muted-foreground font-mono text-xs break-all">{error.message}</div>
        </div>
      </div>
    );
  }
}

/** The plugin this window was opened for, from its own URL. */
function pluginIdFromUrl(): string {
  return new URLSearchParams(window.location.search).get("id") ?? "";
}

export default function PluginConfigWindow() {
  const { t } = useAppTranslation();
  const [id] = useState(pluginIdFromUrl);
  const [plugin, setPlugin] = useState<PluginView | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;

    pluginsList()
      .then((list) => {
        if (cancelled) return;
        const found = list.find((item) => item.id === id);
        if (!found) {
          setFailed(true);
          return;
        }
        setPlugin(found);
      })
      .catch((error: unknown) => {
        console.error("Failed to load the plugin:", error);
        if (!cancelled) setFailed(true);
      });

    return () => {
      cancelled = true;
    };
  }, [id]);

  return (
    <WindowFrame
      titleBar={<TitleBar title={t("pluginConfig.title")} showPin showMaximize={true} />}
      contentClassName="flex flex-1 flex-col overflow-hidden"
    >
      <RenderGuard message={t("pluginConfig.renderFailed")}>
        {failed ? (
          <div className="text-destructive flex items-center gap-2 p-4 text-sm">
            <AlertTriangle className="size-4 shrink-0" />
            {t("pluginConfig.notFound")}
          </div>
        ) : plugin === null ? (
          <div className="space-y-3 p-4">
            <Skeleton className="h-6 w-48" />
            <Skeleton className="h-32 w-full rounded-lg" />
          </div>
        ) : (
          <ConfigBody plugin={plugin} />
        )}
      </RenderGuard>
    </WindowFrame>
  );
}

function ConfigBody({ plugin }: { plugin: PluginView }) {
  const { t } = useAppTranslation();

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-border flex shrink-0 items-center gap-2 border-b px-4 py-2">
        <span className="truncate text-sm font-medium">{plugin.name}</span>
        {plugin.version && (
          <span className="bg-secondary text-secondary-foreground rounded-full px-2 py-0.5 text-xs">
            {plugin.version}
          </span>
        )}
        <span
          className="text-muted-foreground ml-auto truncate font-mono text-xs"
          title={plugin.dir}
        >
          {plugin.dir}
        </span>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-auto p-4">
        {plugin.files.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t("plugins.noConfig")}</p>
        ) : (
          plugin.files.map((file) => (
            <ConfigFileBlock
              key={file.path}
              pluginId={plugin.id}
              pluginName={plugin.name}
              file={file}
            />
          ))
        )}
      </div>
    </div>
  );
}

/** One config source: its header, its declared fields, and its save state. */
function ConfigFileBlock({
  pluginId,
  pluginName,
  file,
}: {
  pluginId: string;
  pluginName: string;
  file: PluginConfigFileView;
}) {
  const { t } = useAppTranslation();
  const [values, setValues] = useState<Record<string, unknown>>(() =>
    Object.fromEntries(file.fields.map((field) => [field.key, field.value]))
  );
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  // Only a change the user made should be written back; simply mounting must
  // not rewrite the file.
  const dirty = useRef(false);

  useEffect(() => {
    if (!dirty.current) return;

    const timer = setTimeout(() => {
      setSaving(true);
      pluginsSaveFileConfig(pluginId, file.path, values)
        .then(() => {
          setSaved(true);
          setTimeout(() => setSaved(false), 1500);
        })
        .catch((error: unknown) => {
          console.error("Failed to save plugin config:", error);
          toast.error(t("plugins.saveFailed", { name: pluginName, message: String(error) }));
        })
        .finally(() => setSaving(false));
    }, SAVE_DELAY);

    return () => clearTimeout(timer);
  }, [values, pluginId, file.path, pluginName, t]);

  const patch = (key: string, value: unknown) => {
    dirty.current = true;
    setValues((current) => ({ ...current, [key]: value }));
  };

  return (
    <div className="rounded-lg border">
      <div className="border-border flex items-center gap-2 border-b px-3 py-2">
        <span className="bg-secondary text-secondary-foreground rounded px-1.5 py-0.5 font-mono text-xs uppercase">
          {file.fileType}
        </span>
        <span className="truncate font-mono text-xs">{file.path}</span>
        {file.external && (
          <span className="border-border text-muted-foreground rounded border px-1.5 py-0.5 text-[10px]">
            {t("pluginConfig.external")}
          </span>
        )}
        {file.startmust && (
          <span className="border-border text-muted-foreground rounded border px-1.5 py-0.5 text-[10px]">
            {t("pluginConfig.required")}
          </span>
        )}

        <div className="ml-auto flex items-center gap-2">
          {saving ? (
            <Loader2 className="text-muted-foreground size-3.5 animate-spin" />
          ) : saved ? (
            <Save className="text-muted-foreground size-3.5" />
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-1.5 text-xs"
            onClick={() => void pluginsOpenFile(pluginId, file.path)}
          >
            <FileText className="size-3.5" />
            {t("pluginConfig.openFile")}
          </Button>
        </div>
      </div>

      <div className="space-y-3 p-3">
        {!file.exists && (
          <p className="text-muted-foreground text-xs">
            {t(file.external ? "pluginConfig.missingExternal" : "pluginConfig.missing")}
          </p>
        )}

        {file.fields.length === 0 ? (
          <p className="text-muted-foreground text-xs">{t("pluginConfig.noFields")}</p>
        ) : (
          file.fields.map((field) => (
            <ConfigFieldRow
              key={field.key}
              field={field}
              value={values[field.key]}
              onChange={(value) => patch(field.key, value)}
            />
          ))
        )}
      </div>
    </div>
  );
}
