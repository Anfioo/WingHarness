import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { open as pickDirectory } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { FolderOpen, Loader2 } from "lucide-react";
import { repoClone } from "@/commands";
import { useAppTranslation } from "@/hooks/use-app-translation";
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
import { useUi, type ClonePreset, type DialogContext } from "@/features/git/ui-store";
import { useRepositoryPrefs } from "./store";

function clonePreset(context: DialogContext): ClonePreset | null {
  if (!context || typeof context === "string" || !("url" in context) || !("into" in context)) {
    return null;
  }
  return context as ClonePreset;
}

export function CloneDialog({ onCloned }: { onCloned: (path: string) => void }) {
  const { t } = useAppTranslation();
  const dialog = useUi((state) => state.dialog);
  const dialogContext = useUi((state) => state.dialogContext);
  const closeDialog = useUi((state) => state.closeDialog);
  const cloneRoot = useRepositoryPrefs((state) => state.cloneRoot);
  const setCloneRoot = useRepositoryPrefs((state) => state.setCloneRoot);
  const open = dialog === "clone";
  const [url, setUrl] = useState("");
  const [into, setInto] = useState("");
  const [branch, setBranch] = useState("");
  const [progress, setProgress] = useState<number | null>(null);

  useEffect(() => {
    if (!open) {
      setUrl("");
      setInto("");
      setBranch("");
      setProgress(null);
      return;
    }
    const preset = clonePreset(dialogContext);
    if (preset) {
      setUrl(preset.url);
      setInto(preset.into || cloneRoot || "");
      setBranch(preset.branch ?? "");
    } else if (cloneRoot) {
      setInto(cloneRoot);
    }
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void listen<number>("clone-progress", (event) => setProgress(event.payload)).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [open, dialogContext, cloneRoot]);

  const clone = async () => {
    if (progress !== null || !url.trim() || !into.trim()) return;
    setProgress(0);
    try {
      const name =
        url
          .trim()
          .replace(/\.git$/, "")
          .split("/")
          .pop() ?? "repository";
      const target = `${into.replace(/[\\/]$/, "")}/${name}`;
      const path = await repoClone(url.trim(), target, branch.trim() || undefined);
      setCloneRoot(into.trim().replace(/[\\/]$/, ""));
      toast.success(t("gitRepo.remote.clone.success"));
      closeDialog();
      onCloned(path);
    } catch (error) {
      toast.error(
        t("gitRepo.remote.clone.failed", {
          error: (error as { message?: string })?.message ?? String(error),
        })
      );
      setProgress(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(value) => !value && closeDialog()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("gitRepo.remote.clone.title")}</DialogTitle>
          <DialogDescription>{t("gitRepo.remote.clone.description")}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <Input
            autoFocus
            placeholder="git@github.com:user/repo.git"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void clone();
            }}
          />
          <Input
            placeholder={t("gitRepo.remote.clone.branchPlaceholder")}
            value={branch}
            onChange={(event) => setBranch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void clone();
            }}
          />
          <div className="flex gap-2">
            <Input
              placeholder={t("gitRepo.remote.clone.destinationPlaceholder")}
              value={into}
              onChange={(event) => setInto(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void clone();
              }}
            />
            <Button
              variant="secondary"
              size="icon"
              aria-label={t("gitRepo.remote.clone.browse")}
              onClick={async () => {
                const dir = await pickDirectory({
                  directory: true,
                  title: t("gitRepo.remote.clone.chooseDestination"),
                });
                if (typeof dir === "string") setInto(dir);
              }}
            >
              <FolderOpen />
            </Button>
          </div>
          {progress !== null && (
            <div className="flex flex-col gap-1">
              <div className="bg-muted h-1.5 overflow-hidden rounded-full">
                <div
                  className={`bg-primary h-full rounded-full transition-[width] duration-300 ${
                    progress === 0 ? "animate-pulse" : ""
                  }`}
                  style={{ width: `${Math.max(4, progress)}%` }}
                />
              </div>
              <span className="text-muted-foreground text-xs">
                {progress === 0
                  ? t("gitRepo.remote.clone.connecting")
                  : t("gitRepo.remote.clone.progress", { percent: Math.round(progress) })}
              </span>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={closeDialog}>
            {t("gitRepo.remote.clone.cancel")}
          </Button>
          <Button
            onClick={() => void clone()}
            disabled={progress !== null || !url.trim() || !into.trim()}
          >
            {progress !== null ? <Loader2 className="animate-spin" /> : null}
            {t("gitRepo.remote.clone.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
