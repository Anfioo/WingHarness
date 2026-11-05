import { useCallback, useMemo, useState } from "react";
import { open as openDirectory } from "@tauri-apps/plugin-dialog";
import {
  AlertTriangle,
  ArrowRight,
  Download,
  FolderOpen,
  Link as LinkIcon,
  RotateCcw,
} from "lucide-react";
import { toast } from "sonner";
import { pathsExist, svnCheckout, svnWorkspaceRemember } from "@/commands";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { confirmDialog } from "@/components/confirm";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { openSvnWorkspaceWindow } from "@/lib/svn-windows";
import { cn } from "@/lib/utils";

/** Last path segment of a URL or directory, used for the destination preview. */
function baseName(value: string) {
  const parts = value
    .replace(/\\/g, "/")
    .replace(/[\\/]+$/, "")
    .split("/");
  return parts[parts.length - 1] || value;
}

/** A permissive SVN URL check: an absolute path or one of the known schemes. */
function isLikelyRepositoryUrl(url: string): boolean {
  const value = url.trim();
  if (!value) return false;
  if (/^(https?|svn|svn\+ssh|file):\/\//i.test(value)) return true;
  // A local repository path (e.g. C:\repo or /srv/repo) is also valid for svn.
  if (/^[A-Za-z]:[\\/]/.test(value) || value.startsWith("/") || value.startsWith("\\\\"))
    return true;
  return false;
}

/**
 * The checkout panel: pull a repository down into a new working copy. Mirrors the
 * reference `CheckoutView.vue` — URL + target directory + optional pinned
 * revision — with the target picked through the dialog plugin's directory picker.
 *
 * On success the freshly checked-out copy is opened in its own window, the same
 * path the picker page uses: remember it, then open its window. A checkout into
 * an existing directory is confirmed first (SVN will write into whatever is
 * there).
 */
export function CheckoutPanel() {
  const { t } = useAppTranslation();
  const [url, setUrl] = useState("");
  const [target, setTarget] = useState("");
  const [revision, setRevision] = useState("");
  const [busy, setBusy] = useState(false);
  const [output, setOutput] = useState("");
  const [urlError, setUrlError] = useState<string | null>(null);
  const [targetError, setTargetError] = useState<string | null>(null);

  const destinationName = useMemo(() => {
    const trimmed = target.trim();
    if (!trimmed) {
      const fromUrl = url.trim() ? baseName(url.trim()) : "";
      return fromUrl || null;
    }
    // A target ending in a separator means "check out into this folder"; the
    // repository's own name becomes the destination.
    if (/[\\/]$/.test(trimmed)) {
      const fromUrl = url.trim() ? baseName(url.trim()) : "";
      return fromUrl || baseName(trimmed);
    }
    return baseName(trimmed);
  }, [target, url]);

  const browse = useCallback(async () => {
    const selected = await openDirectory({
      directory: true,
      multiple: false,
      title: t("svnWorkspace.checkout.target.dialogTitle"),
    });
    if (typeof selected === "string") setTarget(selected);
  }, [t]);

  const reset = useCallback(() => {
    setUrl("");
    setTarget("");
    setRevision("");
    setOutput("");
    setUrlError(null);
    setTargetError(null);
  }, []);

  const doCheckout = useCallback(async () => {
    if (busy) return;
    const trimmedUrl = url.trim();
    const trimmedTarget = target.trim();
    const nextUrlError = !trimmedUrl
      ? t("svnWorkspace.checkout.url.required")
      : !isLikelyRepositoryUrl(trimmedUrl)
        ? t("svnWorkspace.checkout.url.invalid")
        : null;
    const nextTargetError = !trimmedTarget ? t("svnWorkspace.checkout.target.required") : null;
    setUrlError(nextUrlError);
    setTargetError(nextTargetError);
    if (nextUrlError || nextTargetError) return;

    const parsed = revision.trim() ? Number.parseInt(revision.trim(), 10) : undefined;
    if (revision.trim() && (!Number.isFinite(parsed) || (parsed as number) <= 0)) {
      toast.error(t("svnWorkspace.checkout.invalidRevision"));
      return;
    }

    // Warn when the target already exists: SVN writes into whatever is there.
    let exists = false;
    try {
      [exists] = await pathsExist([trimmedTarget]);
    } catch {
      exists = false;
    }

    const ok = await confirmDialog(
      exists
        ? {
            title: t("svnWorkspace.checkout.confirmExisting.title"),
            description: t("svnWorkspace.checkout.confirmExisting.description"),
            path: trimmedTarget,
            confirmLabel: t("svnWorkspace.checkout.start"),
            destructive: true,
          }
        : {
            title: t("svnWorkspace.checkout.confirm.title"),
            description: parsed
              ? t("svnWorkspace.checkout.confirm.descriptionRevision", { revision: parsed })
              : t("svnWorkspace.checkout.confirm.description"),
            confirmLabel: t("svnWorkspace.checkout.start"),
          }
    );
    if (!ok) return;

    setBusy(true);
    setOutput("");
    try {
      const result = await svnCheckout(trimmedUrl, trimmedTarget, parsed);
      setOutput(result.output);
      void svnWorkspaceRemember(trimmedTarget).catch(() => undefined);
      await openSvnWorkspaceWindow(trimmedTarget);
      toast.success(t("svnWorkspace.checkout.toast.success", { name: destinationName ?? "" }));
    } catch (err) {
      setOutput(`${t("svnWorkspace.common.error")}: ${String(err)}`);
      toast.error(t("svnWorkspace.checkout.toast.failed", { error: String(err) }));
    } finally {
      setBusy(false);
    }
  }, [busy, url, target, revision, destinationName, t]);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-auto">
      <div className="border-border border-b px-3 py-2">
        <span className="flex items-center gap-1.5 text-sm font-medium">
          <Download className="text-muted-foreground size-4" />
          {t("svnWorkspace.checkout.title")}
        </span>
      </div>

      <div className="flex w-full flex-col gap-4 p-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="svn-checkout-url" className="text-xs">
            <LinkIcon className="mr-1 inline size-3.5" />
            {t("svnWorkspace.checkout.url.label")}
          </Label>
          <Input
            id="svn-checkout-url"
            value={url}
            onChange={(event) => {
              setUrl(event.target.value);
              if (urlError) setUrlError(null);
            }}
            placeholder={t("svnWorkspace.checkout.url.placeholder")}
            aria-invalid={urlError ? true : undefined}
            spellCheck={false}
            className="font-mono text-xs"
          />
          {urlError ? (
            <span className="text-destructive flex items-center gap-1 text-[11px]">
              <AlertTriangle className="size-3" />
              {urlError}
            </span>
          ) : null}
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="svn-checkout-target" className="text-xs">
            <FolderOpen className="mr-1 inline size-3.5" />
            {t("svnWorkspace.checkout.target.label")}
          </Label>
          <div className="flex items-center gap-2">
            <Input
              id="svn-checkout-target"
              value={target}
              onChange={(event) => {
                setTarget(event.target.value);
                if (targetError) setTargetError(null);
              }}
              placeholder={t("svnWorkspace.checkout.target.placeholder")}
              aria-invalid={targetError ? true : undefined}
              spellCheck={false}
              className="font-mono text-xs"
            />
            <Button variant="outline" size="sm" onClick={() => void browse()}>
              <FolderOpen className="size-3.5" />
              {t("svnWorkspace.checkout.target.browse")}
            </Button>
          </div>
          {targetError ? (
            <span className="text-destructive flex items-center gap-1 text-[11px]">
              <AlertTriangle className="size-3" />
              {targetError}
            </span>
          ) : null}
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="svn-checkout-revision" className="text-xs">
            {t("svnWorkspace.checkout.revision.label")}
          </Label>
          <Input
            id="svn-checkout-revision"
            value={revision}
            onChange={(event) => setRevision(event.target.value.replace(/[^0-9]/g, ""))}
            placeholder={t("svnWorkspace.checkout.revision.placeholder")}
            inputMode="numeric"
            className="w-40 text-xs"
          />
          <span className="text-muted-foreground text-[11px]">
            {t("svnWorkspace.checkout.revision.hint")}
          </span>
        </div>

        <div className="border-border bg-muted/30 flex items-center gap-2 rounded-md border px-3 py-2 text-xs">
          <span className="text-muted-foreground">
            {t("svnWorkspace.checkout.destination.label")}
          </span>
          {destinationName ? (
            <span className="text-foreground flex min-w-0 items-center gap-1 font-mono font-medium">
              <ArrowRight className="text-faint size-3 shrink-0" />
              <span className="truncate" title={destinationName}>
                {destinationName}
              </span>
            </span>
          ) : (
            <span className="text-muted-foreground">
              {t("svnWorkspace.checkout.destination.none")}
            </span>
          )}
        </div>

        <div className="flex items-center justify-end gap-2">
          <Button variant="outline" size="sm" onClick={reset} disabled={busy}>
            <RotateCcw className="size-3.5" />
            {t("svnWorkspace.checkout.reset")}
          </Button>
          <Button size="sm" onClick={() => void doCheckout()} disabled={busy}>
            <Download className={cn("size-3.5", busy && "animate-pulse")} />
            {busy ? t("svnWorkspace.checkout.checkingOut") : t("svnWorkspace.checkout.start")}
          </Button>
        </div>

        {busy ? (
          <div className="text-muted-foreground flex items-center gap-2 text-xs" role="status">
            <span className="inline-block size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
            {t("svnWorkspace.checkout.checkingOut")}
          </div>
        ) : null}

        {output ? (
          <div className="border-border bg-muted/30 rounded-md border">
            <div className="border-border/60 text-muted-foreground border-b px-2 py-1 text-[11px] font-medium">
              {t("svnWorkspace.checkout.output")}
            </div>
            <pre className="max-h-56 overflow-auto px-2 py-1.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
              {output}
            </pre>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default CheckoutPanel;
