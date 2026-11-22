// The right column of the tools tab: one tool's versions and actions.
//
// The component never runs anything itself. Every button assembles an
// `ActionPreviewRequest` and hands it to the tab, which opens the shared preview
// dialog first.

import { Loader2, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";

import type {
  MiseErrorCode,
  MiseInstalledVersion,
  MiseRemoteVersion,
  MiseTool,
  MiseToolAction,
  MiseToolActionKind,
} from "@/commands";
import { NoticeList } from "@/components/mise/notice-list";
import { StatusBadge } from "@/components/mise/status-badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useAppTranslation } from "@/hooks/use-app-translation";
import type { MiseActionRequest } from "@/hooks/use-mise-tools";
import {
  affectedFilesForScript,
  installAndUseScript,
  uninstallVersionScript,
  useScript,
} from "@/lib/mise/commands";
import { miseErrorKey } from "@/lib/mise/error-key";
import { formatTimestamp, impactReasonKey, sourceKey } from "@/lib/mise/format";
import { cn } from "@/lib/utils";

export type ToolDetailProps = {
  tool: MiseTool | null;
  loading: boolean;
  error: MiseErrorCode | null;
  onCancel: () => void;
  onRetry: () => void;
  onPreviewAction: (request: MiseActionRequest) => void;
};

const KIND_LABEL_KEY: Record<MiseToolActionKind, string> = {
  upgrade: "mise.tools.action.upgrade",
  "inspect-source": "mise.tools.action.inspectSource",
  "show-current": "mise.tools.action.showCurrent",
};

const CARD_CLASS = "border-border bg-card flex min-h-0 flex-col overflow-y-auto rounded-xl border";

function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="border-border border-t px-4 py-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function Field({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-muted-foreground text-xs">{label}</span>
      <span className="min-w-0 font-mono text-xs break-all select-text">{value}</span>
    </div>
  );
}

function SkeletonCard({ title, onCancel }: { title: string; onCancel: () => void }) {
  const { t } = useAppTranslation();

  return (
    <section className={CARD_CLASS}>
      <header className="border-border border-b px-4 py-3">
        <h2 className="text-sm font-medium">{title}</h2>
      </header>
      <div className="flex flex-col gap-3 p-4">
        <Skeleton className="h-5 w-48" />
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-2/3" />
        <Skeleton className="h-24 w-full" />
        <Button variant="outline" size="sm" className="w-fit" onClick={onCancel}>
          {t("mise.tools.cancel")}
        </Button>
      </div>
    </section>
  );
}

function ErrorCard({
  title,
  error,
  onRetry,
}: {
  title: string;
  error: MiseErrorCode;
  onRetry: () => void;
}) {
  const { t } = useAppTranslation();

  return (
    <section className={CARD_CLASS}>
      <header className="border-border border-b px-4 py-3">
        <h2 className="text-sm font-medium">{title}</h2>
      </header>
      <div className="text-destructive flex flex-col gap-3 p-4 text-sm">
        <span className="break-words">{t(miseErrorKey(error))}</span>
        <Button variant="outline" size="sm" className="w-fit" onClick={onRetry}>
          {t("mise.tools.retry")}
        </Button>
      </div>
    </section>
  );
}

export function ToolDetail({
  tool,
  loading,
  error,
  onCancel,
  onRetry,
  onPreviewAction,
}: ToolDetailProps) {
  const { t, language } = useAppTranslation();
  const detailTitle = t("mise.tools.detailTitle");
  const unknown = t("mise.common.unknown");

  if (loading && !tool) return <SkeletonCard title={detailTitle} onCancel={onCancel} />;
  if (error && !tool) return <ErrorCard title={detailTitle} error={error} onRetry={onRetry} />;
  if (!tool) {
    return (
      <section className={CARD_CLASS}>
        <header className="border-border border-b px-4 py-3">
          <h2 className="text-sm font-medium">{detailTitle}</h2>
        </header>
        <div className="text-muted-foreground flex flex-1 items-center justify-center p-6 text-sm">
          {t("mise.tools.selectHint")}
        </div>
      </section>
    );
  }

  const globalConfigPath =
    tool.sourceKind === "global" ? (tool.sourcePath ?? undefined) : undefined;
  const installedVersions = new Set(tool.installedVersions.map((version) => version.version));
  const recommendedVersion = tool.updateVersion;

  const switchInstalledVersion = (version: MiseInstalledVersion) => {
    // `useScript` is the mise command builder, not a React hook.
    // eslint-disable-next-line react-hooks/rules-of-hooks
    const script = useScript(tool.id, version.version, version.sourceKind);
    onPreviewAction({
      title: `${t("mise.tools.action.use")} ${tool.id}@${version.version}`,
      summary: t("mise.tools.action.use"),
      command: script,
      level: "info",
      affectedFiles: affectedFilesForScript(script, globalConfigPath),
      confirmLabel: t("mise.tools.action.use"),
    });
  };

  const uninstallVersion = (version: MiseInstalledVersion) => {
    const script = uninstallVersionScript(tool.id, version.version);
    onPreviewAction({
      title: `${t("mise.tools.uninstall.title")} ${tool.id}@${version.version}`,
      summary: t("mise.tools.uninstall.versionDescription", {
        tool: tool.id,
        version: version.version,
      }),
      command: script,
      level: "warning",
      affectedFiles: affectedFilesForScript(script, globalConfigPath),
      confirmLabel: t("mise.tools.uninstall.confirm"),
    });
  };

  const installRemote = (version: MiseRemoteVersion) => {
    const isUpgrade = version.version === recommendedVersion;
    const script = installAndUseScript(tool.id, version.version, tool.sourceKind);
    onPreviewAction({
      title: `${t(isUpgrade ? "mise.tools.action.upgrade" : "mise.tools.action.install")} ${
        tool.id
      }@${version.version}`,
      summary: isUpgrade
        ? t("mise.tools.fields.updateAvailable", { version: version.version })
        : t("mise.tools.action.install"),
      command: script,
      level: isUpgrade ? "healthy" : "info",
      affectedFiles: affectedFilesForScript(script, globalConfigPath),
      confirmLabel: t(isUpgrade ? "mise.tools.action.upgrade" : "mise.tools.action.install"),
    });
  };

  const runQuickAction = (action: MiseToolAction) => {
    const label = t(KIND_LABEL_KEY[action.kind]);
    const version = action.version ?? tool.updateVersion;
    onPreviewAction({
      title: `${label} ${tool.id}`,
      summary:
        action.kind === "upgrade" && version
          ? t("mise.tools.fields.updateAvailable", { version })
          : label,
      command: action.command,
      level: action.level,
      affectedFiles: affectedFilesForScript(action.command, globalConfigPath),
      confirmLabel: label,
    });
  };

  const channelLabel = (version: MiseRemoteVersion) => {
    if (version.rolling) return t("mise.tools.channel.rolling");
    if (version.version === tool.latestPreviewVersion) return t("mise.tools.channel.preview");
    return t("mise.tools.channel.stable");
  };

  const createdAtLabel = (version: MiseRemoteVersion) => {
    if (!version.createdAt) return null;
    const parsed = new Date(version.createdAt);
    const text = Number.isNaN(parsed.getTime())
      ? version.createdAt
      : formatTimestamp(parsed.getTime(), language);
    return t("mise.tools.channel.createdAt", { date: text });
  };

  const remoteStateLabel =
    tool.remoteState === "pending"
      ? t("mise.tools.state.remotePending")
      : tool.remoteState === "unavailable"
        ? t("mise.tools.state.remoteUnavailable")
        : t("mise.tools.state.remoteReady");

  return (
    <section className={CARD_CLASS}>
      <header className="border-border border-b px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-base font-semibold break-words">{tool.name || tool.id}</h2>
          {tool.name !== tool.id && (
            <span className="text-muted-foreground font-mono text-xs">{tool.id}</span>
          )}
          <StatusBadge level={tool.level} />
          {loading && (
            <Loader2
              className="text-muted-foreground size-3.5 animate-spin"
              aria-label={t("mise.tools.loading")}
            />
          )}
          <Button
            variant="ghost"
            size="icon-xs"
            className="ml-auto"
            aria-label={t("mise.actions.refresh")}
            title={t("mise.actions.refresh")}
            disabled={loading}
            onClick={onRetry}
          >
            <RefreshCw className={loading ? "animate-spin" : undefined} />
          </Button>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Field label={t("mise.tools.activeVersion")} value={tool.activeVersion || unknown} />
          <Field
            label={t("mise.tools.requestedVersion")}
            value={tool.requestedVersion || unknown}
          />
          <Field label={t("mise.tools.source.title")} value={t(sourceKey(tool.sourceKind))} />
          <Field
            label={t("mise.tools.source.path")}
            value={tool.sourcePath ?? t("mise.common.notSet")}
          />
        </div>
      </header>

      <Section title={t("mise.tools.commandPreview")}>
        <pre className="bg-muted overflow-x-auto rounded-md p-2.5 font-mono text-xs leading-relaxed break-all whitespace-pre-wrap select-text">
          {tool.commandPreview || t("mise.common.empty")}
        </pre>
      </Section>

      <Section title={t("mise.tools.fields.installedVersions")}>
        {tool.installedVersions.length === 0 ? (
          <p className="text-muted-foreground text-xs">{t("mise.tools.fields.notInstalled")}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-xs">
              <thead className="text-muted-foreground">
                <tr>
                  <th className="py-1 pr-3 font-medium" />
                  <th className="py-1 pr-3 font-medium">{t("mise.tools.source.title")}</th>
                  <th className="py-1 pr-3 font-medium">{t("mise.tools.requestedVersion")}</th>
                  <th className="py-1 text-right font-medium">{t("mise.tools.action.title")}</th>
                </tr>
              </thead>
              <tbody>
                {tool.installedVersions.map((version) => (
                  <tr
                    key={version.version}
                    className={cn(
                      "border-border border-t align-top",
                      version.active && "bg-emerald-500/5"
                    )}
                  >
                    <td className="py-2 pr-3">
                      <span className="font-mono break-all">{version.version}</span>
                      {version.installPath && (
                        <p className="text-muted-foreground mt-0.5 font-mono text-[11px] break-all">
                          {version.installPath}
                        </p>
                      )}
                    </td>
                    <td className="py-2 pr-3">
                      <span>{t(sourceKey(version.sourceKind))}</span>
                      {version.sourcePath && (
                        <p className="text-muted-foreground mt-0.5 font-mono text-[11px] break-all">
                          {version.sourcePath}
                        </p>
                      )}
                    </td>
                    <td className="py-2 pr-3 font-mono">{version.requestedVersion ?? "—"}</td>
                    <td className="py-2">
                      <div className="flex flex-wrap items-center justify-end gap-1">
                        {version.active ? (
                          <StatusBadge level="healthy" label={t("mise.tools.state.active")} />
                        ) : (
                          version.installed && (
                            <Button
                              variant="outline"
                              size="xs"
                              onClick={() => switchInstalledVersion(version)}
                            >
                              {t("mise.tools.action.use")}
                            </Button>
                          )
                        )}
                        {version.installed && (
                          <Button
                            variant="ghost"
                            size="xs"
                            onClick={() => uninstallVersion(version)}
                          >
                            {t("mise.tools.action.uninstallVersion")}
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section
        title={t("mise.tools.fields.remoteVersions")}
        action={<span className="text-muted-foreground text-xs">{remoteStateLabel}</span>}
      >
        {tool.remoteState === "pending" ? (
          <div className="flex flex-col gap-1.5">
            <Skeleton className="h-3 w-2/3" />
            <Skeleton className="h-3 w-1/2" />
          </div>
        ) : tool.remoteState === "unavailable" ? (
          <p className="text-muted-foreground text-xs">{t("mise.tools.state.remoteUnavailable")}</p>
        ) : tool.remoteVersions.length === 0 ? (
          <p className="text-muted-foreground text-xs">{t("mise.common.empty")}</p>
        ) : (
          <ul className="flex flex-col">
            {tool.remoteVersions.map((version) => {
              const recommended = version.version === recommendedVersion;
              const installed = installedVersions.has(version.version);
              const created = createdAtLabel(version);
              return (
                <li
                  key={version.version}
                  className={cn(
                    "border-border flex flex-wrap items-center justify-between gap-2 border-t py-2 first:border-t-0",
                    recommended && "bg-emerald-500/5"
                  )}
                >
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-mono text-xs break-all">{version.version}</span>
                      <span className="text-muted-foreground text-[11px]">
                        {channelLabel(version)}
                      </span>
                      {recommended && (
                        <StatusBadge level="healthy" label={t("mise.tools.action.upgrade")} />
                      )}
                    </div>
                    {created && (
                      <span className="text-muted-foreground text-[11px]">{created}</span>
                    )}
                  </div>
                  {installed ? (
                    <StatusBadge level="info" label={t("mise.tools.state.installed")} />
                  ) : (
                    <Button
                      variant={recommended ? "default" : "outline"}
                      size="xs"
                      onClick={() => installRemote(version)}
                    >
                      {t(recommended ? "mise.tools.action.upgrade" : "mise.tools.action.install")}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      <Section
        title={t("mise.tools.impact.title")}
        action={
          tool.projectImpacts.length > 0 && (
            <span className="text-muted-foreground text-xs">
              {t("mise.tools.impact.count", { count: tool.projectImpacts.length })}
            </span>
          )
        }
      >
        {tool.projectImpacts.length === 0 ? (
          <p className="text-muted-foreground text-xs">{t("mise.tools.impact.empty")}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-xs">
              <thead className="text-muted-foreground">
                <tr>
                  <th className="py-1 pr-3 font-medium">{t("mise.tools.impact.project")}</th>
                  <th className="py-1 pr-3 font-medium">{t("mise.tools.impact.path")}</th>
                  <th className="py-1 pr-3 font-medium">{t("mise.tools.impact.requested")}</th>
                  <th className="py-1 pr-3 font-medium">{t("mise.tools.impact.resolved")}</th>
                </tr>
              </thead>
              <tbody>
                {tool.projectImpacts.map((impact) => (
                  <tr
                    key={`${impact.path}-${impact.projectName}`}
                    className="border-border border-t"
                  >
                    <td className="py-2 pr-3">
                      <span className="font-medium">{impact.projectName}</span>
                      <p className="text-muted-foreground mt-0.5 text-[11px]">
                        {t(impactReasonKey(impact.reason))}
                      </p>
                    </td>
                    <td className="text-muted-foreground py-2 pr-3 font-mono break-all">
                      {impact.path}
                    </td>
                    <td className="py-2 pr-3 font-mono">{impact.requestedVersion}</td>
                    <td className="py-2 pr-3 font-mono">{impact.resolvedVersion}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {tool.notices.length > 0 && (
        <Section title={t("mise.tools.notice.title")}>
          <NoticeList notices={tool.notices} />
        </Section>
      )}

      {tool.quickActions.length > 0 && (
        <Section title={t("mise.tools.action.title")}>
          <div className="flex flex-wrap gap-2">
            {tool.quickActions.map((action) => (
              <Button
                key={`${action.kind}-${action.command}`}
                variant="outline"
                size="sm"
                onClick={() => runQuickAction(action)}
              >
                {t(KIND_LABEL_KEY[action.kind])}
              </Button>
            ))}
          </div>
        </Section>
      )}
    </section>
  );
}
