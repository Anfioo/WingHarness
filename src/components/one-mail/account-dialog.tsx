// Part of the one-mail module, adapted from OneMail
// (https://github.com/zhihui-hu/one-mail), AGPL-3.0-only.
// See `src-tauri/one-mail-core/UPSTREAM.md` for the porting record.

import { Check, FolderSearch, Loader2, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";
import {
  oneMailAccountCreate,
  oneMailAccountRemove,
  oneMailAccountTest,
  oneMailAccountUpdate,
  oneMailErrorCode,
  oneMailFoldersDiscover,
  oneMailFoldersList,
  oneMailFoldersSetSync,
  oneMailProvidersList,
  type AccountSummary,
  type AccountTestInput,
  type AccountUpdateInput,
  type ConnectionTestResult,
  type FolderCandidate,
  type FolderDiscoveryInput,
  type MailFolder,
  type OneMailAuthKind,
  type ProviderPreset,
  type Security,
} from "@/commands";
import FolderSelector from "@/components/one-mail/folder-selector";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { oneMailErrorKey } from "@/lib/one-mail/error-key";
import { cn } from "@/lib/utils";
import { useOneMailPageContext } from "@/pages/one-mail/context";

const CUSTOM_PROVIDER = "custom";
const EMAIL_PATTERN = /^[^\s@<>(),;]+@[^\s@<>(),;]+\.[^\s@<>(),;]+$/;
/**
 * The encryption choices. `SSL/TLS` and `STARTTLS` are protocol names and read
 * the same in both languages; only the "none" option needs a translation.
 */
const SECURITY_OPTIONS: { value: Security; label?: string; labelKey?: string }[] = [
  { value: "ssl_tls", label: "SSL/TLS" },
  { value: "starttls", label: "STARTTLS" },
  { value: "none", labelKey: "oneMail.accountForm.securityNone" },
];

const CONNECTION_FIELDS = new Set<keyof AccountForm>([
  "providerKey",
  "email",
  "password",
  "authType",
  "imapHost",
  "imapPort",
  "imapSecurity",
]);

type AccountForm = {
  providerKey: string;
  email: string;
  displayName: string;
  accountLabel: string;
  password: string;
  authType: OneMailAuthKind;
  imapHost: string;
  imapPort: string;
  imapSecurity: Security;
  smtpEnabled: boolean;
  smtpHost: string;
  smtpPort: string;
  smtpSecurity: Security;
  smtpAuthType: OneMailAuthKind | null;
  syncEnabled: boolean;
};

type FormErrors = Partial<
  Record<"email" | "imapHost" | "imapPort" | "smtpHost" | "smtpPort" | "password", string>
>;

type BusyState = "test" | "discover" | "save" | null;

function emptyForm(): AccountForm {
  return {
    providerKey: CUSTOM_PROVIDER,
    email: "",
    displayName: "",
    accountLabel: "",
    password: "",
    authType: "password",
    imapHost: "",
    imapPort: "993",
    imapSecurity: "ssl_tls",
    smtpEnabled: true,
    smtpHost: "",
    smtpPort: "465",
    smtpSecurity: "ssl_tls",
    smtpAuthType: null,
    syncEnabled: true,
  };
}

function formFromAccount(account: AccountSummary): AccountForm {
  return {
    providerKey: account.providerKey,
    email: account.email,
    displayName: account.displayName ?? "",
    accountLabel: account.accountLabel,
    // Never read the stored password back: an empty box means "keep it".
    password: "",
    authType: account.authType,
    imapHost: account.imapHost,
    imapPort: String(account.imapPort),
    imapSecurity: account.imapSecurity,
    smtpEnabled: account.smtpEnabled,
    smtpHost: account.smtpHost ?? "",
    smtpPort: account.smtpPort !== null ? String(account.smtpPort) : "",
    smtpSecurity: account.smtpSecurity ?? "ssl_tls",
    smtpAuthType: account.smtpAuthType,
    syncEnabled: account.syncEnabled,
  };
}

function folderCandidate(folder: MailFolder): FolderCandidate {
  return {
    path: folder.path,
    name: folder.name,
    delimiter: null,
    role: folder.role,
    selectable: folder.selectable,
  };
}

function trimmedOrNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function validPort(value: string): boolean {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535;
}

function validate(form: AccountForm, editing: boolean): FormErrors {
  const errors: FormErrors = {};

  if (!EMAIL_PATTERN.test(form.email.trim())) errors.email = "emailInvalid";
  if (form.imapHost.trim() === "") errors.imapHost = "hostRequired";
  if (!validPort(form.imapPort)) errors.imapPort = "portRange";
  if (form.smtpEnabled) {
    if (form.smtpHost.trim() === "") errors.smtpHost = "hostRequired";
    if (!validPort(form.smtpPort)) errors.smtpPort = "portRange";
  }
  if (!editing && form.password === "") errors.password = "passwordRequired";

  return errors;
}

function toCreateInput(form: AccountForm) {
  return {
    providerKey: form.providerKey,
    email: form.email.trim(),
    displayName: trimmedOrNull(form.displayName),
    accountLabel: trimmedOrNull(form.accountLabel),
    authType: form.authType,
    imapHost: form.imapHost.trim(),
    imapPort: Number(form.imapPort),
    imapSecurity: form.imapSecurity,
    smtpEnabled: form.smtpEnabled,
    smtpHost: form.smtpEnabled ? trimmedOrNull(form.smtpHost) : null,
    smtpPort: form.smtpEnabled ? Number(form.smtpPort) : null,
    smtpSecurity: form.smtpEnabled ? form.smtpSecurity : null,
    smtpAuthType: form.smtpAuthType,
    password: form.password,
    syncEnabled: form.syncEnabled,
  };
}

function toUpdateInput(form: AccountForm, accountId: number): AccountUpdateInput {
  return {
    accountId,
    displayName: trimmedOrNull(form.displayName),
    accountLabel: trimmedOrNull(form.accountLabel),
    imapHost: form.imapHost.trim(),
    imapPort: Number(form.imapPort),
    imapSecurity: form.imapSecurity,
    smtpEnabled: form.smtpEnabled,
    smtpHost: form.smtpEnabled ? trimmedOrNull(form.smtpHost) : null,
    smtpPort: form.smtpEnabled ? Number(form.smtpPort) : null,
    smtpSecurity: form.smtpEnabled ? form.smtpSecurity : null,
    smtpAuthType: form.smtpAuthType,
    // An empty box keeps the stored password; the backend treats "" as invalid.
    password: form.password === "" ? null : form.password,
    syncEnabled: form.syncEnabled,
  };
}

function toTestInput(form: AccountForm): AccountTestInput {
  return {
    providerKey: form.providerKey,
    email: form.email.trim(),
    authType: form.authType,
    imapHost: form.imapHost.trim(),
    imapPort: Number(form.imapPort),
    imapSecurity: form.imapSecurity,
    smtpEnabled: form.smtpEnabled,
    smtpHost: form.smtpEnabled ? trimmedOrNull(form.smtpHost) : null,
    smtpPort: form.smtpEnabled ? Number(form.smtpPort) : null,
    smtpSecurity: form.smtpEnabled ? form.smtpSecurity : null,
    smtpAuthType: form.smtpAuthType,
    password: form.password,
  };
}

function toDiscoveryInput(form: AccountForm): FolderDiscoveryInput {
  return {
    providerKey: form.providerKey,
    email: form.email.trim(),
    authType: form.authType,
    imapHost: form.imapHost.trim(),
    imapPort: Number(form.imapPort),
    imapSecurity: form.imapSecurity,
    password: form.password,
  };
}

/**
 * The add/edit account overlay.
 *
 * A provider preset only fills the connection fields; the folder check list is
 * filled by a successful connection test, so the user never types a folder path
 * and never sees a list the server has not confirmed.
 */
export default function AccountDialog() {
  const page = useOneMailPageContext();
  const { t } = useAppTranslation();
  const dialog = page.accountDialog;
  const editing = dialog.editing;

  const [providers, setProviders] = useState<ProviderPreset[]>([]);
  const [providersLoading, setProvidersLoading] = useState(false);
  const [form, setForm] = useState<AccountForm>(emptyForm);
  const [errors, setErrors] = useState<FormErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState<BusyState>(null);
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null);
  const [candidates, setCandidates] = useState<FolderCandidate[]>([]);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [discovered, setDiscovered] = useState(false);
  const [foldersTouched, setFoldersTouched] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const loadProviders = useCallback(async () => {
    setProvidersLoading(true);
    try {
      setProviders(await oneMailProvidersList());
    } catch (failure) {
      toast.error(t(oneMailErrorKey(oneMailErrorCode(failure))));
    } finally {
      setProvidersLoading(false);
    }
  }, [t]);

  // Every open starts from a clean form, so a failed save never leaks into the
  // next account the user edits.
  useEffect(() => {
    if (!dialog.open) return;
    let cancelled = false;

    setForm(editing ? formFromAccount(editing) : emptyForm());
    setErrors({});
    setFormError(null);
    setBusy(null);
    setTestResult(null);
    setCandidates([]);
    setSelectedPaths(new Set());
    setDiscovered(false);
    setFoldersTouched(false);
    setDeleteOpen(false);

    if (providers.length === 0) {
      void loadProviders();
    }

    if (editing) {
      void oneMailFoldersList(editing.accountId)
        .then((folders) => {
          if (cancelled) return;
          setCandidates(folders.map(folderCandidate));
          setSelectedPaths(
            new Set(folders.filter((folder) => folder.syncEnabled).map((folder) => folder.path))
          );
        })
        .catch(() => undefined);
    }

    return () => {
      cancelled = true;
    };
    // `providers` only decides whether to fetch, and the copy must not reset on
    // a language change that swaps the translator's identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dialog.open, editing]);

  const preset = providers.find((item) => item.key === form.providerKey) ?? null;
  const presetOptions =
    preset || form.providerKey === CUSTOM_PROVIDER
      ? providers
      : [
          ...providers,
          {
            key: form.providerKey,
            displayName: form.providerKey,
          } as ProviderPreset,
        ];

  const clearTestState = () => {
    setTestResult(null);
    setCandidates([]);
    setDiscovered(false);
    setFoldersTouched(false);
  };

  const patch = (values: Partial<AccountForm>) => {
    setForm((current) => ({ ...current, ...values }));
    if (Object.keys(values).some((key) => CONNECTION_FIELDS.has(key as keyof AccountForm))) {
      clearTestState();
    }
  };

  const applyProvider = (key: string) => {
    const chosen = providers.find((item) => item.key === key);
    if (!chosen) {
      setForm((current) => ({ ...current, providerKey: key }));
      return;
    }
    setForm((current) => ({
      ...current,
      providerKey: key,
      authType: chosen.authType,
      imapHost: chosen.imapHost,
      imapPort: String(chosen.imapPort),
      imapSecurity: chosen.imapSecurity,
      smtpEnabled: chosen.smtpHost !== null,
      smtpHost: chosen.smtpHost ?? "",
      smtpPort: chosen.smtpPort !== null ? String(chosen.smtpPort) : "",
      smtpSecurity: chosen.smtpSecurity ?? "ssl_tls",
      smtpAuthType: chosen.smtpAuthType,
    }));
    clearTestState();
  };

  const showError = (failure: unknown) => {
    toast.error(t(oneMailErrorKey(oneMailErrorCode(failure))));
  };

  const runTest = async () => {
    const nextErrors = validate(form, editing !== null);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    setBusy("test");
    setFormError(null);
    try {
      const result = await oneMailAccountTest(toTestInput(form));
      setTestResult(result);
      if (!result.imapOk) setCandidates([]);
    } catch (failure) {
      showError(failure);
    } finally {
      setBusy(null);
    }
  };

  const discoverFolders = async () => {
    if (!testResult?.imapOk) return;

    setBusy("discover");
    setFormError(null);
    try {
      const folders = await oneMailFoldersDiscover(toDiscoveryInput(form));
      const selectable = folders.filter((folder) => folder.selectable || folder.role === "inbox");
      setCandidates(selectable);
      // A first discovery selects every folder the server offers; a refresh
      // keeps what the user had already checked (plus the locked inboxes).
      setSelectedPaths((current) => {
        if (current.size === 0) return new Set(selectable.map((folder) => folder.path));
        const next = new Set<string>();
        for (const folder of selectable) {
          if (folder.role === "inbox" || current.has(folder.path)) next.add(folder.path);
        }
        return next;
      });
      setDiscovered(true);
      setFoldersTouched(true);
    } catch (failure) {
      showError(failure);
    } finally {
      setBusy(null);
    }
  };

  /** Persist the checked paths once the account exists and has folder ids. */
  const applyFolderSelection = async (accountId: number) => {
    if (!foldersTouched) return;
    try {
      const folders = await oneMailFoldersList(accountId);
      const wanted = new Set(selectedPaths);
      const ids = folders
        .filter((folder) => folder.role === "inbox" || wanted.has(folder.path))
        .map((folder) => folder.folderId);
      if (ids.length > 0) await oneMailFoldersSetSync(accountId, ids);
    } catch (failure) {
      // The account itself was saved; a folder failure must not hide that.
      showError(failure);
    }
  };

  const save = async () => {
    const nextErrors = validate(form, editing !== null);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    setBusy("save");
    setFormError(null);
    try {
      const account = editing
        ? await oneMailAccountUpdate(toUpdateInput(form, editing.accountId))
        : await oneMailAccountCreate(toCreateInput(form));
      await applyFolderSelection(account.accountId);
      await page.reloadAccounts();
      dialog.close();
    } catch (failure) {
      setFormError(t(oneMailErrorKey(oneMailErrorCode(failure))));
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (!editing) return;
    setDeleteOpen(false);
    setBusy("save");
    try {
      await oneMailAccountRemove(editing.accountId);
      await page.reloadAccounts();
      dialog.close();
    } catch (failure) {
      showError(failure);
    } finally {
      setBusy(null);
    }
  };

  const disabled = busy !== null;
  const passwordRequiredForTest = editing !== null && form.password === "";
  const testDisabled = disabled || passwordRequiredForTest || providersLoading;
  const discoveryReady = !disabled && Boolean(testResult?.imapOk);
  const folderCount = candidates.length;

  return (
    <>
      <Dialog
        open={dialog.open}
        onOpenChange={(open) => {
          if (!open && !disabled) dialog.close();
        }}
      >
        <DialogContent
          showCloseButton={!disabled}
          className="grid max-h-[85vh] grid-rows-[auto_minmax(0,1fr)_auto] gap-0 p-0 sm:max-w-2xl"
        >
          <DialogHeader className="border-b px-4 py-3 pr-12">
            <DialogTitle className="text-base">
              {editing ? t("oneMail.accounts.edit") : t("oneMail.accounts.add")}
            </DialogTitle>
            <DialogDescription className={editing ? "text-xs" : "sr-only"}>
              {editing ? editing.email : t("oneMail.accounts.add")}
            </DialogDescription>
          </DialogHeader>

          <div className="min-h-0 space-y-3 overflow-y-auto px-4 py-3">
            <Field label={t("oneMail.accountForm.provider")} htmlFor="one-mail-account-provider">
              <Select
                value={form.providerKey}
                disabled={disabled || providersLoading || editing !== null}
                onValueChange={applyProvider}
              >
                <SelectTrigger id="one-mail-account-provider" className="w-full">
                  <SelectValue placeholder={t("oneMail.common.loading")} />
                </SelectTrigger>
                <SelectContent>
                  {presetOptions.map((option) => (
                    <SelectItem key={option.key} value={option.key}>
                      {option.key === CUSTOM_PROVIDER
                        ? t("oneMail.accountForm.custom")
                        : option.displayName}
                    </SelectItem>
                  ))}
                  {!presetOptions.some((option) => option.key === CUSTOM_PROVIDER) && (
                    <SelectItem value={CUSTOM_PROVIDER}>
                      {t("oneMail.accountForm.custom")}
                    </SelectItem>
                  )}
                </SelectContent>
              </Select>
            </Field>

            {preset?.requiresAppPassword && (
              <p className="text-muted-foreground rounded-md border px-2.5 py-1.5 text-xs">
                {t("oneMail.accountForm.appPasswordHint")}
              </p>
            )}

            <div className="grid gap-3 sm:grid-cols-2">
              <Field
                label={t("oneMail.accountForm.email")}
                htmlFor="one-mail-account-email"
                error={errors.email && t(`oneMail.accountForm.validation.${errors.email}`)}
              >
                <Input
                  id="one-mail-account-email"
                  type="email"
                  value={form.email}
                  disabled={disabled || editing !== null}
                  aria-invalid={errors.email ? true : undefined}
                  onChange={(event) => patch({ email: event.target.value })}
                />
              </Field>

              <Field label={t("oneMail.accountForm.displayName")} htmlFor="one-mail-account-name">
                <Input
                  id="one-mail-account-name"
                  value={form.displayName}
                  disabled={disabled}
                  onChange={(event) => patch({ displayName: event.target.value })}
                />
              </Field>
            </div>

            <Field label={t("oneMail.accountForm.accountLabel")} htmlFor="one-mail-account-label">
              <Input
                id="one-mail-account-label"
                value={form.accountLabel}
                disabled={disabled}
                onChange={(event) => patch({ accountLabel: event.target.value })}
              />
            </Field>

            <Field
              label={t("oneMail.accountForm.password")}
              htmlFor="one-mail-account-password"
              hint={editing ? t("oneMail.accountForm.passwordKeep") : undefined}
              error={errors.password && t(`oneMail.accountForm.validation.${errors.password}`)}
            >
              <Input
                id="one-mail-account-password"
                type="password"
                autoComplete="new-password"
                value={form.password}
                disabled={disabled}
                placeholder={t("oneMail.accountForm.passwordPlaceholder")}
                aria-invalid={errors.password ? true : undefined}
                onChange={(event) => patch({ password: event.target.value })}
              />
            </Field>

            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_120px]">
              <Field
                label={t("oneMail.accountForm.imapHost")}
                htmlFor="one-mail-account-imap-host"
                error={errors.imapHost && t(`oneMail.accountForm.validation.${errors.imapHost}`)}
              >
                <Input
                  id="one-mail-account-imap-host"
                  value={form.imapHost}
                  disabled={disabled}
                  spellCheck={false}
                  aria-invalid={errors.imapHost ? true : undefined}
                  onChange={(event) => patch({ imapHost: event.target.value })}
                />
              </Field>
              <Field
                label={t("oneMail.accountForm.imapPort")}
                htmlFor="one-mail-account-imap-port"
                error={errors.imapPort && t(`oneMail.accountForm.validation.${errors.imapPort}`)}
              >
                <Input
                  id="one-mail-account-imap-port"
                  type="number"
                  min={1}
                  max={65535}
                  value={form.imapPort}
                  disabled={disabled}
                  aria-invalid={errors.imapPort ? true : undefined}
                  onChange={(event) => patch({ imapPort: event.target.value })}
                />
              </Field>
            </div>

            <Field
              label={t("oneMail.accountForm.imapSecurity")}
              htmlFor="one-mail-account-imap-security"
            >
              <SecuritySelect
                id="one-mail-account-imap-security"
                value={form.imapSecurity}
                disabled={disabled}
                onChange={(value) => patch({ imapSecurity: value })}
              />
            </Field>

            <div className="flex items-center justify-between gap-3 rounded-md border px-2.5 py-2">
              <label htmlFor="one-mail-account-smtp" className="text-xs font-medium">
                {t("oneMail.accountForm.smtpEnabled")}
              </label>
              <Switch
                id="one-mail-account-smtp"
                checked={form.smtpEnabled}
                disabled={disabled}
                onCheckedChange={(checked) => patch({ smtpEnabled: checked })}
              />
            </div>

            {form.smtpEnabled && (
              <>
                <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_120px]">
                  <Field
                    label={t("oneMail.accountForm.smtpHost")}
                    htmlFor="one-mail-account-smtp-host"
                    error={
                      errors.smtpHost && t(`oneMail.accountForm.validation.${errors.smtpHost}`)
                    }
                  >
                    <Input
                      id="one-mail-account-smtp-host"
                      value={form.smtpHost}
                      disabled={disabled}
                      spellCheck={false}
                      aria-invalid={errors.smtpHost ? true : undefined}
                      onChange={(event) => patch({ smtpHost: event.target.value })}
                    />
                  </Field>
                  <Field
                    label={t("oneMail.accountForm.smtpPort")}
                    htmlFor="one-mail-account-smtp-port"
                    error={
                      errors.smtpPort && t(`oneMail.accountForm.validation.${errors.smtpPort}`)
                    }
                  >
                    <Input
                      id="one-mail-account-smtp-port"
                      type="number"
                      min={1}
                      max={65535}
                      value={form.smtpPort}
                      disabled={disabled}
                      aria-invalid={errors.smtpPort ? true : undefined}
                      onChange={(event) => patch({ smtpPort: event.target.value })}
                    />
                  </Field>
                </div>

                <Field
                  label={t("oneMail.accountForm.smtpSecurity")}
                  htmlFor="one-mail-account-smtp-security"
                >
                  <SecuritySelect
                    id="one-mail-account-smtp-security"
                    value={form.smtpSecurity}
                    disabled={disabled}
                    onChange={(value) => patch({ smtpSecurity: value })}
                  />
                </Field>
              </>
            )}

            <div className="flex items-center justify-between gap-3 rounded-md border px-2.5 py-2">
              <label htmlFor="one-mail-account-sync" className="text-xs font-medium">
                {t("oneMail.accountForm.syncEnabled")}
              </label>
              <Switch
                id="one-mail-account-sync"
                checked={form.syncEnabled}
                disabled={disabled}
                onCheckedChange={(checked) => patch({ syncEnabled: checked })}
              />
            </div>

            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={testDisabled}
                  title={
                    passwordRequiredForTest
                      ? t("oneMail.accountForm.validation.passwordRequired")
                      : undefined
                  }
                  onClick={() => void runTest()}
                >
                  {busy === "test" ? <Loader2 className="animate-spin" /> : <Check />}
                  {busy === "test" ? t("oneMail.accounts.testing") : t("oneMail.accounts.test")}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={!discoveryReady}
                  onClick={() => void discoverFolders()}
                >
                  {busy === "discover" ? <Loader2 className="animate-spin" /> : <FolderSearch />}
                  {busy === "discover"
                    ? t("oneMail.accounts.discovering")
                    : t("oneMail.accounts.discover")}
                </Button>
                {passwordRequiredForTest && (
                  <span className="text-muted-foreground text-[11px]">
                    {t("oneMail.accountForm.validation.passwordRequired")}
                  </span>
                )}
              </div>

              {testResult && (
                <div className="space-y-1 rounded-md border px-2.5 py-1.5 text-xs">
                  <TestLine
                    label="IMAP"
                    ok={testResult.imapOk}
                    error={testResult.imapError}
                    okText={t("oneMail.accounts.testSuccess")}
                    failedText={t("oneMail.accounts.testFailed")}
                  />
                  {testResult.smtpOk !== null && (
                    <TestLine
                      label="SMTP"
                      ok={testResult.smtpOk}
                      error={testResult.smtpError}
                      okText={t("oneMail.accounts.testSuccess")}
                      failedText={t("oneMail.accounts.testFailed")}
                    />
                  )}
                </div>
              )}

              <div className="space-y-1">
                <p className="text-xs font-medium">
                  {t("oneMail.accountForm.folders")}
                  {folderCount > 0 && (
                    <span className="text-muted-foreground ml-1 font-normal">({folderCount})</span>
                  )}
                </p>
                {!discovered && !editing && (
                  <p className="text-muted-foreground text-[11px]">
                    {t("oneMail.accountForm.selectFolders")}
                  </p>
                )}
                {candidates.length > 0 && (
                  <FolderSelector
                    candidates={candidates}
                    selected={selectedPaths}
                    disabled={disabled}
                    onChange={(paths) => {
                      setSelectedPaths(paths);
                      setFoldersTouched(true);
                    }}
                  />
                )}
                {editing && candidates.length > 0 && !discovered && (
                  <p className="text-muted-foreground text-[11px]">
                    {t("oneMail.accountForm.inboxLocked")}
                  </p>
                )}
              </div>
            </div>

            {formError && (
              <p role="alert" className="text-destructive text-xs">
                {formError}
              </p>
            )}
          </div>

          <DialogFooter className="border-t px-4 py-3 sm:items-center sm:justify-between">
            {editing ? (
              <Button
                type="button"
                variant="ghost"
                className="text-destructive hover:text-destructive"
                disabled={disabled}
                onClick={() => setDeleteOpen(true)}
              >
                <Trash2 />
                {t("oneMail.accounts.remove")}
              </Button>
            ) : (
              <span />
            )}
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={disabled}
                onClick={() => dialog.close()}
              >
                {t("oneMail.common.cancel")}
              </Button>
              <Button type="button" disabled={disabled} onClick={() => void save()}>
                {busy === "save" && <Loader2 className="animate-spin" />}
                {t("oneMail.common.save")}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("oneMail.accounts.remove")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("oneMail.accounts.removeConfirm", { email: editing?.email ?? "" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy !== null}>
              {t("oneMail.common.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction asChild>
              <Button
                type="button"
                variant="destructive"
                disabled={busy !== null}
                onClick={(event) => {
                  event.preventDefault();
                  void remove();
                }}
              >
                {t("oneMail.common.delete")}
              </Button>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function Field({
  label,
  htmlFor,
  hint,
  error,
  children,
  className,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  error?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("space-y-1", className)}>
      <label htmlFor={htmlFor} className="block text-xs font-medium">
        {label}
      </label>
      {children}
      {error ? (
        <p role="alert" className="text-destructive text-[11px]">
          {error}
        </p>
      ) : (
        hint && <p className="text-muted-foreground text-[11px]">{hint}</p>
      )}
    </div>
  );
}

function SecuritySelect({
  id,
  value,
  disabled,
  onChange,
}: {
  id: string;
  value: Security;
  disabled: boolean;
  onChange: (value: Security) => void;
}) {
  const { t } = useAppTranslation();
  return (
    <Select value={value} disabled={disabled} onValueChange={(next) => onChange(next as Security)}>
      <SelectTrigger id={id} className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {SECURITY_OPTIONS.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.labelKey ? t(option.labelKey) : option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function TestLine({
  label,
  ok,
  error,
  okText,
  failedText,
}: {
  label: string;
  ok: boolean;
  error: string | null;
  okText: string;
  failedText: string;
}) {
  return (
    <p
      className={cn(
        "flex flex-wrap items-center gap-1.5",
        ok ? "text-foreground" : "text-destructive"
      )}
    >
      <span className="font-medium">{label}</span>
      <span>{ok ? okText : failedText}</span>
      {!ok && error && (
        <span className="text-muted-foreground min-w-0 truncate text-[11px]" title={error}>
          {error}
        </span>
      )}
    </p>
  );
}
