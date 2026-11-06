import { useEffect, useState, type FormEvent } from "react";
import { open as pickFile } from "@tauri-apps/plugin-dialog";
import { Eye, EyeOff, FolderOpen, Loader2, PlugZap, Save } from "lucide-react";
import { toast } from "sonner";
import { dbSourceTest, databaseErrorCode, defaultPort, emptyDataSource } from "@/commands";
import type { DataSource, DbColor, DbDriver, DbSslMode } from "@/commands";
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
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { vendorById, vendorOptions, vendorUrlPrefix } from "./vendors";

const DRIVERS: DbDriver[] = ["sqlite", "postgres", "mysql", "sqlServer", "clickhouse", "oracle"];
const SSL_MODES: DbSslMode[] = ["disable", "prefer", "require", "verifyCa", "verifyFull"];
const COLORS: DbColor[] = ["red", "orange", "yellow", "green", "blue", "violet"];

/** The vendor select's value when no preset is picked. Never stored. */
const CUSTOM_VENDOR = "custom";

type FieldName = "name" | "file" | "port" | "url";

type FieldErrors = Partial<Record<FieldName, string>>;

export type SourceDialogProps = {
  open: boolean;
  /** `null` creates a new data source; a data source edits that one in place. */
  source: DataSource | null;
  /** Whether a project is open: project-scoped sources need one. */
  hasProject: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Saves the edited data source and the password typed, if any. It rejects
   * when the save fails; the dialog then stays open with the input intact.
   */
  onSaved: (source: DataSource, password: string) => Promise<void>;
};

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return <p className="text-destructive text-xs">{message}</p>;
}

/**
 * Create / edit dialog for a data source.
 *
 * The password is not part of the data source: it is handed to `onSaved`
 * separately and stored by the caller through `db_set_password`, either for the
 * session only or in the saved passwords. An empty field on an edit leaves the
 * stored password alone.
 */
export function SourceDialog({
  open,
  source,
  hasProject,
  onOpenChange,
  onSaved,
}: SourceDialogProps) {
  const { t } = useAppTranslation();

  const [draft, setDraft] = useState<DataSource>(() => emptyDataSource());
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [portText, setPortText] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);

  // Reset only when the dialog opens: a parent refresh while it stands must not
  // wipe what the user is typing.
  useEffect(() => {
    if (!open) return;
    const next = source ? structuredClone(source) : emptyDataSource();
    // A project-scoped source needs an open project; default to the app-wide
    // list when there is none, so a first data source can always be saved.
    if (!source && !hasProject) next.global = true;
    setDraft(next);
    setPassword("");
    setShowPassword(false);
    setPortText(next.port === null ? "" : String(next.port));
    setErrors({});
    setBusy(false);
    setTesting(false);
    // `source` is read here on purpose but keyed on its id: a parent refresh
    // hands over a new object with the same id and must not reset the draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, source?.id, hasProject]);

  const update = (patch: Partial<DataSource>) => setDraft((current) => ({ ...current, ...patch }));

  const changeDriver = (driver: DbDriver) => {
    const previousDefault = defaultPort(draft.driver);
    const nextDefault = defaultPort(driver);
    // Follow the port to the new driver's default, unless it was set by hand.
    const port = draft.port === null || draft.port === previousDefault ? nextDefault : draft.port;
    // A preset belongs to one driver: another driver makes it stale.
    update({ driver, port, vendor: "", urlOnly: driver === "sqlite" ? false : draft.urlOnly });
    setPortText(port === null ? "" : String(port));
  };

  /**
   * Applies a vendor preset: its driver, port, SSL requirement and URL scheme.
   * Only defaults are written — the host, database and user the user typed stay,
   * and so does a port or URL that no longer matches the last preset.
   */
  const changeVendor = (id: string) => {
    if (id === CUSTOM_VENDOR) {
      update({ vendor: "" });
      return;
    }
    const vendor = vendorById(id);
    if (!vendor) return;

    const previous = vendorById(draft.vendor);
    const previousPort = previous?.port ?? defaultPort(draft.driver);
    const port = draft.port === null || draft.port === previousPort ? vendor.port : draft.port;
    const previousPrefix = previous ? vendorUrlPrefix(previous) : "";
    const typedUrl = draft.url.trim();
    const url = typedUrl && typedUrl !== previousPrefix ? draft.url : vendorUrlPrefix(vendor);
    const patch: Partial<DataSource> = {
      vendor: vendor.id,
      driver: vendor.driver,
      port,
      urlOnly: true,
      url,
    };
    if (vendor.ssl) patch.ssl = vendor.ssl;
    update(patch);
    setPortText(port === null ? "" : String(port));
  };

  const describeFailure = (failure: unknown) => {
    const code = databaseErrorCode(failure);
    if (code) {
      const key = `database.error.${code}`;
      return t(key, { defaultValue: (failure as { message: string }).message });
    }
    return failure instanceof Error ? failure.message : String(failure);
  };

  /** The data source as typed, or `null` when a field is invalid. */
  const validated = (): DataSource | null => {
    const next: FieldErrors = {};
    if (!draft.name.trim()) next.name = t("database.form.validation.nameRequired");
    if (draft.driver === "sqlite" && !draft.urlOnly && !draft.file?.trim()) {
      next.file = t("database.form.validation.fileRequired");
    }
    if (draft.driver !== "sqlite" && draft.urlOnly && !draft.url.trim()) {
      next.url = t("database.form.validation.urlRequired");
    }
    if (draft.driver !== "sqlite" && !draft.urlOnly) {
      const port = portText.trim();
      const parsed = Number(port);
      if (port && (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535)) {
        next.port = t("database.form.validation.portInvalid");
      }
    }
    setErrors(next);
    if (Object.keys(next).length > 0) return null;

    return {
      ...draft,
      name: draft.name.trim(),
      host: draft.host.trim(),
      database: draft.database.trim(),
      user: draft.user.trim(),
      file: draft.file?.trim() ? draft.file.trim() : null,
      url: draft.url.trim(),
      port: portText.trim() ? Number(portText.trim()) : null,
    };
  };

  const browseFile = async () => {
    try {
      const picked = await pickFile({
        title: t("database.form.file"),
        multiple: false,
        directory: false,
      });
      if (typeof picked === "string") update({ file: picked });
    } catch (failure) {
      toast.error(describeFailure(failure));
    }
  };

  const test = async () => {
    const candidate = validated();
    if (!candidate || testing) return;
    setTesting(true);
    try {
      const version = await dbSourceTest(candidate, password || null);
      toast.success(
        t("database.test.success", { version, defaultValue: "Connected: {{version}}" })
      );
    } catch (failure) {
      toast.error(
        t("database.test.failed", {
          error: describeFailure(failure),
          defaultValue: "Could not connect: {{error}}",
        })
      );
    } finally {
      setTesting(false);
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const candidate = validated();
    if (!candidate) return;
    setBusy(true);
    try {
      await onSaved(candidate, password);
      setBusy(false);
      onOpenChange(false);
    } catch {
      // The caller reports the failure; keeping the dialog open keeps the input.
      setBusy(false);
    }
  };

  const editing = source !== null;
  const sqlite = draft.driver === "sqlite";
  // An unknown vendor id (a preset dropped since the source was saved) reads as
  // a custom setup; the stored value is left alone until the user picks one.
  const vendorValue = vendorById(draft.vendor)?.id ?? CUSTOM_VENDOR;

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {editing
              ? t("database.form.editTitle", { defaultValue: "Edit data source" })
              : t("database.form.createTitle", { defaultValue: "Add data source" })}
          </DialogTitle>
          <DialogDescription>
            {t("database.form.description", {
              defaultValue:
                "Settings are stored in the data directory. The password is only stored when you ask for it.",
            })}
          </DialogDescription>
        </DialogHeader>

        <form className="flex flex-col gap-4" onSubmit={(event) => void submit(event)}>
          <div className="grid grid-cols-[1fr_10rem] gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="database-form-name">{t("database.form.name")}</Label>
              <Input
                id="database-form-name"
                value={draft.name}
                aria-invalid={errors.name ? true : undefined}
                onChange={(event) => update({ name: event.target.value })}
                placeholder={t("database.form.namePlaceholder", {
                  defaultValue: "Local shop database",
                })}
                autoFocus
              />
              <FieldError message={errors.name} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="database-form-driver">{t("database.form.driver")}</Label>
              <Select
                value={draft.driver}
                onValueChange={(value) => changeDriver(value as DbDriver)}
              >
                <SelectTrigger id="database-form-driver" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DRIVERS.map((driver) => (
                    <SelectItem key={driver} value={driver}>
                      {t(`database.driver.${driver}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="database-form-vendor">{t("database.form.vendor")}</Label>
            <Select value={vendorValue} onValueChange={changeVendor}>
              <SelectTrigger id="database-form-vendor" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={CUSTOM_VENDOR}>{t("database.form.vendorCustom")}</SelectItem>
                {vendorOptions().map((vendor) => (
                  <SelectItem key={vendor.id} value={vendor.id}>
                    {vendor.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-muted-foreground text-xs">{t("database.form.vendorHint")}</p>
          </div>

          <div className="flex items-center justify-between gap-4">
            <div className="space-y-1">
              <Label htmlFor="database-form-global">{t("database.form.scope")}</Label>
              <p className="text-muted-foreground text-xs">
                {draft.global
                  ? t("database.form.scopeGlobalHint", {
                      defaultValue: "Listed in every project.",
                    })
                  : hasProject
                    ? t("database.form.scopeProjectHint", {
                        defaultValue: "Listed only in the project that is open.",
                      })
                    : t("database.form.scopeNeedsProject", {
                        defaultValue: "No project is open, so this data source is app-wide.",
                      })}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-sm">
                {draft.global ? t("database.list.global") : t("database.list.project")}
              </span>
              <Switch
                id="database-form-global"
                checked={draft.global}
                disabled={!hasProject}
                onCheckedChange={(checked) => update({ global: checked })}
              />
            </div>
          </div>

          <Separator />

          {sqlite ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="database-form-file">{t("database.form.file")}</Label>
              <div className="flex gap-2">
                <Input
                  id="database-form-file"
                  value={draft.file ?? ""}
                  aria-invalid={errors.file ? true : undefined}
                  onChange={(event) => update({ file: event.target.value })}
                  placeholder="data/shop.db"
                  spellCheck={false}
                />
                <Button
                  type="button"
                  variant="secondary"
                  aria-label={t("database.form.fileBrowse", { defaultValue: "Browse" })}
                  title={t("database.form.fileBrowse", { defaultValue: "Browse" })}
                  onClick={() => void browseFile()}
                >
                  <FolderOpen />
                </Button>
              </div>
              <p className="text-muted-foreground text-xs">
                {t("database.form.fileHint", {
                  defaultValue: "A relative path resolves against the project root.",
                })}
              </p>
              <FieldError message={errors.file} />
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between gap-4">
                <Label htmlFor="database-form-url-only">{t("database.form.urlOnly")}</Label>
                <Switch
                  id="database-form-url-only"
                  checked={draft.urlOnly}
                  onCheckedChange={(checked) => update({ urlOnly: checked })}
                />
              </div>

              {draft.urlOnly ? (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="database-form-url">{t("database.form.url")}</Label>
                  <Textarea
                    id="database-form-url"
                    rows={3}
                    className="font-mono text-xs"
                    value={draft.url}
                    aria-invalid={errors.url ? true : undefined}
                    onChange={(event) => update({ url: event.target.value })}
                    placeholder={t("database.form.urlPlaceholder", {
                      defaultValue: "postgres://user:password@host:5432/database",
                    })}
                    spellCheck={false}
                  />
                  <FieldError message={errors.url} />
                </div>
              ) : (
                <>
                  <div className="grid grid-cols-[1fr_7rem] gap-3">
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="database-form-host">{t("database.form.host")}</Label>
                      <Input
                        id="database-form-host"
                        value={draft.host}
                        onChange={(event) => update({ host: event.target.value })}
                        placeholder="localhost"
                        spellCheck={false}
                      />
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="database-form-port">{t("database.form.port")}</Label>
                      <Input
                        id="database-form-port"
                        value={portText}
                        inputMode="numeric"
                        aria-invalid={errors.port ? true : undefined}
                        onChange={(event) => setPortText(event.target.value.replace(/[^0-9]/g, ""))}
                        placeholder={String(defaultPort(draft.driver) ?? "")}
                      />
                      <FieldError message={errors.port} />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="database-form-database">{t("database.form.database")}</Label>
                      <Input
                        id="database-form-database"
                        value={draft.database}
                        onChange={(event) => update({ database: event.target.value })}
                        spellCheck={false}
                      />
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="database-form-user">{t("database.form.user")}</Label>
                      <Input
                        id="database-form-user"
                        value={draft.user}
                        onChange={(event) => update({ user: event.target.value })}
                        spellCheck={false}
                      />
                    </div>
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="database-form-ssl">{t("database.form.sslMode")}</Label>
                    <Select
                      value={draft.ssl}
                      onValueChange={(value) => update({ ssl: value as DbSslMode })}
                    >
                      <SelectTrigger id="database-form-ssl" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {SSL_MODES.map((mode) => (
                          <SelectItem key={mode} value={mode}>
                            {t(`database.ssl.${mode}`)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </>
              )}

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="database-form-password">{t("database.form.password")}</Label>
                <div className="relative">
                  <Input
                    id="database-form-password"
                    type={showPassword ? "text" : "password"}
                    value={password}
                    autoComplete="new-password"
                    className="pr-10"
                    onChange={(event) => setPassword(event.target.value)}
                    placeholder={
                      draft.savePassword
                        ? t("database.form.passwordSaved", { defaultValue: "Stored password" })
                        : undefined
                    }
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="absolute top-1/2 right-1.5 -translate-y-1/2"
                    aria-label={
                      showPassword
                        ? t("database.form.hidePassword", { defaultValue: "Hide password" })
                        : t("database.form.showPassword", { defaultValue: "Show password" })
                    }
                    onClick={() => setShowPassword((current) => !current)}
                  >
                    {showPassword ? <EyeOff /> : <Eye />}
                  </Button>
                </div>
                <div className="flex items-center gap-2">
                  <Switch
                    id="database-form-save-password"
                    checked={draft.savePassword}
                    onCheckedChange={(checked) => update({ savePassword: checked })}
                  />
                  <Label htmlFor="database-form-save-password" className="text-sm font-normal">
                    {t("database.form.savePassword")}
                  </Label>
                </div>
                <p className="text-muted-foreground text-xs">
                  {t("database.form.savePasswordHint", {
                    defaultValue:
                      "Without this, the password is kept in memory for this session only.",
                  })}
                </p>
              </div>
            </>
          )}

          <Separator />

          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="database-form-color">{t("database.form.color")}</Label>
              <Select
                value={draft.color ?? "none"}
                onValueChange={(value) =>
                  update({ color: value === "none" ? null : (value as DbColor) })
                }
              >
                <SelectTrigger id="database-form-color" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{t("database.color.none")}</SelectItem>
                  {COLORS.map((color) => (
                    <SelectItem key={color} value={color}>
                      {t(`database.color.${color}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col justify-end gap-2">
              <div className="flex items-center gap-2">
                <Switch
                  id="database-form-read-only"
                  checked={draft.readOnly}
                  onCheckedChange={(checked) => update({ readOnly: checked })}
                />
                <Label htmlFor="database-form-read-only" className="text-sm font-normal">
                  {t("database.form.readOnly")}
                </Label>
              </div>
              <div className="flex items-center gap-2">
                <Switch
                  id="database-form-manual-commit"
                  checked={draft.options.transaction === "manual"}
                  onCheckedChange={(checked) =>
                    update({
                      options: {
                        ...draft.options,
                        transaction: checked ? "manual" : "auto",
                      },
                    })
                  }
                />
                <Label htmlFor="database-form-manual-commit" className="text-sm font-normal">
                  {t("database.form.manualCommit")}
                </Label>
              </div>
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="database-form-comment">{t("database.form.comment")}</Label>
            <Textarea
              id="database-form-comment"
              rows={2}
              value={draft.comment}
              onChange={(event) => update({ comment: event.target.value })}
            />
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={busy || testing}
              onClick={() => void test()}
            >
              {testing ? <Loader2 className="animate-spin" /> : <PlugZap />}
              {t("database.action.test")}
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => onOpenChange(false)}
            >
              {t("database.form.cancel")}
            </Button>
            <Button type="submit" disabled={busy || testing}>
              {busy ? <Loader2 className="animate-spin" /> : <Save />}
              {t("database.form.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
