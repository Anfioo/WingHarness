import { useEffect, useState, type FormEvent } from "react";
import { Eye, EyeOff, KeyRound, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { serverConnect, serverSecretSet } from "@/commands/services/servers";
import type { ConnectOutcome, SecretKind } from "@/commands/services/servers/types";
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
import { errorText, formatEndpoint, serverErrorCodeKey } from "@/lib/servers/format";

/** What is missing before the connection can be retried. */
export type CredentialRequest = {
  profileId: string;
  kind: SecretKind;
  username?: string;
  host?: string;
  port?: number;
  /** Terminal size for the retry. */
  cols?: number;
  rows?: number;
  /** Set when the host key is already trusted and the retry may rely on it. */
  trustHostKey?: boolean;
};

export type CredentialPromptProps = {
  request: CredentialRequest | null;
  onOpenChange: (open: boolean) => void;
  /** Called with the connection that succeeded after the secret was stored. */
  onConnected?: (outcome: ConnectOutcome) => void;
  onFailed?: (error: unknown) => void;
};

/**
 * Asks for the one secret a connection was missing and retries.
 *
 * The value goes to `server_secret_set`, which writes it as plain text into
 * `servers.json`, and is dropped from state as soon as the command resolves.
 * The field is masked by default; the eye button reveals what is typed.
 */
export function CredentialPromptDialog({
  request,
  onOpenChange,
  onConnected,
  onFailed,
}: CredentialPromptProps) {
  const { t } = useAppTranslation();
  const [secret, setSecret] = useState("");
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSecret("");
    setVisible(false);
    setBusy(false);
    setError(null);
  }, [request?.profileId, request?.kind]);

  const describeFailure = (failure: unknown) => {
    const key = serverErrorCodeKey(failure);
    return key ? t(key, { defaultValue: errorText(failure) }) : errorText(failure);
  };

  const close = () => {
    setSecret("");
    onOpenChange(false);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!request || busy || !secret) return;

    setBusy(true);
    setError(null);
    const value = secret;
    try {
      await serverSecretSet(request.profileId, request.kind, value);
      // The value is in servers.json now; drop the copy held by this form.
      setSecret("");
      const outcome = await serverConnect(
        request.profileId,
        request.cols ?? 80,
        request.rows ?? 24,
        request.trustHostKey ?? false
      );
      toast.success(t("servers.connection.ready"));
      onConnected?.(outcome);
      onOpenChange(false);
    } catch (failure) {
      setError(describeFailure(failure));
      onFailed?.(failure);
    } finally {
      setBusy(false);
    }
  };

  const isPassphrase = request?.kind === "passphrase";
  const endpoint =
    request?.host && request.username && request.port
      ? formatEndpoint(request.host, request.port, request.username)
      : null;

  return (
    <Dialog
      open={request !== null}
      onOpenChange={(next) => {
        if (!busy && !next) close();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="text-primary size-4 shrink-0" />
            {isPassphrase
              ? t("servers.credential.passphraseTitle", {
                  defaultValue: "Private key passphrase required",
                })
              : t("servers.credential.passwordTitle", { defaultValue: "Password required" })}
          </DialogTitle>
          <DialogDescription>
            {endpoint
              ? t("servers.credential.description", {
                  endpoint,
                  defaultValue: "Enter the {{kind}} for {{endpoint}}.",
                  kind: isPassphrase ? t("servers.form.passphrase") : t("servers.form.password"),
                })
              : t("servers.credential.descriptionNoHost", {
                  defaultValue: "Enter the missing credential to continue.",
                })}
          </DialogDescription>
        </DialogHeader>

        <form className="flex flex-col gap-3" onSubmit={(event) => void submit(event)}>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="server-credential-value">
              {isPassphrase ? t("servers.form.passphrase") : t("servers.form.password")}
            </Label>
            <div className="relative">
              <Input
                id="server-credential-value"
                type={visible ? "text" : "password"}
                value={secret}
                autoFocus
                autoComplete="current-password"
                className="pr-10"
                onChange={(event) => setSecret(event.target.value)}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="absolute top-1/2 right-1.5 -translate-y-1/2"
                aria-label={
                  visible
                    ? t("servers.credential.hide", { defaultValue: "Hide" })
                    : t("servers.credential.show", { defaultValue: "Show" })
                }
                onClick={() => setVisible((current) => !current)}
              >
                {visible ? <EyeOff /> : <Eye />}
              </Button>
            </div>
            <p className="text-muted-foreground text-xs">{t("servers.form.testHint")}</p>
          </div>

          {error && (
            <p className="border-destructive/30 bg-destructive/5 text-destructive rounded-md border px-2.5 py-1.5 text-xs">
              {error}
            </p>
          )}

          <DialogFooter>
            <Button type="button" variant="ghost" disabled={busy} onClick={close}>
              {t("servers.form.cancel")}
            </Button>
            <Button type="submit" disabled={busy || !secret}>
              {busy ? <Loader2 className="animate-spin" /> : <KeyRound />}
              {t("servers.credential.retry", { defaultValue: "Save and connect" })}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
