import { useEffect, useState, type FormEvent } from "react";
import { open as pickFile } from "@tauri-apps/plugin-dialog";
import { Eye, EyeOff, FolderOpen, KeyRound, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { apiReadTextFile } from "@/commands/services/api-client";
import { serverProfileCreate, serverProfileUpdate } from "@/commands/services/servers";
import type {
  AuthKind,
  ServerProfile,
  ServerProfileInput,
} from "@/commands/services/servers/types";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { errorText, serverErrorCodeKey } from "@/lib/servers/format";

const DEFAULT_PORT = 22;

type FieldName = "name" | "host" | "port" | "username" | "privateKey";

type FieldErrors = Partial<Record<FieldName, string>>;

export type ServerFormDialogProps = {
  open: boolean;
  /** `null` creates a new profile; a profile edits that one in place. */
  profile: ServerProfile | null;
  onOpenChange: (open: boolean) => void;
  /** Called after the profile was saved. */
  onSaved: (profile: ServerProfile) => void;
};

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return <p className="text-destructive text-xs">{message}</p>;
}

/**
 * Create / edit dialog for a server profile.
 *
 * Credentials travel inside the profile and are saved to `servers.json` in
 * plain text, so a single command persists everything. The password fields
 * start masked and can be revealed with the eye button.
 */
export function ServerFormDialog({ open, profile, onOpenChange, onSaved }: ServerFormDialogProps) {
  const { t } = useAppTranslation();

  const [name, setName] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState(String(DEFAULT_PORT));
  const [username, setUsername] = useState("");
  const [authKind, setAuthKind] = useState<AuthKind>("password");
  const [privateKey, setPrivateKey] = useState("");
  const [password, setPassword] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showPassphrase, setShowPassphrase] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [busy, setBusy] = useState(false);

  // Reset only when the dialog opens for a profile: a parent refresh while the
  // dialog stands must not wipe what the user is typing.
  useEffect(() => {
    if (!open) return;
    setName(profile?.name ?? "");
    setHost(profile?.host ?? "");
    setPort(String(profile?.port ?? DEFAULT_PORT));
    setUsername(profile?.username ?? "");
    setAuthKind(profile?.authKind ?? "password");
    setPrivateKey(profile?.privateKey ?? "");
    setPassword(profile?.password ?? "");
    setPassphrase(profile?.passphrase ?? "");
    setShowPassword(false);
    setShowPassphrase(false);
    setErrors({});
    setBusy(false);
  }, [open, profile?.id]);

  const describeFailure = (error: unknown) => {
    const key = serverErrorCodeKey(error);
    return key ? t(key, { defaultValue: errorText(error) }) : errorText(error);
  };

  const validate = (): boolean => {
    const next: FieldErrors = {};
    if (!name.trim()) next.name = t("servers.form.validation.nameRequired");
    if (!host.trim()) next.host = t("servers.form.validation.hostRequired");
    if (!username.trim()) next.username = t("servers.form.validation.usernameRequired");

    const parsedPort = Number(port.trim());
    if (!port.trim() || !Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
      next.port = t("servers.form.validation.portInvalid");
    }

    if (authKind === "privateKey" && !privateKey.trim()) {
      next.privateKey = t("servers.form.validation.privateKeyRequired");
    }

    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const browseKey = async () => {
    try {
      const picked = await pickFile({
        title: t("servers.form.privateKey"),
        multiple: false,
        directory: false,
      });
      if (typeof picked === "string") {
        const file = await apiReadTextFile(picked);
        setPrivateKey(file.text);
      }
    } catch (error) {
      toast.error(errorText(error));
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (!validate()) return;

    setBusy(true);
    const input: ServerProfileInput = {
      name: name.trim(),
      host: host.trim(),
      port: Number(port.trim()),
      username: username.trim(),
      authKind,
      privateKey: authKind === "privateKey" ? privateKey || null : null,
      password: password || null,
      passphrase: passphrase || null,
      terminalType: profile?.terminalType ?? null,
      note: profile?.note ?? null,
      color: profile?.color ?? null,
    };

    try {
      const saved = profile
        ? await serverProfileUpdate(profile.id, input)
        : await serverProfileCreate(input);
      setPassword("");
      setPassphrase("");
      setBusy(false);
      onSaved(saved);
      onOpenChange(false);
    } catch (error) {
      toast.error(describeFailure(error));
      setBusy(false);
    }
  };

  const editing = profile !== null;

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {editing
              ? t("servers.form.editTitle", { defaultValue: "Edit server" })
              : t("servers.form.createTitle", { defaultValue: "Add server" })}
          </DialogTitle>
          <DialogDescription>
            {t("servers.form.description", {
              defaultValue:
                "Credentials and the private key are stored in plain text in servers.json.",
            })}
          </DialogDescription>
        </DialogHeader>

        <form className="flex flex-col gap-4" onSubmit={(event) => void submit(event)}>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="server-form-name">{t("servers.form.name")}</Label>
            <Input
              id="server-form-name"
              value={name}
              aria-invalid={errors.name ? true : undefined}
              onChange={(event) => setName(event.target.value)}
              placeholder={t("servers.form.namePlaceholder", { defaultValue: "Production web" })}
              autoFocus
            />
            <FieldError message={errors.name} />
          </div>

          <div className="grid grid-cols-[1fr_7rem] gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="server-form-host">{t("servers.form.host")}</Label>
              <Input
                id="server-form-host"
                value={host}
                aria-invalid={errors.host ? true : undefined}
                onChange={(event) => setHost(event.target.value)}
                placeholder="10.0.0.12"
                spellCheck={false}
              />
              <FieldError message={errors.host} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="server-form-port">{t("servers.form.port")}</Label>
              <Input
                id="server-form-port"
                value={port}
                inputMode="numeric"
                aria-invalid={errors.port ? true : undefined}
                onChange={(event) => setPort(event.target.value.replace(/[^0-9]/g, ""))}
              />
              <FieldError message={errors.port} />
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="server-form-username">{t("servers.form.username")}</Label>
            <Input
              id="server-form-username"
              value={username}
              aria-invalid={errors.username ? true : undefined}
              onChange={(event) => setUsername(event.target.value)}
              placeholder="root"
              spellCheck={false}
            />
            <FieldError message={errors.username} />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="server-form-auth">{t("servers.form.authKind")}</Label>
            <Select value={authKind} onValueChange={(value) => setAuthKind(value as AuthKind)}>
              <SelectTrigger id="server-form-auth" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="password">
                  {t("servers.form.authPassword", { defaultValue: "Password" })}
                </SelectItem>
                <SelectItem value="privateKey">
                  {t("servers.form.authKey", { defaultValue: "Private key" })}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          {authKind === "privateKey" ? (
            <>
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between gap-2">
                  <Label htmlFor="server-form-key">{t("servers.form.privateKey")}</Label>
                  <Button
                    type="button"
                    variant="secondary"
                    size="xs"
                    aria-label={t("servers.form.browse", { defaultValue: "Browse" })}
                    title={t("servers.form.browse", { defaultValue: "Browse" })}
                    onClick={() => void browseKey()}
                  >
                    <FolderOpen />
                    {t("servers.form.browse", { defaultValue: "Browse" })}
                  </Button>
                </div>
                <Textarea
                  id="server-form-key"
                  rows={6}
                  className="font-mono text-xs"
                  value={privateKey}
                  aria-invalid={errors.privateKey ? true : undefined}
                  onChange={(event) => setPrivateKey(event.target.value)}
                  placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                  spellCheck={false}
                />
                <FieldError message={errors.privateKey} />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="server-form-passphrase">{t("servers.form.passphrase")}</Label>
                <div className="relative">
                  <Input
                    id="server-form-passphrase"
                    type={showPassphrase ? "text" : "password"}
                    value={passphrase}
                    autoComplete="new-password"
                    className="pr-10"
                    onChange={(event) => setPassphrase(event.target.value)}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="absolute top-1/2 right-1.5 -translate-y-1/2"
                    aria-label={
                      showPassphrase
                        ? t("servers.form.hideSecret", { defaultValue: "Hide secret" })
                        : t("servers.form.showSecret", { defaultValue: "Show secret" })
                    }
                    onClick={() => setShowPassphrase((current) => !current)}
                  >
                    {showPassphrase ? <EyeOff /> : <Eye />}
                  </Button>
                </div>
                <p className="text-muted-foreground text-xs">{t("servers.form.testHint")}</p>
              </div>
            </>
          ) : (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="server-form-password">{t("servers.form.password")}</Label>
              <div className="relative">
                <Input
                  id="server-form-password"
                  type={showPassword ? "text" : "password"}
                  value={password}
                  autoComplete="new-password"
                  className="pr-10"
                  onChange={(event) => setPassword(event.target.value)}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="absolute top-1/2 right-1.5 -translate-y-1/2"
                  aria-label={
                    showPassword
                      ? t("servers.form.hideSecret", { defaultValue: "Hide secret" })
                      : t("servers.form.showSecret", { defaultValue: "Show secret" })
                  }
                  onClick={() => setShowPassword((current) => !current)}
                >
                  {showPassword ? <EyeOff /> : <Eye />}
                </Button>
              </div>
              <p className="text-muted-foreground text-xs">{t("servers.form.testHint")}</p>
            </div>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => onOpenChange(false)}
            >
              {t("servers.form.cancel")}
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? <Loader2 className="animate-spin" /> : <KeyRound />}
              {t("servers.form.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
