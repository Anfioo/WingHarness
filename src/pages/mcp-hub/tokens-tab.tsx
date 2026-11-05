import { useCallback, useEffect, useState } from "react";
import { Check, Copy, Loader2, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  mcphubCreateToken,
  mcphubListServers,
  mcphubListTokens,
  mcphubRevokeToken,
  type ServerView,
  type TokenView,
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
import { Input } from "@/components/ui/input";
import { useAppTranslation } from "@/hooks/use-app-translation";

function maskToken(token: string) {
  if (token.length <= 12) return token;
  return `${token.slice(0, 10)}…${token.slice(-4)}`;
}

function formatTime(ts: number) {
  return new Date(ts).toLocaleString();
}

export function TokensTab() {
  const { t } = useAppTranslation();
  const [tokens, setTokens] = useState<TokenView[]>([]);
  const [servers, setServers] = useState<ServerView[]>([]);
  const [loading, setLoading] = useState(true);

  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [allowed, setAllowed] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  const [createdToken, setCreatedToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const [revoking, setRevoking] = useState<TokenView | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [list, serverList] = await Promise.all([mcphubListTokens(), mcphubListServers()]);
      setTokens(list);
      setServers(serverList);
    } catch (error) {
      console.error("mcphub list tokens:", error);
      toast.error(t("mcphub.tokens.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const openCreate = () => {
    setName("");
    setAllowed({});
    setCreatedToken(null);
    setCopied(false);
    setCreateOpen(true);
  };

  const handleCreate = async () => {
    if (!name.trim()) {
      toast.error(t("mcphub.tokens.fieldName"));
      return;
    }
    setSaving(true);
    try {
      const allowedServers = Object.entries(allowed)
        .filter(([, on]) => on)
        .map(([s]) => s);
      const result = await mcphubCreateToken({
        name: name.trim(),
        allowedServers: allowedServers.length ? allowedServers : undefined,
      });
      setCreatedToken(result.token);
      await load();
    } catch (error) {
      console.error("mcphub create token:", error);
      toast.error(t("mcphub.tokens.loadFailed"));
    } finally {
      setSaving(false);
    }
  };

  const handleCopy = async () => {
    if (!createdToken) return;
    try {
      await navigator.clipboard.writeText(createdToken);
      setCopied(true);
      toast.success(t("mcphub.tokens.copied"));
    } catch (error) {
      console.error("copy token:", error);
      toast.error(t("mcphub.tokens.copyFailed"));
    }
  };

  const handleRevoke = async () => {
    if (!revoking) return;
    try {
      await mcphubRevokeToken(revoking.token);
      toast.success(t("mcphub.tokens.revoked", { name: revoking.name }));
      setRevoking(null);
      await load();
    } catch (error) {
      console.error("mcphub revoke token:", error);
      toast.error(t("mcphub.tokens.revokeFailed"));
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <p className="text-muted-foreground text-sm">{tokens.length}</p>
        <Button size="sm" onClick={openCreate}>
          <Plus className="size-4" />
          {t("mcphub.tokens.add")}
        </Button>
      </div>

      {loading ? (
        <div className="flex h-32 items-center justify-center gap-2 text-sm">
          <Loader2 className="size-4 animate-spin" />
          {t("mcphub.loading")}
        </div>
      ) : tokens.length === 0 ? (
        <div className="border-border/60 rounded-lg border border-dashed p-8 text-center text-sm">
          <p className="text-muted-foreground">{t("mcphub.tokens.empty")}</p>
        </div>
      ) : (
        <div className="border-border overflow-hidden rounded-lg border">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-muted/60 text-muted-foreground border-b text-left text-xs">
                <th className="px-3 py-2 font-medium">{t("mcphub.tokens.colToken")}</th>
                <th className="px-3 py-2 font-medium">{t("mcphub.tokens.colName")}</th>
                <th className="px-3 py-2 font-medium">{t("mcphub.tokens.colAllowed")}</th>
                <th className="px-3 py-2 font-medium">{t("mcphub.tokens.colCreatedAt")}</th>
                <th className="px-3 py-2 text-right font-medium">
                  {t("mcphub.tokens.colActions")}
                </th>
              </tr>
            </thead>
            <tbody>
              {tokens.map((token) => (
                <tr key={token.token} className="border-b last:border-b-0">
                  <td className="px-3 py-2">
                    <code className="bg-muted rounded px-1.5 py-0.5 font-mono text-xs">
                      {maskToken(token.token)}
                    </code>
                  </td>
                  <td className="px-3 py-2 font-medium">{token.name}</td>
                  <td className="px-3 py-2 text-xs">
                    {token.allowedServers && token.allowedServers.length > 0
                      ? token.allowedServers.join(", ")
                      : t("mcphub.tokens.allServers")}
                  </td>
                  <td className="px-3 py-2 text-xs">{formatTime(token.createdAt)}</td>
                  <td className="px-3 py-2">
                    <div className="flex justify-end">
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        onClick={() => setRevoking(token)}
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

      {/* Create dialog */}
      <Dialog
        open={createOpen}
        onOpenChange={(open) => {
          setCreateOpen(open);
          if (!open) setCreatedToken(null);
        }}
      >
        <DialogContent>
          {createdToken ? (
            <>
              <DialogHeader>
                <DialogTitle>{t("mcphub.tokens.createdTitle")}</DialogTitle>
                <DialogDescription>{t("mcphub.tokens.createdHint")}</DialogDescription>
              </DialogHeader>
              <div className="bg-muted rounded-md p-3">
                <code className="font-mono text-xs break-all">{createdToken}</code>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => void handleCopy()}>
                  {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
                  {t("mcphub.tokens.copy")}
                </Button>
                <Button onClick={() => setCreateOpen(false)}>{t("mcphub.tokens.done")}</Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>{t("mcphub.tokens.dialogTitle")}</DialogTitle>
              </DialogHeader>
              <div className="flex flex-col gap-3">
                <label className="flex flex-col gap-1 text-sm">
                  <span className="text-muted-foreground">{t("mcphub.tokens.fieldName")}</span>
                  <Input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder={t("mcphub.tokens.fieldNamePlaceholder")}
                  />
                </label>
                <div className="flex flex-col gap-1 text-sm">
                  <span className="text-muted-foreground">{t("mcphub.tokens.fieldAllowed")}</span>
                  <div className="border-border rounded-md border p-2">
                    {servers.length === 0 ? (
                      <p className="text-muted-foreground text-xs">—</p>
                    ) : (
                      <div className="flex flex-col gap-1">
                        {servers.map((s) => (
                          <label key={s.name} className="flex items-center gap-2 text-sm">
                            <input
                              type="checkbox"
                              checked={!!allowed[s.name]}
                              onChange={(e) =>
                                setAllowed((a) => ({ ...a, [s.name]: e.target.checked }))
                              }
                            />
                            <span>{s.name}</span>
                          </label>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setCreateOpen(false)}>
                  {t("mcphub.tokens.cancel")}
                </Button>
                <Button onClick={() => void handleCreate()} disabled={saving}>
                  {saving ? <Loader2 className="size-4 animate-spin" /> : null}
                  {t("mcphub.tokens.submit")}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Revoke confirm */}
      <Dialog open={!!revoking} onOpenChange={(open) => !open && setRevoking(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("mcphub.tokens.revoke")}</DialogTitle>
            <DialogDescription>
              {t("mcphub.tokens.revokeConfirm", { name: revoking?.name ?? "" })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRevoking(null)}>
              {t("mcphub.tokens.cancel")}
            </Button>
            <Button variant="destructive" onClick={() => void handleRevoke()}>
              <Trash2 className="size-4" />
              {t("mcphub.tokens.revoke")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
