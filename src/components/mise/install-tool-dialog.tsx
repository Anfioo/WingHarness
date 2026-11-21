// The install-tool dialog: a tool name and version, optionally picked from the
// selected tool's remote versions. It only builds the script and hands it to
// the shared action preview; nothing runs here.

import { useEffect, useMemo, useState } from "react";

import type { MiseRemoteVersion } from "@/commands";
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
