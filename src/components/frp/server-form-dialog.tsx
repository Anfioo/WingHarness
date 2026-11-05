import { useEffect, useState, type FormEvent } from "react";
import { Eye, EyeOff, Loader2, Save } from "lucide-react";
import { toast } from "sonner";
import { frpProfileCreate, frpProfileUpdate } from "@/commands/services/frp";
import {
  frpErrorCode,
  isFrpError,
  type FrpProfile,
  type FrpProfileInput,
  type RuntimePolicy,
  type RuntimeView,
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
import { formatVersion, frpFailureKey } from "@/lib/frp/format";
import { cn } from "@/lib/utils";

const DEFAULT_PORT = 7000;
const NAME_MAX_LENGTH = 80;

type FieldName = "name" | "serverAddr" | "serverPort" | "token" | "runtime";

type FieldErrors = Partial<Record<FieldName, string>>;

const FIELD_VALIDATION_KEYS: Record<FieldName, string> = {
  name: "frp.serverForm.validation.name",
  serverAddr: "frp.serverForm.validation.serverAddr",
  serverPort: "frp.serverForm.validation.serverPort",
  token: "frp.error.invalidInput",
  runtime: "frp.serverForm.validation.runtime",
};

/** Maps the engine's `detail.field` onto this form's own fields. */
function backendField(error: unknown): FieldName | null {
  if (!isFrpError(error) || !error.detail) return null;
  const field = error.detail.field;
  if (typeof field !== "string") return null;
  switch (field) {
    case "name":
      return "name";
    case "serverAddr":
    case "server_addr":
      return "serverAddr";
    case "serverPort":
    case "server_port":
      return "serverPort";
    case "token":
      return "token";
    case "runtimeId":
    case "runtime_id":
    case "runtimePolicy":
    case "runtime_policy":
      return "runtime";
    default:
      return null;
  }
}

export type ServerFormDialogProps = {
  open: boolean;
  /** `null` creates a new profile; a profile edits that one in place. */
  profile: FrpProfile | null;
  runtimes: RuntimeView[];
  onOpenChange: (open: boolean) => void;
  onSaved: (profile: FrpProfile) => void;
};

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return <p className="text-destructive text-xs">{message}</p>;
}

/**
 * Create / edit dialog for a server profile.
 *
 * The token is stored in plain text in `frp.json` (plan §5.2), so the field is
 * a password input with a reveal button rather than a secret store. Validation
 * mirrors the engine's rules; when the engine still rejects an input, its
 * `detail.field` decides which field shows the message.
 */
export function ServerFormDialog({
  open,
  profile,
  runtimes,
  onOpenChange,
  onSaved,
}: ServerFormDialogProps) {
  const { t } = useAppTranslation();

  const [name, setName] = useState("");
  const [serverAddr, setServerAddr] = useState("");
  const [serverPort, setServerPort] = useState(String(DEFAULT_PORT));
  const [token, setToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [runtimePolicy, setRuntimePolicy] = useState<RuntimePolicy>("recommended");
  const [runtimeId, setRuntimeId] = useState<string | null>(null);
  const [reconnectEnabled, setReconnectEnabled] = useState(true);
  const [note, setNote] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});
  const [busy, setBusy] = useState(false);

  // Reset only when the dialog opens: a workspace refresh while the dialog
  // stands must not wipe what the user is typing.
  useEffect(() => {
    if (!open) return;
    setName(profile?.name ?? "");
    setServerAddr(profile?.serverAddr ?? "");
    setServerPort(String(profile?.serverPort ?? DEFAULT_PORT));
    setToken(profile?.token ?? "");
    setShowToken(false);
    setRuntimePolicy(profile?.runtimePolicy ?? "recommended");
    setRuntimeId(profile?.runtimeId ?? null);
    setReconnectEnabled(profile?.reconnectEnabled ?? true);
    setNote(profile?.note ?? "");
    setErrors({});
    setBusy(false);
    // Reset only when a different profile opens; a workspace refresh must not
    // overwrite the fields the user is editing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, profile?.id]);

  const describeFailure = (error: unknown): string => {
    const key = frpFailureKey(error);
    const message = isFrpError(error) ? error.message.trim() : "";
    if (!key) return message || String(error);
    return message ? `${t(key)}: ${message}` : t(key);
  };

  const validate = (): boolean => {
    const next: FieldErrors = {};
    const trimmedName = name.trim();
    if (!trimmedName || [...trimmedName].length > NAME_MAX_LENGTH) {
      next.name = t(FIELD_VALIDATION_KEYS.name);
    }

    const trimmedAddr = serverAddr.trim();
    if (!trimmedAddr || /^https?:\/\//i.test(trimmedAddr)) {
      next.serverAddr = t(FIELD_VALIDATION_KEYS.serverAddr);
    }

    const parsedPort = Number(serverPort.trim());
    if (
      !serverPort.trim() ||
      !Number.isInteger(parsedPort) ||
      parsedPort < 1 ||
      parsedPort > 65535
    ) {
      next.serverPort = t(FIELD_VALIDATION_KEYS.serverPort);
    }

    if (runtimePolicy === "pinned" && !runtimeId) {
      next.runtime = t(FIELD_VALIDATION_KEYS.runtime);
    }

    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (!validate()) return;

    const input: FrpProfileInput = {
      name: name.trim(),
      serverAddr: serverAddr.trim(),
      serverPort: Number(serverPort.trim()),
      token: token.trim() ? token : null,
      runtimePolicy,
      runtimeId: runtimePolicy === "pinned" ? runtimeId : null,
      reconnectEnabled,
      note: note.trim(),
    };

    setBusy(true);
    try {
      const saved = profile
        ? await frpProfileUpdate(profile.id, input)
        : await frpProfileCreate(input);
      setBusy(false);
      onSaved(saved);
      onOpenChange(false);
    } catch (error) {
      const field = backendField(error);
      if (field) {
        const conflict = frpErrorCode(error) === "conflict";
        setErrors((current) => ({
          ...current,
          [field]:
            conflict && field === "name"
              ? t("frp.serverForm.validation.nameTaken")
              : t(FIELD_VALIDATION_KEYS[field]),
        }));
      } else {
        toast.error(describeFailure(error));
      }
      setBusy(false);
    }
  };

  const editing = profile !== null;

  const changeRuntimePolicy = (value: RuntimePolicy) => {
    setRuntimePolicy(value);
    if (value === "pinned" && !runtimeId) setRuntimeId(runtimes[0]?.id ?? null);
    if (value === "recommended") setRuntimeId(null);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {editing ? t("frp.serverForm.titleEdit") : t("frp.serverForm.titleCreate")}
          </DialogTitle>
        </DialogHeader>

        <form className="flex flex-col gap-4" onSubmit={(event) => void submit(event)}>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="frp-profile-name">{t("frp.serverForm.name")}</Label>
            <Input
              id="frp-profile-name"
              value={name}
              aria-invalid={errors.name ? true : undefined}
              onChange={(event) => setName(event.target.value)}
              autoFocus
            />
            <FieldError message={errors.name} />
          </div>

          <div className="grid grid-cols-[1fr_7rem] gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="frp-profile-addr">{t("frp.serverForm.serverAddr")}</Label>
              <Input
                id="frp-profile-addr"
                value={serverAddr}
                aria-invalid={errors.serverAddr ? true : undefined}
                onChange={(event) => setServerAddr(event.target.value)}
                placeholder="frps.example.com"
                spellCheck={false}
              />
              <FieldError message={errors.serverAddr} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="frp-profile-port">{t("frp.serverForm.serverPort")}</Label>
              <Input
                id="frp-profile-port"
                value={serverPort}
                inputMode="numeric"
                aria-invalid={errors.serverPort ? true : undefined}
                onChange={(event) => setServerPort(event.target.value.replace(/[^0-9]/g, ""))}
              />
              <FieldError message={errors.serverPort} />
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="frp-profile-token">{t("frp.serverForm.token")}</Label>
            <div className="relative">
              <Input
                id="frp-profile-token"
                type={showToken ? "text" : "password"}
                value={token}
                autoComplete="new-password"
                className="pr-10"
                aria-invalid={errors.token ? true : undefined}
                onChange={(event) => setToken(event.target.value)}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="absolute top-1/2 right-1.5 -translate-y-1/2"
                aria-label={
                  showToken ? t("frp.serverForm.hideToken") : t("frp.serverForm.showToken")
                }
                title={showToken ? t("frp.serverForm.hideToken") : t("frp.serverForm.showToken")}
                onClick={() => setShowToken((current) => !current)}
              >
                {showToken ? <EyeOff /> : <Eye />}
              </Button>
            </div>
            <FieldError message={errors.token} />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="frp-profile-runtime-policy">{t("frp.serverForm.runtimePolicy")}</Label>
            <Select
              value={runtimePolicy}
              onValueChange={(value) => changeRuntimePolicy(value as RuntimePolicy)}
            >
              <SelectTrigger id="frp-profile-runtime-policy" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="recommended">
                  {t("frp.serverForm.runtimeRecommended")}
                </SelectItem>
                <SelectItem value="pinned">{t("frp.serverForm.runtimePinned")}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {runtimePolicy === "pinned" && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="frp-profile-runtime">{t("frp.serverForm.runtime")}</Label>
              {runtimes.length === 0 ? (
                <p className="text-muted-foreground text-xs">{t("frp.serverForm.runtimeEmpty")}</p>
              ) : (
                <Select value={runtimeId ?? ""} onValueChange={(value) => setRuntimeId(value)}>
                  <SelectTrigger
                    id="frp-profile-runtime"
                    className={cn("w-full", errors.runtime && "border-destructive")}
                  >
                    <SelectValue placeholder={t("frp.serverForm.runtimePlaceholder")} />
                  </SelectTrigger>
                  <SelectContent>
                    {runtimes.map((runtime) => (
                      <SelectItem key={runtime.id} value={runtime.id}>
                        {formatVersion(runtime.version)} · {runtime.platform}/{runtime.architecture}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <FieldError message={errors.runtime} />
            </div>
          )}

          <div className="flex items-center justify-between gap-3">
            <Label htmlFor="frp-profile-reconnect">{t("frp.serverForm.reconnect")}</Label>
            <Switch
              id="frp-profile-reconnect"
              checked={reconnectEnabled}
              onCheckedChange={setReconnectEnabled}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="frp-profile-note">{t("frp.serverForm.note")}</Label>
            <Textarea
              id="frp-profile-note"
              rows={3}
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
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
