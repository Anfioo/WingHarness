import { useCallback, useEffect, useState, type ReactNode } from "react";
import { open as pickFile } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { Copy, FolderOpen, KeyRound, Loader2, Plus, Trash2, UsersRound } from "lucide-react";
import { accountList, configGet, configSet, sshKeyGenerate, sshPublicKey } from "@/commands";
import type { HostingAccount } from "@/commands";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { confirmDialog } from "@/components/confirm";
import { cn } from "@/lib/utils";
import { avatarHue, initials } from "@/features/git/utils";
import { useRepo } from "@/features/git/repository-store";
import { providerIcon } from "@/features/git/accounts";
import { applyProfileToRepo } from "./profiles";
import { useIdentity, type IdentityProfile } from "./store";

function Spinner() {
  return <Loader2 className="size-4 animate-spin" />;
}

function SettingCard({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="border-border bg-card flex flex-col gap-3 rounded-lg border p-4">
      <header className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <h3 className="text-foreground text-sm font-medium">{title}</h3>
          {description && <p className="text-muted-foreground text-xs">{description}</p>}
        </div>
        {action}
      </header>
      {children}
    </section>
  );
}

function SettingRow({
  title,
  description,
  control,
}: {
  title: string;
  description?: string;
  control: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex flex-col gap-0.5">
        <span className="text-foreground text-sm">{title}</span>
        {description && <span className="text-muted-foreground text-xs">{description}</span>}
      </div>
      <div className="shrink-0 pt-0.5">{control}</div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-muted-foreground text-xs font-medium">{label}</span>
      {children}
    </label>
  );
}

function ProfileAvatar({ profile, className }: { profile: IdentityProfile; className?: string }) {
  const hue = avatarHue(profile.email);
  return (
    <Avatar className={cn("size-7", className)}>
      <AvatarFallback style={{ backgroundColor: `hsl(${hue} 45% 40%)`, color: "#fff" }}>
        {initials(profile.name || profile.label)}
      </AvatarFallback>
    </Avatar>
  );
}

function SshCard() {
  const { t } = useAppTranslation();
  const settings = useIdentity();
  const [publicKey, setPublicKey] = useState("");
  const [busy, setBusy] = useState(false);
  const keyPath = settings.sshKeyPath.trim() || "~/.ssh/id_ed25519";

  const showPublicKey = async () => {
    setBusy(true);
    try {
      setPublicKey(await sshPublicKey(keyPath));
    } catch (error) {
      setPublicKey("");
      toast.error(
        t("gitRepo.remote.identity.ssh.showFailed", {
          error: (error as { message?: string })?.message ?? String(error),
        })
      );
    } finally {
      setBusy(false);
    }
  };

  const generate = async () => {
    setBusy(true);
    try {
      const created = await sshKeyGenerate("~/.ssh/wingharness_ed25519", "WingHarness");
      settings.setSshKeyPath(created.path);
      setPublicKey(created.publicKey);
      toast.success(t("gitRepo.remote.identity.ssh.created", { path: created.path }), {
        description: t("gitRepo.remote.identity.ssh.createdHint"),
      });
    } catch (error) {
      toast.error(
        t("gitRepo.remote.identity.ssh.generateFailed", {
          error: (error as { message?: string })?.message ?? String(error),
        })
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingCard
      title={t("gitRepo.remote.identity.ssh.title")}
      description={t("gitRepo.remote.identity.ssh.description")}
    >
      <div className="flex flex-col gap-3">
        <SettingRow
          title={t("gitRepo.remote.identity.ssh.useAgent")}
          description={t("gitRepo.remote.identity.ssh.useAgentHint")}
          control={
            <Switch checked={settings.sshUseAgent} onCheckedChange={settings.setSshUseAgent} />
          }
        />
        <Field label={t("gitRepo.remote.identity.ssh.privateKey")}>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <KeyRound className="text-muted-foreground/70 absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
              <Input
                className="pl-8"
                value={settings.sshKeyPath}
                onChange={(event) => settings.setSshKeyPath(event.target.value)}
                placeholder="~/.ssh/id_ed25519"
              />
            </div>
            <Button
              variant="secondary"
              size="icon"
              aria-label={t("gitRepo.remote.identity.ssh.browse")}
              onClick={async () => {
                const picked = await pickFile({
                  title: t("gitRepo.remote.identity.ssh.browseTitle"),
                });
                if (typeof picked === "string") settings.setSshKeyPath(picked);
              }}
            >
              <FolderOpen />
            </Button>
          </div>
        </Field>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            disabled={busy}
            onClick={() => void showPublicKey()}
          >
            {t("gitRepo.remote.identity.ssh.showPublicKey")}
          </Button>
          <Button variant="secondary" size="sm" disabled={busy} onClick={() => void generate()}>
            {busy ? <Spinner /> : null}
            {t("gitRepo.remote.identity.ssh.generate")}
          </Button>
        </div>
        {publicKey && (
          <div className="border-border bg-muted flex flex-col gap-2 rounded-md border p-2.5">
            <p className="text-muted-foreground font-mono text-xs break-all">{publicKey}</p>
            <Button
              variant="ghost"
              size="sm"
              className="self-start"
              onClick={() => {
                void navigator.clipboard.writeText(publicKey);
                toast.success(t("gitRepo.remote.identity.ssh.copied"));
              }}
            >
              <Copy /> {t("gitRepo.remote.identity.ssh.copy")}
            </Button>
          </div>
        )}
      </div>
    </SettingCard>
  );
}

function CredentialHelperCard() {
  const { t } = useAppTranslation();
  const settings = useIdentity();
  return (
    <SettingCard
      title={t("gitRepo.remote.identity.credHelper.title")}
      description={t("gitRepo.remote.identity.credHelper.description")}
    >
      <SettingRow
        title={t("gitRepo.remote.identity.credHelper.toggle")}
        control={
          <Switch
            checked={settings.useCredentialHelper}
            onCheckedChange={settings.setUseCredentialHelper}
          />
        }
      />
    </SettingCard>
  );
}

function IdentityCard() {
  const { t } = useAppTranslation();
  const repo = useRepo((state) => state.repo);
  const profiles = useIdentity((state) => state.profiles);
  const repoPath = repo?.path ?? null;
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      configGet("user.name", repoPath ?? undefined),
      configGet("user.email", repoPath ?? undefined),
    ]).then(([loadedName, loadedEmail]) => {
      if (cancelled) return;
      setName((loadedName as string | null) ?? "");
      setEmail((loadedEmail as string | null) ?? "");
    });
    return () => {
      cancelled = true;
    };
  }, [repoPath]);

  const activeProfile = profiles.find(
    (profile) => profile.email === email && profile.name === name
  );
  const repoName = repo?.name ?? null;

  const save = async () => {
    setBusy(true);
    try {
      const global = !repoPath;
      await configSet("user.name", name, global, repoPath ?? undefined);
      await configSet("user.email", email, global, repoPath ?? undefined);
      toast.success(t("gitRepo.remote.identity.git.saved"));
    } catch (error) {
      toast.error((error as { message?: string })?.message ?? String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingCard
      title={
        repoName
          ? t("gitRepo.remote.identity.git.titleRepo", { repo: repoName })
          : t("gitRepo.remote.identity.git.titleGlobal")
      }
      description={t("gitRepo.remote.identity.git.description")}
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label={t("gitRepo.remote.identity.git.name")}>
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={t("gitRepo.remote.identity.git.placeholderName")}
          />
        </Field>
        <Field label={t("gitRepo.remote.identity.git.email")}>
          <Input
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder={t("gitRepo.remote.identity.git.placeholderEmail")}
          />
        </Field>
      </div>
      <div className="flex items-center justify-between">
        <p className="text-muted-foreground text-xs">
          {repoName
            ? t("gitRepo.remote.identity.git.noteRepo")
            : t("gitRepo.remote.identity.git.noteGlobal")}
        </p>
        <div className="flex items-center gap-2">
          {activeProfile && (
            <Badge variant="default">
              {t("gitRepo.remote.identity.git.activeProfile", { label: activeProfile.label })}
            </Badge>
          )}
          <Button size="sm" disabled={busy} onClick={() => void save()}>
            {busy ? <Spinner /> : null}
            {t("gitRepo.remote.identity.git.save")}
          </Button>
        </div>
      </div>
    </SettingCard>
  );
}

function ProfilesCard() {
  const { t } = useAppTranslation();
  const repo = useRepo((state) => state.repo);
  const repoPath = repo?.path ?? null;
  const profiles = useIdentity((state) => state.profiles);
  const addProfile = useIdentity((state) => state.addProfile);
  const updateProfile = useIdentity((state) => state.updateProfile);
  const removeProfile = useIdentity((state) => state.removeProfile);
  const [accounts, setAccounts] = useState<HostingAccount[]>([]);
  const [openForm, setOpenForm] = useState(false);
  const [draft, setDraft] = useState({ label: "", name: "", email: "" });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void accountList()
      .then((list) => {
        if (!cancelled) setAccounts(list);
      })
      .catch(() => {
        if (!cancelled) setAccounts([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const sortedAccounts = [...accounts].sort((a, b) =>
    `${a.host}:${a.username}`.localeCompare(`${b.host}:${b.username}`)
  );

  const setAccountLinked = (profile: IdentityProfile, account: HostingAccount, linked: boolean) =>
    updateProfile(profile.id, {
      accounts: {
        ...(profile.accounts ?? {}),
        ...(linked
          ? { [account.host]: account.username }
          : (() => {
              const next = { ...(profile.accounts ?? {}) };
              delete next[account.host];
              return next;
            })()),
      },
    });

  const use = useCallback(
    async (profile: IdentityProfile) => {
      setBusy(true);
      try {
        if (repoPath) {
          await applyProfileToRepo(repoPath, profile);
          toast.success(
            t("gitRepo.remote.identity.profiles.appliedRepo", {
              label: profile.label,
              repo: repo?.name ?? "",
            })
          );
        } else {
          await configSet("user.name", profile.name, true);
          await configSet("user.email", profile.email, true);
          toast.success(
            t("gitRepo.remote.identity.profiles.appliedGlobal", { label: profile.label })
          );
        }
      } catch (error) {
        toast.error((error as { message?: string })?.message ?? String(error));
      } finally {
        setBusy(false);
      }
    },
    [repoPath, repo?.name, t]
  );

  const remove = async (profile: IdentityProfile) => {
    const ok = await confirmDialog({
      title: t("gitRepo.remote.identity.profiles.removeConfirm.title", { label: profile.label }),
      description: t("gitRepo.remote.identity.profiles.removeConfirm.description"),
      confirmLabel: t("gitRepo.remote.identity.profiles.removeConfirm.confirm"),
      destructive: true,
    });
    if (ok) removeProfile(profile.id);
  };

  const add = () => {
    if (!draft.name.trim() || !draft.email.trim()) return;
    addProfile({
      label: draft.label.trim() || draft.name.trim(),
      name: draft.name.trim(),
      email: draft.email.trim(),
    });
    setDraft({ label: "", name: "", email: "" });
    setOpenForm(false);
  };

  return (
    <SettingCard
      title={t("gitRepo.remote.identity.profiles.title")}
      description={t("gitRepo.remote.identity.profiles.description")}
      action={
        <Button variant="secondary" size="sm" onClick={() => setOpenForm((value) => !value)}>
          <Plus /> {t("gitRepo.remote.identity.profiles.new")}
        </Button>
      }
    >
      {openForm && (
        <div className="border-border bg-muted grid grid-cols-3 gap-2 rounded-md border p-2.5">
          <Input
            value={draft.label}
            onChange={(event) => setDraft({ ...draft, label: event.target.value })}
            placeholder={t("gitRepo.remote.identity.profiles.addLabel")}
          />
          <Input
            value={draft.name}
            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            placeholder={t("gitRepo.remote.identity.profiles.addName")}
          />
          <Input
            value={draft.email}
            onChange={(event) => setDraft({ ...draft, email: event.target.value })}
            placeholder={t("gitRepo.remote.identity.profiles.addEmail")}
          />
          <div className="col-span-3 flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setOpenForm(false)}>
              {t("gitRepo.remote.identity.profiles.cancel")}
            </Button>
            <Button size="sm" disabled={!draft.name.trim() || !draft.email.trim()} onClick={add}>
              {t("gitRepo.remote.identity.profiles.add")}
            </Button>
          </div>
        </div>
      )}

      {profiles.length === 0 ? (
        <div className="border-border bg-muted/40 flex flex-col items-start gap-2 rounded-lg border border-dashed p-4">
          <span className="bg-primary/15 text-primary flex size-9 items-center justify-center rounded-md">
            <UsersRound className="size-4" />
          </span>
          <span className="text-sm font-medium">
            {t("gitRepo.remote.identity.profiles.empty.title")}
          </span>
          <span className="text-muted-foreground text-xs">
            {t("gitRepo.remote.identity.profiles.empty.description")}
          </span>
        </div>
      ) : (
        <div className="divide-border flex flex-col divide-y">
          {profiles.map((profile) => {
            const linkedCount = Object.keys(profile.accounts ?? {}).length;
            return (
              <div key={profile.id} className="flex flex-col gap-3 py-3 first:pt-0 last:pb-0">
                <div className="flex items-center gap-3">
                  <ProfileAvatar profile={profile} />
                  <div className="flex min-w-0 flex-col">
                    <span className="text-foreground truncate text-sm font-medium">
                      {profile.label}
                    </span>
                    <span className="text-muted-foreground truncate text-xs">
                      {profile.name} · {profile.email}
                    </span>
                  </div>
                  <div className="ml-auto flex items-center gap-2">
                    <Badge variant="secondary">
                      {t("gitRepo.remote.identity.profiles.linked", {
                        count: linkedCount,
                        total: sortedAccounts.length,
                      })}
                    </Badge>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={busy}
                      onClick={() => void use(profile)}
                    >
                      {repo
                        ? t("gitRepo.remote.identity.profiles.useForRepo")
                        : t("gitRepo.remote.identity.profiles.use")}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t("gitRepo.remote.identity.profiles.remove")}
                      onClick={() => void remove(profile)}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                </div>
                {sortedAccounts.length > 0 && (
                  <div className="flex flex-col gap-1 pl-10">
                    <span className="text-muted-foreground/70 text-[11px]">
                      {t("gitRepo.remote.identity.profiles.linkedHint")}
                    </span>
                    <div className="divide-border border-border divide-y rounded-md border">
                      {sortedAccounts.map((account) => {
                        const linked = (profile.accounts ?? {})[account.host] === account.username;
                        return (
                          <div
                            key={`${account.host}:${account.username}`}
                            className="flex items-center gap-3 px-2.5 py-1.5"
                          >
                            <span className="text-muted-foreground">
                              {providerIcon(account.provider)}
                            </span>
                            <span className="text-foreground min-w-0 flex-1 truncate text-xs">
                              {account.host} · {account.username}
                            </span>
                            <Switch
                              checked={linked}
                              onCheckedChange={(value) => setAccountLinked(profile, account, value)}
                              aria-label={t("gitRepo.remote.identity.profiles.linkLabel", {
                                host: account.host,
                              })}
                            />
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </SettingCard>
  );
}

export function IdentityPanel() {
  return (
    <div className="flex flex-col gap-4">
      <IdentityCard />
      <ProfilesCard />
      <SshCard />
      <CredentialHelperCard />
    </div>
  );
}
