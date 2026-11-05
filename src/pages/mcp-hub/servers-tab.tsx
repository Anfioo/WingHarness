import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  mcphubImportServers,
  mcphubListServers,
  mcphubRemoveServer,
  mcphubSetServerEnabled,
  mcphubUpdateServer,
  type ServerView,
} from "@/commands";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { Badge, Switch } from "./ui-bits";

/** Keys whose values look like secrets (tokens / keys / passwords). */
const SECRET_KEY_RE = /token|secret|password|api[-_]?key|private[_-]?key|secret[_-]?key/i;

/** Count secret-looking fields inside a JSON text (best-effort, non-throwing). */
function countSecretFields(jsonText: string): number {
  if (!jsonText.trim()) return 0;
  try {
    let count = 0;
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      if (node && typeof node === "object") {
        for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
          if (SECRET_KEY_RE.test(k)) count++;
          walk(v);
        }
      }
    };
    walk(JSON.parse(jsonText));
    return count;
  } catch {
    return 0;
  }
}

/** Build the JSON preview we prefill into the edit dialog. */
function buildEditJson(server: ServerView): string {
  return JSON.stringify(
    {
      name: server.name,
      command: server.command,
      args: server.args,
      env: {},
    },
    null,
    2
  );
}

/** Parse the edit-dialog JSON back into a ServerConfigInput-shaped payload. */
function parseEditJson(jsonText: string, fallbackName: string) {
  const parsed = JSON.parse(jsonText) as Record<string, unknown>;
  if (typeof parsed.command !== "string" || !parsed.command) {
    throw new Error("missing command");
  }
  const args = Array.isArray(parsed.args) ? parsed.args.map(String) : [];
  const env =
    parsed.env && typeof parsed.env === "object"
      ? Object.fromEntries(
          Object.entries(parsed.env as Record<string, unknown>).map(([k, v]) => [k, String(v)])
        )
      : {};
  return {
    name: typeof parsed.name === "string" && parsed.name ? parsed.name : fallbackName,
    command: parsed.command,
    args,
    env,
    pool: typeof parsed.pool === "number" ? parsed.pool : 1,
  };
}

export function ServersTab({ onChanged }: { onChanged: () => void }) {
  const { t } = useAppTranslation();
  const [servers, setServers] = useState<ServerView[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<ServerView | null>(null);
  const [jsonText, setJsonText] = useState("");
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState<ServerView | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await mcphubListServers();
      setServers(list);
    } catch (error) {
      console.error("mcphub list servers:", error);
      toast.error(t("mcphub.servers.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const secretCount = useMemo(() => countSecretFields(jsonText), [jsonText]);

  const openAdd = () => {
    setEditing(null);
    setJsonText("");
    setDialogOpen(true);
  };

  const openEdit = (server: ServerView) => {
    setEditing(server);
    setJsonText(buildEditJson(server));
    setDialogOpen(true);
  };

  const handleSubmit = async () => {
    if (!jsonText.trim()) {
      toast.error(t("mcphub.servers.importEmpty"));
      return;
    }
    setSaving(true);
    try {
      if (editing) {
        const payload = parseEditJson(jsonText, editing.name);
        await mcphubUpdateServer(payload);
        toast.success(t("mcphub.servers.saved"));
      } else {
        const result = await mcphubImportServers({ json: jsonText });
        toast.success(
          t("mcphub.servers.importDone", {
            ok: result.ok,
            failed: result.failed,
            tools: result.tools,
          })
        );
      }
      setDialogOpen(false);
      await load();
      onChanged();
    } catch (error) {
      console.error("mcphub save server:", error);
      toast.error(editing ? t("mcphub.servers.saveFailed") : t("mcphub.servers.importInvalid"));
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async () => {
    if (!removing) return;
    try {
      await mcphubRemoveServer(removing.name);
      toast.success(t("mcphub.servers.removed", { name: removing.name }));
      setRemoving(null);
      await load();
      onChanged();
    } catch (error) {
      console.error("mcphub remove server:", error);
      toast.error(t("mcphub.servers.removeFailed"));
    }
  };

  const handleToggleEnabled = async (server: ServerView, next: boolean) => {
    try {
      await mcphubSetServerEnabled(server.name, next);
      await load();
    } catch (error) {
      console.error("mcphub set enabled:", error);
      toast.error(t("mcphub.tools.toggleFailed"));
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <p className="text-muted-foreground text-sm">
          {t("mcphub.servers.colName")} · {servers.length}
        </p>
        <Button size="sm" onClick={openAdd}>
          <Plus className="size-4" />
          {t("mcphub.servers.add")}
        </Button>
      </div>

      {loading ? (
        <div className="flex h-32 items-center justify-center gap-2 text-sm">
          <Loader2 className="size-4 animate-spin" />
          {t("mcphub.loading")}
        </div>
      ) : servers.length === 0 ? (
        <div className="border-border/60 rounded-lg border border-dashed p-8 text-center text-sm">
          <p className="text-muted-foreground">{t("mcphub.servers.empty")}</p>
        </div>
      ) : (
        <div className="border-border overflow-hidden rounded-lg border">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-muted/60 text-muted-foreground border-b text-left text-xs">
                <th className="px-3 py-2 font-medium">{t("mcphub.servers.colName")}</th>
                <th className="px-3 py-2 font-medium">{t("mcphub.servers.colCommand")}</th>
                <th className="px-3 py-2 font-medium">{t("mcphub.servers.colStatus")}</th>
                <th className="px-3 py-2 font-medium">{t("mcphub.servers.colTools")}</th>
                <th className="px-3 py-2 font-medium">{t("mcphub.servers.colLatency")}</th>
                <th className="px-3 py-2 font-medium">{t("mcphub.servers.colEnabled")}</th>
                <th className="px-3 py-2 text-right font-medium">
                  {t("mcphub.servers.colActions")}
                </th>
              </tr>
            </thead>
            <tbody>
              {servers.map((server) => (
                <tr key={server.name} className="border-b last:border-b-0">
                  <td className="px-3 py-2 font-medium">{server.name}</td>
                  <td className="px-3 py-2">
                    <code className="bg-muted rounded px-1.5 py-0.5 font-mono text-xs">
                      {server.command} {server.args.join(" ")}
                    </code>
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap gap-1">
                      <Badge tone={server.running ? "green" : "gray"}>
                        {server.running
                          ? t("mcphub.servers.statusRunning")
                          : t("mcphub.servers.statusStopped")}
                      </Badge>
                      {server.running && (
                        <Badge tone={server.healthy ? "green" : "amber"}>
                          {server.healthy
                            ? t("mcphub.servers.statusHealthy")
                            : t("mcphub.servers.statusUnhealthy")}
                        </Badge>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-2">{server.toolCount}</td>
                  <td className="px-3 py-2 font-mono text-xs">
                    {server.lastLatencyMs != null
                      ? t("mcphub.servers.latencyMs", { ms: server.lastLatencyMs })
                      : "—"}
                  </td>
                  <td className="px-3 py-2">
                    <Switch
                      checked={server.enabled}
                      onChange={(next) => void handleToggleEnabled(server, next)}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="icon-xs" onClick={() => openEdit(server)}>
                        <Pencil className="size-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        onClick={() => setRemoving(server)}
                        className="text-destructive hover:text-destructive"
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Add (JSON paste) / Edit (JSON) dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editing
                ? t("mcphub.servers.dialogEditTitle")
                : t("mcphub.servers.dialogImportTitle")}
            </DialogTitle>
            <DialogDescription>
              {editing ? editing.name : t("mcphub.servers.dialogImportDesc")}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <textarea
              className="border-input bg-background focus-visible:border-ring focus-visible:ring-ring/50 rounded-md border px-3 py-2 font-mono text-sm shadow-xs outline-none focus-visible:ring-[3px]"
              rows={10}
              value={jsonText}
              onChange={(e) => setJsonText(e.target.value)}
              placeholder={t("mcphub.servers.importPlaceholder")}
              spellCheck={false}
            />
            {secretCount > 0 && (
              <p className="text-destructive flex items-center gap-1.5 text-xs">
                <AlertTriangle className="size-3.5" />
                {t("mcphub.servers.secretDetected", { count: secretCount })}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              {t("mcphub.servers.cancel")}
            </Button>
            <Button onClick={() => void handleSubmit()} disabled={saving}>
              {saving ? <Loader2 className="size-4 animate-spin" /> : null}
              {editing ? t("mcphub.servers.submitUpdate") : t("mcphub.servers.import")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <Dialog open={!!removing} onOpenChange={(open) => !open && setRemoving(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("mcphub.servers.remove")}</DialogTitle>
            <DialogDescription>
              {t("mcphub.servers.removeConfirm", { name: removing?.name ?? "" })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemoving(null)}>
              {t("mcphub.servers.cancel")}
            </Button>
            <Button variant="destructive" onClick={() => void handleRemove()}>
              <Trash2 className="size-4" />
              {t("mcphub.servers.remove")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
