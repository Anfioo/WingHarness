import { useCallback, useEffect, useMemo, useState } from "react";
import { open as pickFile } from "@tauri-apps/plugin-dialog";
import { Eye, EyeOff, Loader2, Plus, Trash2 } from "lucide-react";
import type { ScoopShim } from "@/commands";
import { scoopShimAdd, scoopShimRemove, scoopShimToggle, scoopShims } from "@/commands";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
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
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { messageOf } from "@/lib/scoop/diagnostics";

/**
 * The launchers in `shims`, local and global.
 *
 * Every action is a file operation: hiding renames the launcher, deleting
 * removes the files that belong to the name, and adding writes the `.shim` file
 * next to a copy of Scoop's own `shim.exe`.
 */
export function ScoopShimManager() {
  const { t } = useAppTranslation();
  const [shims, setShims] = useState<ScoopShim[] | null>(null);
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    try {
      setShims(await scoopShims());
      setError(null);
    } catch (failure) {
      setError(messageOf(failure));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const run = useCallback(async (action: () => Promise<ScoopShim[]>) => {
    setBusy(true);
    try {
      setShims(await action());
      setError(null);
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      setBusy(false);
    }
  }, []);

  const rows = useMemo(() => {
    const list = shims ?? [];
    const needle = filter.trim().toLowerCase();
    if (!needle) return list;
    return list.filter((shim) =>
      `${shim.name} ${shim.target} ${shim.app ?? ""}`.toLowerCase().includes(needle)
    );
  }, [shims, filter]);

  return (
    <section className="border-border flex min-h-0 flex-col gap-3 rounded-xl border p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold">{t("scoop.diagnostics.shims.title")}</h2>
          <p className="text-muted-foreground mt-1 text-xs">
            {t("scoop.diagnostics.shims.hint", { count: shims?.length ?? 0 })}
          </p>
        </div>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => setAdding(true)}>
          <Plus />
          {t("scoop.diagnostics.shims.add")}
        </Button>
      </div>

      {error && <p className="text-destructive text-xs">{error}</p>}

      <Input
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
        placeholder={t("scoop.diagnostics.shims.filter")}
        className="h-8"
      />

      <div className="border-border max-h-96 min-h-0 overflow-auto rounded-lg border">
        {rows.length === 0 ? (
          <p className="text-muted-foreground px-3 py-6 text-center text-xs">
            {shims?.length
              ? t("scoop.diagnostics.shims.noMatches")
              : t("scoop.diagnostics.shims.empty")}
          </p>
        ) : (
          <ul className="divide-border divide-y">
            {rows.map((shim) => (
              <li
                key={`${shim.global ? "g" : "s"}-${shim.name}`}
                className="flex items-center gap-2 px-3 py-2"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-sm font-medium">{shim.name}</span>
                    {shim.app ? (
                      <Badge variant="secondary">{shim.app}</Badge>
                    ) : (
                      <Badge variant="outline">{t("scoop.diagnostics.shims.custom")}</Badge>
                    )}
                    {shim.global && (
                      <Badge variant="outline">{t("scoop.diagnostics.shims.globalBadge")}</Badge>
                    )}
                    {shim.hidden && (
                      <Badge variant="secondary">{t("scoop.diagnostics.shims.hiddenBadge")}</Badge>
                    )}
                  </div>
                  <p className="text-muted-foreground mt-0.5 truncate font-mono text-[11px]">
                    {shim.target}
                    {shim.args ? ` ${shim.args}` : ""}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  disabled={busy}
                  title={
                    shim.hidden
                      ? t("scoop.diagnostics.shims.showTitle", { name: shim.name })
                      : t("scoop.diagnostics.shims.hideTitle", { name: shim.name })
                  }
                  aria-label={t("scoop.diagnostics.shims.hide")}
                  onClick={() => void run(() => scoopShimToggle(shim.name))}
                >
                  {shim.hidden ? <EyeOff /> : <Eye />}
                </Button>
                <RemoveShimButton
                  shim={shim.name}
                  disabled={busy}
                  onConfirm={() => run(() => scoopShimRemove(shim.name))}
                />
              </li>
            ))}
          </ul>
        )}
      </div>

      {adding && (
        <AddShimDialog
          onClose={() => setAdding(false)}
          onAdded={(next) => {
            setShims(next);
            setError(null);
          }}
        />
      )}
    </section>
  );
}

/** Deleting a shim removes every file of that name; the confirmation says so. */
function RemoveShimButton({
  shim,
  disabled,
  onConfirm,
}: {
  shim: string;
  disabled: boolean;
  onConfirm: () => Promise<void>;
}) {
  const { t } = useAppTranslation();

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={disabled}
          title={t("scoop.diagnostics.shims.removeTitle", { name: shim })}
          aria-label={t("scoop.diagnostics.shims.removeTitle", { name: shim })}
          className="hover:bg-destructive/10 hover:text-destructive"
        >
          <Trash2 />
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t("scoop.diagnostics.shims.removeDialogTitle", { name: shim })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t("scoop.diagnostics.shims.removeDialogBody", { name: shim })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("scoop.diagnostics.shims.removeCancel")}</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            onClick={() => void onConfirm()}
          >
            {t("scoop.diagnostics.shims.removeConfirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** A shim for a file of the user's choosing, in either shims folder. */
function AddShimDialog({
  onClose,
  onAdded,
}: {
  onClose: () => void;
  onAdded: (shims: ScoopShim[]) => void;
}) {
  const { t } = useAppTranslation();
  const [name, setName] = useState("");
  const [target, setTarget] = useState("");
  const [args, setArgs] = useState("");
  const [global, setGlobal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const browse = async () => {
    const picked = await pickFile({ multiple: false, directory: false });
    if (typeof picked === "string") setTarget(picked);
  };

  const submit = async () => {
    setBusy(true);
    try {
      onAdded(
        await scoopShimAdd({
          name: name.trim(),
          target: target.trim(),
          args: args.trim() || null,
          global,
        })
      );
      onClose();
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>{t("scoop.diagnostics.shims.addTitle")}</DialogTitle>
          <DialogDescription>{t("scoop.diagnostics.shims.addHint")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="shim-name">{t("scoop.diagnostics.shims.name")}</Label>
            <Input
              id="shim-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={t("scoop.diagnostics.shims.namePlaceholder")}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="shim-target">{t("scoop.diagnostics.shims.target")}</Label>
            <div className="flex gap-2">
              <Input
                id="shim-target"
                value={target}
                onChange={(event) => setTarget(event.target.value)}
                placeholder={t("scoop.diagnostics.shims.targetPlaceholder")}
                className="font-mono text-xs"
              />
              <Button variant="outline" onClick={() => void browse()}>
                {t("scoop.diagnostics.shims.browse")}
              </Button>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="shim-args">{t("scoop.diagnostics.shims.args")}</Label>
            <Input
              id="shim-args"
              value={args}
              onChange={(event) => setArgs(event.target.value)}
              placeholder={t("scoop.diagnostics.shims.argsPlaceholder")}
              className="font-mono text-xs"
            />
          </div>

          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium">{t("scoop.diagnostics.shims.global")}</p>
              <p className="text-muted-foreground text-xs">
                {t("scoop.diagnostics.shims.globalHint")}
              </p>
            </div>
            <Switch checked={global} onCheckedChange={setGlobal} />
          </div>

          {error && <p className="text-destructive text-xs">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("scoop.diagnostics.shims.addCancel")}
          </Button>
          <Button disabled={busy || !name.trim() || !target.trim()} onClick={() => void submit()}>
            {busy && <Loader2 className="animate-spin" />}
            {t("scoop.diagnostics.shims.addConfirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
