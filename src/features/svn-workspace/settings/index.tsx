import { useEffect, useState, type ComponentType, type ReactNode } from "react";
import { open as pickFile } from "@tauri-apps/plugin-dialog";
import {
  Eraser,
  FileText,
  FolderOpen,
  HardDrive,
  Loader2,
  RotateCcw,
  Terminal,
  User,
  Wrench,
} from "lucide-react";
import { toast } from "sonner";
import { configureSvnExecutable, svnCleanup, svnCurrentUser } from "@/commands";
import type { SvnAuthUser } from "@/lib/svn-core/types";
import { confirmDialog } from "@/components/confirm";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useSvnSettings } from "@/features/svn-workspace/settings";
import { useSvnWorkspaceStore } from "@/features/svn-workspace/store";
import { useSvnWorkspace } from "@/features/svn-workspace/use-workspace";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { cn } from "@/lib/utils";

const ENCODINGS = ["utf-8", "gbk", "gb2312"] as const;

function Card({
  title,
  icon: Icon,
  description,
  action,
  children,
}: {
  title: string;
  icon: ComponentType<{ className?: string }>;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="border-border bg-card rounded-lg border">
      <header className="border-border flex items-center gap-2 border-b px-4 py-3">
        <Icon className="text-muted-foreground size-4" />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-medium">{title}</h3>
          {description ? (
            <p className="text-muted-foreground mt-0.5 text-xs">{description}</p>
          ) : null}
        </div>
        {action}
      </header>
      <div className="divide-border flex flex-col divide-y">{children}</div>
    </section>
  );
}

function Row({ label, hint, control }: { label: string; hint?: string; control: ReactNode }) {
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="text-sm">{label}</div>
        {hint ? <p className="text-muted-foreground mt-0.5 text-xs">{hint}</p> : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">{control}</div>
    </div>
  );
}

function PathRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <span className="text-muted-foreground w-32 shrink-0 text-sm">{label}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-xs" title={value}>
        {value || "—"}
      </span>
    </div>
  );
}

/**
 * The settings panel: the `svn` binary, output encoding, log page size and the
 * `.gitignore` filter, plus the working copy's own facts and a cleanup action.
 *
 * Everything is written through `useSvnSettings`, so it lands in the SVN data
 * directory rather than localStorage. The reference also kept theme and
 * language here; both are app-wide concerns this project already owns, so they
 * are deliberately absent.
 */
export function SettingsPanel() {
  const { t } = useAppTranslation();
  const workspacePath = useSvnWorkspaceStore((s) => s.workspacePath);
  const svnInfo = useSvnWorkspaceStore((s) => s.svnInfo);
  const { settings, updateSettings, resetSettings } = useSvnSettings();
  const { refreshStatusAfterMutation } = useSvnWorkspace();

  const [testing, setTesting] = useState(false);
  const [cleanupBusy, setCleanupBusy] = useState(false);
  const [user, setUser] = useState<SvnAuthUser | null>(null);

  useEffect(() => {
    if (!workspacePath) {
      setUser(null);
      return;
    }
    let cancelled = false;
    void svnCurrentUser(workspacePath)
      .then((current) => {
        if (!cancelled) setUser(current);
      })
      .catch(() => {
        if (!cancelled) setUser(null);
      });
    return () => {
      cancelled = true;
    };
  }, [workspacePath]);

  const testExecutable = async (executable = settings.svnPath) => {
    setTesting(true);
    try {
      const version = await configureSvnExecutable(executable);
      toast.success(t("svnWorkspace.settings.svnPathApplied", { version }));
    } catch (error) {
      toast.error(t("svnWorkspace.settings.svnPathInvalid", { error: String(error) }));
    } finally {
      setTesting(false);
    }
  };

  const pickExecutable = async () => {
    const picked = await pickFile({
      multiple: false,
      title: t("svnWorkspace.settings.svnPath"),
    });
    if (typeof picked !== "string") return;
    updateSettings({ svnPath: picked });
    await testExecutable(picked);
  };

  const onGitignoreChange = (on: boolean) => {
    updateSettings({ gitignoreEnabled: on });
    // Turning the filter on or off changes which unversioned files are shown.
    void refreshStatusAfterMutation();
  };

  const cleanup = async () => {
    if (!workspacePath) return;
    setCleanupBusy(true);
    try {
      const result = await svnCleanup(workspacePath);
      if (!result.success) throw new Error(result.error || result.output);
      await refreshStatusAfterMutation();
      toast.success(t("svnWorkspace.settings.cleanupDone"));
    } catch (error) {
      toast.error(t("svnWorkspace.settings.cleanupFailed", { error: String(error) }));
    } finally {
      setCleanupBusy(false);
    }
  };

  const reset = async () => {
    const confirmed = await confirmDialog({
      title: t("svnWorkspace.settings.reset"),
      description: t("svnWorkspace.settings.resetConfirm"),
      confirmLabel: t("svnWorkspace.settings.reset"),
      destructive: true,
    });
    if (!confirmed) return;
    resetSettings();
    toast.success(t("svnWorkspace.settings.resetDone"));
  };

  const logLimitValue = Number.isFinite(settings.logLimit) ? settings.logLimit : 50;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4">
      <div className="flex flex-col gap-4">
        <Card
          title={t("svnWorkspace.settings.svnSection")}
          icon={Wrench}
          description={t("svnWorkspace.settings.svnSectionHint")}
        >
          <div className="flex flex-col gap-2 px-4 py-3">
            <label htmlFor="svn-path" className="text-sm">
              {t("svnWorkspace.settings.svnPath")}
            </label>
            <div className="flex items-center gap-2">
              <Input
                id="svn-path"
                value={settings.svnPath}
                onChange={(event) => updateSettings({ svnPath: event.target.value })}
                placeholder={t("svnWorkspace.settings.svnPathPlaceholder")}
                className="font-mono text-xs"
              />
              <Button variant="secondary" size="sm" onClick={() => void pickExecutable()}>
                <FolderOpen className="size-3.5" />
                {t("svnWorkspace.settings.browse")}
              </Button>
              <Button size="sm" disabled={testing} onClick={() => void testExecutable()}>
                {testing ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Terminal className="size-3.5" />
                )}
                {t("svnWorkspace.settings.test")}
              </Button>
            </div>
          </div>

          <Row
            label={t("svnWorkspace.settings.encoding")}
            hint={t("svnWorkspace.settings.encodingHint")}
            control={
              <Select
                value={settings.encoding}
                onValueChange={(value) => updateSettings({ encoding: value })}
              >
                <SelectTrigger size="sm" className="w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ENCODINGS.map((encoding) => (
                    <SelectItem key={encoding} value={encoding}>
                      {encoding.toUpperCase()}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            }
          />

          <Row
            label={t("svnWorkspace.settings.logLimit")}
            hint={t("svnWorkspace.settings.logLimitHint")}
            control={
              <Input
                type="number"
                min={1}
                value={String(logLimitValue)}
                onChange={(event) => {
                  const next = Number.parseInt(event.target.value, 10);
                  updateSettings({ logLimit: Number.isFinite(next) && next > 0 ? next : 1 });
                }}
                className="w-24 text-right"
                aria-label={t("svnWorkspace.settings.logLimit")}
              />
            }
          />

          <Row
            label={t("svnWorkspace.settings.gitignore")}
            hint={t("svnWorkspace.settings.gitignoreHint")}
            control={
              <Switch
                checked={settings.gitignoreEnabled}
                onCheckedChange={onGitignoreChange}
                aria-label={t("svnWorkspace.settings.gitignore")}
              />
            }
          />
        </Card>

        <Card title={t("svnWorkspace.settings.workspaceSection")} icon={HardDrive}>
          {!workspacePath ? (
            <p className="text-muted-foreground px-4 py-3 text-xs">
              {t("svnWorkspace.common.noWorkspace")}
            </p>
          ) : (
            <>
              <PathRow label={t("svnWorkspace.settings.path")} value={workspacePath} />
              <PathRow label={t("svnWorkspace.settings.url")} value={svnInfo?.url ?? ""} />
              <PathRow
                label={t("svnWorkspace.settings.repositoryRoot")}
                value={svnInfo?.repositoryRoot ?? ""}
              />
              <div className="flex items-center gap-3 px-4 py-3">
                <span className="text-muted-foreground w-32 shrink-0 text-sm">
                  {t("svnWorkspace.settings.revision")}
                </span>
                <span className="min-w-0 flex-1 font-mono text-xs">
                  {svnInfo ? `r${svnInfo.revision}` : "—"}
                </span>
                <span className="text-muted-foreground text-xs">
                  {t("svnWorkspace.settings.nodeKind")}
                </span>
                <span className="font-mono text-xs capitalize">{svnInfo?.nodeKind ?? "—"}</span>
                <span className="text-muted-foreground text-xs">
                  {t("svnWorkspace.settings.schedule")}
                </span>
                <span className="font-mono text-xs capitalize">{svnInfo?.schedule ?? "—"}</span>
              </div>
              <Row
                label={t("svnWorkspace.settings.user")}
                hint={t("svnWorkspace.settings.userHint")}
                control={
                  <span className="flex items-center gap-1.5 font-mono text-xs">
                    <User className="text-muted-foreground size-3.5" />
                    {user ? (
                      <span className="min-w-0 truncate">
                        {user.username}
                        {user.realm ? (
                          <span className="text-muted-foreground"> · {user.realm}</span>
                        ) : null}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">
                        {t("svnWorkspace.settings.noUser")}
                      </span>
                    )}
                  </span>
                }
              />
            </>
          )}
        </Card>

        <Card
          title={t("svnWorkspace.settings.maintenance")}
          icon={Eraser}
          description={t("svnWorkspace.settings.maintenanceHint")}
        >
          <Row
            label={t("svnWorkspace.settings.cleanup")}
            hint={t("svnWorkspace.settings.cleanupHint")}
            control={
              <Button
                variant="secondary"
                size="sm"
                disabled={!workspacePath || cleanupBusy}
                onClick={() => void cleanup()}
              >
                {cleanupBusy ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Eraser className="size-3.5" />
                )}
                {t("svnWorkspace.settings.cleanup")}
              </Button>
            }
          />
          <Row
            label={t("svnWorkspace.settings.reset")}
            hint={t("svnWorkspace.settings.resetHint")}
            control={
              <Button variant="ghost" size="sm" onClick={() => void reset()}>
                <RotateCcw className="size-3.5" />
                {t("svnWorkspace.settings.reset")}
              </Button>
            }
          />
        </Card>

        <p className={cn("text-muted-foreground flex items-center gap-1.5 px-1 text-[11px]")}>
          <FileText className="size-3" />
          {t("svnWorkspace.settings.footer")}
        </p>
      </div>
    </div>
  );
}

export default SettingsPanel;
