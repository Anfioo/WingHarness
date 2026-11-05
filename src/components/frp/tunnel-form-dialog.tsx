import { useEffect, useState, type FormEvent } from "react";
import { Eye, EyeOff, Loader2, Save } from "lucide-react";
import { toast } from "sonner";
import { frpTunnelCreate, frpTunnelUpdate } from "@/commands/services/frp";
import {
  frpErrorCode,
  isFrpError,
  type FrpProfile,
  type SecretRole,
  type Tunnel,
  type TunnelInput,
  type TunnelOptions,
  type TunnelType,
  type TunnelView,
} from "@/commands/services/frp/types";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
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
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { frpFailureKey } from "@/lib/frp/format";

const DEFAULT_LOCAL_IP = "127.0.0.1";
const NAME_MAX_CHARS = 80;

/** Protocol names are the same in every language, so they stay untranslated. */
const TUNNEL_TYPES: TunnelType[] = ["tcp", "udp", "http", "https", "stcp", "xtcp"];

type FieldName =
  | "profile"
  | "name"
  | "localIp"
  | "localPort"
  | "remotePort"
  | "domains"
  | "secretKey"
  | "serverName";

type FieldErrors = Partial<Record<FieldName, string>>;

const FIELD_VALIDATION_KEYS: Record<FieldName, string> = {
  profile: "frp.tunnelForm.validation.profile",
  name: "frp.tunnelForm.validation.name",
  localIp: "frp.tunnelForm.validation.localIp",
  localPort: "frp.tunnelForm.validation.localPort",
  remotePort: "frp.tunnelForm.validation.remotePort",
  domains: "frp.tunnelForm.validation.domains",
  secretKey: "frp.tunnelForm.validation.secretKey",
  serverName: "frp.tunnelForm.validation.serverName",
};

/** Maps the engine's `detail.field` onto this form's own fields. */
function backendField(error: unknown): FieldName | null {
  if (!isFrpError(error) || !error.detail) return null;
  const field = error.detail.field;
  if (typeof field !== "string") return null;
  switch (field) {
    case "profileId":
    case "profile_id":
      return "profile";
    case "name":
      return "name";
    case "localIp":
    case "local_ip":
      return "localIp";
    case "localPort":
    case "local_port":
      return "localPort";
    case "remotePort":
    case "remote_port":
      return "remotePort";
    case "customDomains":
    case "custom_domains":
    case "subdomain":
    case "locations":
      return "domains";
    case "secretKey":
    case "secret_key":
      return "secretKey";
    case "serverName":
    case "server_name":
      return "serverName";
    default:
      return null;
  }
}

function isPortType(type: TunnelType): type is "tcp" | "udp" {
  return type === "tcp" || type === "udp";
}

function isDomainType(type: TunnelType): type is "http" | "https" {
  return type === "http" || type === "https";
}

function isSecretType(type: TunnelType): type is "stcp" | "xtcp" {
  return type === "stcp" || type === "xtcp";
}

/** Domains and locations accept commas, newlines or plain whitespace. */
function splitList(value: string): string[] {
  return value
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** A 1–65535 integer, or `null` when the text is not one. */
function parsePort(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return parsed >= 1 && parsed <= 65535 ? parsed : null;
}

function buildOptions(params: {
  type: TunnelType;
  remotePort: number;
  domains: string[];
  subdomain: string;
  locations: string[];
  secretKey: string;
  role: SecretRole;
  serverName: string;
}): TunnelOptions {
  if (params.type === "tcp" || params.type === "udp") {
    return { kind: "port", remotePort: params.remotePort };
  }
  if (params.type === "http" || params.type === "https") {
    return {
      kind: "domain",
      customDomains: params.domains,
      subdomain: params.subdomain || null,
      locations: params.locations,
    };
  }
  return {
    kind: "secret",
    secretKey: params.secretKey,
    role: params.role,
    serverName: params.role === "visitor" ? params.serverName || null : null,
  };
}

export type TunnelFormDialogProps = {
  open: boolean;
  /** `null` creates a new tunnel; a tunnel edits that one in place. */
  tunnel: TunnelView | null;
  profiles: FrpProfile[];
  /** All tunnels, used for the in-profile duplicate-name check. */
  tunnels: TunnelView[];
  /** Preselects a server when the table is filtered to one. */
  defaultProfileId?: string | null;
  onOpenChange: (open: boolean) => void;
  onSaved: (tunnel: Tunnel) => void;
};

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return <p className="text-destructive text-xs">{message}</p>;
}

/**
 * Create / edit dialog for a tunnel.
 *
 * The fields follow the selected type: port for TCP/UDP, domains for
 * HTTP/HTTPS, and a shared secret plus role for STCP/XTCP. Validation mirrors
 * `frp-core/src/tunnels.rs`; when the engine still rejects an input, its
 * `detail.field` decides which field shows the message.
 */
export function TunnelFormDialog({
  open,
  tunnel,
  profiles,
  tunnels,
  defaultProfileId,
  onOpenChange,
  onSaved,
}: TunnelFormDialogProps) {
  const { t } = useAppTranslation();

  const [profileId, setProfileId] = useState("");
  const [name, setName] = useState("");
  const [type, setType] = useState<TunnelType>("tcp");
  const [localIp, setLocalIp] = useState(DEFAULT_LOCAL_IP);
  const [localPort, setLocalPort] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [remotePort, setRemotePort] = useState("");
  const [customDomains, setCustomDomains] = useState("");
  const [subdomain, setSubdomain] = useState("");
  const [locations, setLocations] = useState("");
  const [secretKey, setSecretKey] = useState("");
  const [showSecret, setShowSecret] = useState(false);
  const [role, setRole] = useState<SecretRole>("server");
  const [serverName, setServerName] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});
  const [busy, setBusy] = useState(false);

  // Reset only when the dialog opens: a workspace refresh while the dialog
  // stands must not wipe what the user is typing.
  useEffect(() => {
    if (!open) return;
    const active = tunnel;
    setProfileId(active?.profileId ?? defaultProfileId ?? profiles[0]?.id ?? "");
    setName(active?.name ?? "");
    setType(active?.type ?? "tcp");
    setLocalIp(active?.localIp ?? DEFAULT_LOCAL_IP);
    setLocalPort(active ? String(active.localPort) : "");
    setEnabled(active?.enabled ?? true);
    setRemotePort(
      active && active.options.kind === "port" ? String(active.options.remotePort) : ""
    );
    setCustomDomains(
      active && active.options.kind === "domain" ? active.options.customDomains.join("\n") : ""
    );
    setSubdomain(
      active && active.options.kind === "domain" ? (active.options.subdomain ?? "") : ""
    );
    setLocations(
      active && active.options.kind === "domain" ? active.options.locations.join("\n") : ""
    );
    setSecretKey(active && active.options.kind === "secret" ? active.options.secretKey : "");
    setShowSecret(false);
    setRole(active && active.options.kind === "secret" ? active.options.role : "server");
    setServerName(
      active && active.options.kind === "secret" ? (active.options.serverName ?? "") : ""
    );
    setErrors({});
    setBusy(false);
    // Reset only when a different tunnel opens or the preselected server
    // changes; a workspace refresh must not overwrite the user's edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, tunnel?.id, defaultProfileId]);

  const describeFailure = (error: unknown): string => {
    const key = frpFailureKey(error);
    const message = isFrpError(error) ? error.message.trim() : "";
    if (!key) return message || String(error);
    return message ? `${t(key)}: ${message}` : t(key);
  };

  const validate = (): boolean => {
    const next: FieldErrors = {};

    if (!profileId) {
      next.profile = t(FIELD_VALIDATION_KEYS.profile);
    }

    const trimmedName = name.trim();
    if (!trimmedName || [...trimmedName].length > NAME_MAX_CHARS) {
      next.name = t(FIELD_VALIDATION_KEYS.name);
    } else if (
      tunnels.some(
        (entry) =>
          entry.id !== tunnel?.id &&
          entry.profileId === profileId &&
          entry.name.trim() === trimmedName
      )
    ) {
      next.name = t("frp.tunnelForm.validation.nameTaken");
    }

    if (!localIp.trim()) {
      next.localIp = t(FIELD_VALIDATION_KEYS.localIp);
    }
    if (parsePort(localPort) === null) {
      next.localPort = t(FIELD_VALIDATION_KEYS.localPort);
    }

    if (isPortType(type)) {
      if (parsePort(remotePort) === null) {
        next.remotePort = t(FIELD_VALIDATION_KEYS.remotePort);
      }
    } else if (isDomainType(type)) {
      if (splitList(customDomains).length === 0 && !subdomain.trim()) {
        next.domains = t(FIELD_VALIDATION_KEYS.domains);
      }
    } else {
      if (!secretKey.trim()) {
        next.secretKey = t(FIELD_VALIDATION_KEYS.secretKey);
      }
      if (role === "visitor" && !serverName.trim()) {
        next.serverName = t(FIELD_VALIDATION_KEYS.serverName);
      }
    }

    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (!validate()) return;

    const localPortValue = parsePort(localPort);
    const remotePortValue = parsePort(remotePort);
    if (localPortValue === null || remotePortValue === null) return;

    const input: TunnelInput = {
      profileId,
      name: name.trim(),
      type,
      enabled,
      localIp: localIp.trim(),
      localPort: localPortValue,
      options: buildOptions({
        type,
        remotePort: remotePortValue,
        domains: splitList(customDomains),
        subdomain: subdomain.trim(),
        locations: splitList(locations),
        secretKey: secretKey.trim(),
        role,
        serverName: serverName.trim(),
      }),
    };

    setBusy(true);
    try {
      const saved = tunnel ? await frpTunnelUpdate(tunnel.id, input) : await frpTunnelCreate(input);
      onSaved(saved);
      onOpenChange(false);
    } catch (error) {
      if (frpErrorCode(error) === "conflict") {
        setErrors((current) => ({
          ...current,
          name: t("frp.tunnelForm.validation.nameTaken"),
        }));
      } else {
        const field = backendField(error);
        if (field) {
          setErrors((current) => ({ ...current, [field]: t(FIELD_VALIDATION_KEYS[field]) }));
        } else {
          toast.error(describeFailure(error));
        }
      }
    } finally {
      setBusy(false);
    }
  };

  const editing = tunnel !== null;
  const visitor = isSecretType(type) && role === "visitor";
  const localIpLabel = visitor ? t("frp.tunnelForm.bindIp") : t("frp.tunnelForm.localIp");
  const localPortLabel = visitor ? t("frp.tunnelForm.bindPort") : t("frp.tunnelForm.localPort");

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {editing ? t("frp.tunnelForm.titleEdit") : t("frp.tunnelForm.titleCreate")}
          </DialogTitle>
        </DialogHeader>

        <form className="flex flex-col gap-4" onSubmit={(event) => void submit(event)}>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="frp-tunnel-profile">{t("frp.tunnelForm.profile")}</Label>
            <Select
              value={profileId || undefined}
              disabled={editing}
              onValueChange={(value) => setProfileId(value)}
            >
              <SelectTrigger id="frp-tunnel-profile" className="w-full">
                <SelectValue placeholder={t("frp.tunnelForm.profilePlaceholder")} />
              </SelectTrigger>
              <SelectContent>
                {profiles.map((profile) => (
                  <SelectItem key={profile.id} value={profile.id}>
                    {profile.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldError message={errors.profile} />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="frp-tunnel-name">{t("frp.tunnelForm.name")}</Label>
            <Input
              id="frp-tunnel-name"
              value={name}
              aria-invalid={errors.name ? true : undefined}
              onChange={(event) => setName(event.target.value)}
              autoFocus
            />
            <FieldError message={errors.name} />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="frp-tunnel-type">{t("frp.tunnelForm.type")}</Label>
            <Select
              value={type}
              disabled={editing}
              onValueChange={(value) => {
                setType(value as TunnelType);
                setErrors({});
              }}
            >
              <SelectTrigger id="frp-tunnel-type" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TUNNEL_TYPES.map((option) => (
                  <SelectItem key={option} value={option}>
                    {option.toUpperCase()}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-[1fr_7rem] gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="frp-tunnel-local-ip">{localIpLabel}</Label>
              <Input
                id="frp-tunnel-local-ip"
                value={localIp}
                spellCheck={false}
                aria-invalid={errors.localIp ? true : undefined}
                onChange={(event) => setLocalIp(event.target.value)}
              />
              <FieldError message={errors.localIp} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="frp-tunnel-local-port">{localPortLabel}</Label>
              <Input
                id="frp-tunnel-local-port"
                value={localPort}
                inputMode="numeric"
                aria-invalid={errors.localPort ? true : undefined}
                onChange={(event) => setLocalPort(event.target.value.replace(/[^0-9]/g, ""))}
              />
              <FieldError message={errors.localPort} />
            </div>
          </div>

          {isPortType(type) && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="frp-tunnel-remote-port">{t("frp.tunnelForm.remotePort")}</Label>
              <Input
                id="frp-tunnel-remote-port"
                value={remotePort}
                inputMode="numeric"
                aria-invalid={errors.remotePort ? true : undefined}
                onChange={(event) => setRemotePort(event.target.value.replace(/[^0-9]/g, ""))}
              />
              <FieldError message={errors.remotePort} />
            </div>
          )}

          {isDomainType(type) && (
            <>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="frp-tunnel-domains">{t("frp.tunnelForm.customDomains")}</Label>
                <Textarea
                  id="frp-tunnel-domains"
                  rows={3}
                  value={customDomains}
                  spellCheck={false}
                  aria-invalid={errors.domains ? true : undefined}
                  onChange={(event) => setCustomDomains(event.target.value)}
                />
                <p className="text-muted-foreground text-xs">{t("frp.tunnelForm.listHint")}</p>
                <FieldError message={errors.domains} />
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="frp-tunnel-subdomain">{t("frp.tunnelForm.subdomain")}</Label>
                  <Input
                    id="frp-tunnel-subdomain"
                    value={subdomain}
                    spellCheck={false}
                    onChange={(event) => setSubdomain(event.target.value)}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="frp-tunnel-locations">{t("frp.tunnelForm.locations")}</Label>
                  <Input
                    id="frp-tunnel-locations"
                    value={locations}
                    spellCheck={false}
                    onChange={(event) => setLocations(event.target.value)}
                  />
                </div>
              </div>
            </>
          )}

          {isSecretType(type) && (
            <>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="frp-tunnel-secret">{t("frp.tunnelForm.secretKey")}</Label>
                <div className="relative">
                  <Input
                    id="frp-tunnel-secret"
                    type={showSecret ? "text" : "password"}
                    value={secretKey}
                    autoComplete="new-password"
                    className="pr-10"
                    aria-invalid={errors.secretKey ? true : undefined}
                    onChange={(event) => setSecretKey(event.target.value)}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="absolute top-1/2 right-1.5 -translate-y-1/2"
                    aria-label={
                      showSecret ? t("frp.tunnelForm.hideSecret") : t("frp.tunnelForm.showSecret")
                    }
                    title={
                      showSecret ? t("frp.tunnelForm.hideSecret") : t("frp.tunnelForm.showSecret")
                    }
                    onClick={() => setShowSecret((current) => !current)}
                  >
                    {showSecret ? <EyeOff /> : <Eye />}
                  </Button>
                </div>
                <FieldError message={errors.secretKey} />
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="frp-tunnel-role">{t("frp.tunnelForm.role")}</Label>
                  <Select
                    value={role}
                    onValueChange={(value) => {
                      setRole(value as SecretRole);
                      setErrors({});
                    }}
                  >
                    <SelectTrigger id="frp-tunnel-role" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="server">{t("frp.tunnelForm.serverRole")}</SelectItem>
                      <SelectItem value="visitor">{t("frp.tunnelForm.visitorRole")}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {role === "visitor" && (
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="frp-tunnel-server-name">{t("frp.tunnelForm.serverName")}</Label>
                    <Input
                      id="frp-tunnel-server-name"
                      value={serverName}
                      spellCheck={false}
                      aria-invalid={errors.serverName ? true : undefined}
                      onChange={(event) => setServerName(event.target.value)}
                    />
                    <FieldError message={errors.serverName} />
                  </div>
                )}
              </div>
            </>
          )}

          <div className="flex items-center justify-between gap-3">
            <Label htmlFor="frp-tunnel-enabled">{t("frp.tunnelForm.enabled")}</Label>
            <Switch id="frp-tunnel-enabled" checked={enabled} onCheckedChange={setEnabled} />
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => onOpenChange(false)}
            >
              {t("frp.common.cancel")}
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? <Loader2 className="animate-spin" /> : <Save />}
              {t("frp.common.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
