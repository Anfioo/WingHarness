import { useCallback, useEffect, useState } from "react";
import { open as pickFile } from "@tauri-apps/plugin-dialog";
import { Archive, Download, FolderOpen, Globe, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import {
  frpRuntimeImport,
  openPath,
  runtimeReadArchive,
  runtimeTarget,
  type RuntimeKind,
  type RuntimeTarget,
} from "@/commands";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { useAppTranslation } from "@/hooks/use-app-translation";
import {
  downloadArchive,
  extractArchive,
  writeArchiveFiles,
  type ArchiveSource,
  type RuntimeProgress,
} from "@/lib/runtime/install";
import { OFFICIAL_RUNTIME_URLS, runtimeBinaryName } from "@/lib/runtime/official";
import { cn } from "@/lib/utils";

export type RuntimeInstallerProps = {
  kind: RuntimeKind;
  title: string;
  description?: string;
  /** Marks the card as the fixed official entry (the FRP runtime tab). */
  official?: boolean;
  /** Shown when the host already knows the installed version. */
  version?: string | null;
  /** Extra line under the path, such as the FRP tab's non-deletable note. */
  hint?: string;
  onInstalled?: () => void | Promise<void>;
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Install or replace one runtime from an official archive, a custom URL, or a
 * local archive. The archive is downloaded by the moin engine, unpacked in the
 * webview, and written to disk by the runtime file bridge, so this card is the
 * same in Settings and in the Clash/FRP pages.
 */
export function RuntimeInstaller({
  kind,
  title,
  description,
  official,
  version,
  hint,
  onInstalled,
}: RuntimeInstallerProps) {
  const { t } = useAppTranslation();

  const [target, setTarget] = useState<RuntimeTarget | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<RuntimeProgress | null>(null);
  const [urlOpen, setUrlOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [urlError, setUrlError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setTarget(await runtimeTarget(kind));
      setLoadError(null);
    } catch (error) {
      setLoadError(t("runtime.errors.statusFailed", { detail: messageOf(error) }));
    }
  }, [kind, t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const runInstall = async (
    load: () => Promise<ArchiveSource>,
    initial: "download" | "extract"
  ) => {
    if (busy) return;
    try {
      setBusy({ phase: initial });
      const source = await load();
      setBusy({ phase: "extract" });
      const files = await extractArchive(source);
      const binary = runtimeBinaryName(kind);
      if (!files.some((file) => file.path.toLowerCase() === binary.toLowerCase())) {
        throw new Error(t("runtime.errors.binaryMissing", { binary }));
      }
      setBusy({ phase: "write", value: 0, done: 0, total: files.length });
      await writeArchiveFiles(kind, files, (value, done, total) =>
        setBusy({ phase: "write", value, done, total })
      );
      // An FRP runtime is only useful once it is in the workspace, so an
      // unpacked frpc is registered in the same action that installs it.
      if (kind === "frp") await frpRuntimeImport((await runtimeTarget("frp")).binary);
      await refresh();
      await onInstalled?.();
      toast.success(t("runtime.messages.installed", { name: title }));
    } catch (error) {
      toast.error(t("runtime.errors.installFailed", { detail: messageOf(error) }));
    } finally {
      setBusy(null);
    }
  };

  const installOfficial = () =>
    void runInstall(
      () =>
        downloadArchive(OFFICIAL_RUNTIME_URLS[kind], (value) =>
          setBusy({ phase: "download", value })
        ),
      "download"
    );

  const installFromUrl = () => {
    const trimmed = url.trim();
    if (!/^https?:\/\//i.test(trimmed)) {
      setUrlError(t("runtime.errors.invalidUrl"));
      return;
    }
    setUrlOpen(false);
    setUrlError(null);
    void runInstall(
      () => downloadArchive(trimmed, (value) => setBusy({ phase: "download", value })),
      "download"
    );
  };

  const installFromArchive = async () => {
    const picked = await pickFile({
      multiple: false,
      directory: false,
      filters: [{ name: "Archive", extensions: ["7z", "zip"] }],
    });
    if (typeof picked !== "string") return;
    await runInstall(
      async () => ({ name: picked, bytes: await runtimeReadArchive(picked) }),
      "extract"
    );
  };

  const installed = target?.installed ?? false;
  const checking = target === null && loadError === null;

  return (
    <section className="border-border bg-card flex flex-col gap-3 rounded-lg border p-3">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="text-sm font-semibold">{title}</span>
        {official && <Badge variant="secondary">{t("runtime.official")}</Badge>}
        {checking ? (
          <Badge variant="outline">
            <Loader2 className="animate-spin" />
            {t("runtime.status.checking")}
          </Badge>
        ) : installed ? (
          <Badge className="border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400">
            {t("runtime.status.installed")}
          </Badge>
        ) : (
          <Badge variant="destructive">{t("runtime.status.missing")}</Badge>
        )}
        {installed && version && (
          <span className="text-muted-foreground text-xs">{t("runtime.version", { version })}</span>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <Button
            size="xs"
            variant="outline"
            disabled={busy !== null || !target}
            onClick={() => void refresh()}
            title={t("runtime.action.refresh")}
          >
            <RefreshCw />
          </Button>
          <Button
            size="xs"
            variant="outline"
            disabled={!target}
            onClick={() => target && void openPath(target.dir)}
            title={t("runtime.action.openDir")}
          >
            <FolderOpen />
            {t("runtime.action.openDir")}
          </Button>
        </div>
      </div>

      {description && <p className="text-muted-foreground text-xs">{description}</p>}

      <p className="text-muted-foreground truncate font-mono text-xs" title={target?.binary}>
        {target?.binary ?? "—"}
      </p>

      {hint && <p className="text-muted-foreground text-xs">{hint}</p>}

      {busy && (
        <div className="space-y-1">
          <div className="text-muted-foreground flex items-center justify-between text-xs">
            <span className="flex items-center gap-1.5">
              <Loader2 className="size-3.5 animate-spin" />
              {busy.phase === "download"
                ? t("runtime.progress.download")
                : busy.phase === "extract"
                  ? t("runtime.progress.extract")
                  : t("runtime.progress.write", { done: busy.done, total: busy.total })}
            </span>
            {busy.phase === "download" && busy.value !== undefined && (
              <span className="tabular-nums">{Math.round(busy.value * 100)}%</span>
            )}
          </div>
          <Progress
            value={
              busy.phase === "download"
                ? busy.value !== undefined
                  ? busy.value * 100
                  : 100
                : busy.phase === "write"
                  ? busy.value * 100
                  : 100
            }
            className={cn(
              busy.phase === "extract" || (busy.phase === "download" && busy.value === undefined)
                ? "animate-pulse"
                : undefined
            )}
          />
        </div>
      )}

      {loadError && <p className="text-destructive text-xs break-words">{loadError}</p>}

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={busy !== null} onClick={() => void installOfficial()}>
          <Download />
          {installed ? t("runtime.action.reinstall") : t("runtime.action.official")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy !== null}
          onClick={() => {
            setUrlError(null);
            setUrlOpen(true);
          }}
        >
          <Globe />
          {t("runtime.action.url")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy !== null}
          onClick={() => void installFromArchive()}
        >
          <Archive />
          {t("runtime.action.archive")}
        </Button>
        <span className="text-muted-foreground text-xs">{t("runtime.hint.archive")}</span>
      </div>

      <Dialog open={urlOpen} onOpenChange={setUrlOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("runtime.dialog.urlTitle")}</DialogTitle>
            <DialogDescription>
              {t("runtime.dialog.urlDescription", { binary: runtimeBinaryName(kind) })}
            </DialogDescription>
          </DialogHeader>
          <Input
            value={url}
            placeholder={t("runtime.dialog.urlPlaceholder")}
            onChange={(event) => {
              setUrl(event.target.value);
              setUrlError(null);
            }}
          />
          {urlError && <p className="text-destructive text-sm">{urlError}</p>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setUrlOpen(false)}>
              {t("runtime.dialog.cancel")}
            </Button>
            <Button onClick={installFromUrl}>{t("runtime.dialog.install")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
