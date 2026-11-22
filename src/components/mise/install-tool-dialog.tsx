// The install-tool dialog: a tool name and version, optionally picked from the
// selected tool's remote versions or searched live against the registry. It
// only builds the script and hands it to the shared action preview; nothing
// runs here.

import { useEffect, useMemo, useRef, useState } from "react";

import { miseRemoteVersions, type MiseRemoteVersion } from "@/commands";
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
import { useAppTranslation } from "@/hooks/use-app-translation";
import type { MiseActionRequest } from "@/hooks/use-mise-tools";
import { affectedFilesForScript, installAndUseScript, parseToolVersion } from "@/lib/mise/commands";

export type InstallToolDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Remote versions of the selected tool, offered as quick picks. */
  suggestions?: { tool: string; versions: MiseRemoteVersion[] } | null;
  onPreview: (request: MiseActionRequest) => void;
};

/** A registry can list thousands of versions; render this many at most. */
const MAX_VISIBLE_VERSIONS = 200;

/**
 * Fetch the whole registry list, not a newest-first slice: Java alone lists
 * over four thousand versions, and filtering for an old major such as `8`
 * only works when the list still contains them.
 */
const REMOTE_LIST_LIMIT = 10_000;

export function InstallToolDialog({
  open,
  onOpenChange,
  suggestions,
  onPreview,
}: InstallToolDialogProps) {
  const { t } = useAppTranslation();
  const [tool, setTool] = useState("");
  const [version, setVersion] = useState("");
  const [invalid, setInvalid] = useState(false);
  const [remotes, setRemotes] = useState<MiseRemoteVersion[]>([]);
  const [remoteTool, setRemoteTool] = useState<string | null>(null);
  const [remoteLoading, setRemoteLoading] = useState(false);
  const [remoteFailed, setRemoteFailed] = useState(false);
  const [remoteFilter, setRemoteFilter] = useState("");
  const searchSeqRef = useRef(0);

  useEffect(() => {
    if (!open) setInvalid(false);
  }, [open]);

  const parsed = useMemo(() => {
    if (!tool.trim() || !version.trim()) return null;
    return parseToolVersion(`${tool.trim()}@${version.trim()}`);
  }, [tool, version]);

  const script = useMemo(
    () => (parsed ? installAndUseScript(parsed.tool, parsed.version, "global") : null),
    [parsed]
  );

  const quickPicks = useMemo(() => {
    if (!suggestions || suggestions.versions.length === 0) return [];
    const stable = suggestions.versions.filter((item) => !item.rolling);
    return (stable.length > 0 ? stable : suggestions.versions).slice(0, 6);
  }, [suggestions]);

  // Results belong to the tool they were loaded for; a different tool name
  // makes them stale, and a late response for the old name is dropped.
  useEffect(() => {
    const current = tool.trim();
    if (remoteTool === null || remoteTool === current) return;
    searchSeqRef.current += 1;
    setRemotes([]);
    setRemoteTool(null);
    setRemoteFailed(false);
    setRemoteLoading(false);
    setRemoteFilter("");
  }, [tool, remoteTool]);

  const visibleVersions = useMemo(() => {
    const needle = remoteFilter.trim().toLowerCase();
    const matching = needle
      ? remotes.filter((remote) => remote.version.toLowerCase().includes(needle))
      : remotes;
    return matching.slice(0, MAX_VISIBLE_VERSIONS);
  }, [remotes, remoteFilter]);

  const searchVersions = async () => {
    const name = tool.trim();
    if (!name) {
      setInvalid(true);
      return;
    }

    const seq = searchSeqRef.current + 1;
    searchSeqRef.current = seq;
    setRemoteLoading(true);
    setRemoteFailed(false);

    try {
      const found = await miseRemoteVersions(name, undefined, REMOTE_LIST_LIMIT);
      if (seq !== searchSeqRef.current) return;
      setRemotes(found);
      setRemoteTool(name);
      setRemoteFilter("");
    } catch {
      if (seq !== searchSeqRef.current) return;
      setRemotes([]);
      setRemoteTool(null);
      setRemoteFailed(true);
    } finally {
      if (seq === searchSeqRef.current) setRemoteLoading(false);
    }
  };

  const pickVersion = (remote: MiseRemoteVersion) => {
    if (!suggestions) return;
    setTool(suggestions.tool);
    setVersion(remote.version);
    setInvalid(false);
  };

  const preview = () => {
    if (!parsed) {
      setInvalid(true);
      return;
    }

    const command = installAndUseScript(parsed.tool, parsed.version, "global");
    setInvalid(false);
    onPreview({
      title: `${t("mise.tools.install.title")} ${parsed.tool}@${parsed.version}`,
      summary: t("mise.tools.install.description"),
      command,
      level: "info",
      affectedFiles: affectedFilesForScript(command),
      confirmLabel: t("mise.tools.install.confirm"),
    });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("mise.tools.install.title")}</DialogTitle>
          <DialogDescription>{t("mise.tools.install.description")}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="mise-install-tool">{t("mise.tools.install.tool")}</Label>
              <Input
                id="mise-install-tool"
                value={tool}
                onChange={(event) => {
                  setTool(event.target.value);
                  setInvalid(false);
                }}
                placeholder={t("mise.tools.install.toolPlaceholder")}
                autoComplete="off"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="mise-install-version">{t("mise.tools.install.version")}</Label>
              <Input
                id="mise-install-version"
                value={version}
                onChange={(event) => {
                  setVersion(event.target.value);
                  setInvalid(false);
                }}
                placeholder={t("mise.tools.install.versionPlaceholder")}
                autoComplete="off"
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="xs"
              disabled={!tool.trim() || remoteLoading}
              onClick={() => void searchVersions()}
            >
              {remoteLoading ? t("mise.tools.install.searching") : t("mise.tools.install.search")}
            </Button>
            <span className="text-muted-foreground text-xs">
              {t("mise.tools.install.searchHint")}
            </span>
          </div>

          {remoteFailed && (
            <p className="text-destructive text-xs" role="alert">
              {t("mise.tools.install.searchFailed")}
            </p>
          )}

          {remotes.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <span className="text-muted-foreground text-xs">
                {t("mise.tools.install.searchResult", {
                  shown: visibleVersions.length,
                  total: remotes.length,
                })}
              </span>
              <Input
                value={remoteFilter}
                onChange={(event) => setRemoteFilter(event.target.value)}
                placeholder={t("mise.tools.install.filterPlaceholder")}
                autoComplete="off"
              />
              {visibleVersions.length > 0 ? (
                <div className="max-h-48 overflow-y-auto rounded-md border">
                  <div className="divide-y">
                    {visibleVersions.map((remote) => (
                      <button
                        key={remote.version}
                        type="button"
                        className="hover:bg-muted block w-full px-2.5 py-1.5 text-left font-mono text-xs"
                        onClick={() => {
                          setVersion(remote.version);
                          setInvalid(false);
                        }}
                      >
                        {remote.version}
                        {remote.rolling && (
                          <span className="text-muted-foreground ml-2 font-sans">
                            {t("mise.tools.channel.rolling")}
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <p className="text-muted-foreground text-xs">{t("mise.tools.install.noMatches")}</p>
              )}
            </div>
          )}

          {quickPicks.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <span className="text-muted-foreground text-xs">
                {t("mise.tools.fields.remoteVersions")}
              </span>
              <div className="flex flex-wrap gap-1.5">
                {quickPicks.map((remote) => (
                  <Button
                    key={remote.version}
                    type="button"
                    variant="outline"
                    size="xs"
                    onClick={() => pickVersion(remote)}
                  >
                    {remote.version}
                  </Button>
                ))}
              </div>
            </div>
          )}

          {script && (
            <div className="flex flex-col gap-1.5">
              <span className="text-muted-foreground text-xs">
                {t("mise.tools.install.command")}
              </span>
              <pre className="bg-muted overflow-x-auto rounded-md p-2.5 font-mono text-xs leading-relaxed break-all whitespace-pre-wrap select-text">
                {script}
              </pre>
            </div>
          )}

          {invalid && (
            <p className="text-destructive text-xs" role="alert">
              {t("mise.tools.install.invalid")}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("mise.actions.cancel")}
          </Button>
          <Button onClick={preview}>{t("mise.tools.action.preview")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
