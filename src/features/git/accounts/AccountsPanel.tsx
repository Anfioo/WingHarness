import { useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { toast } from "sonner";
import {
  AlertTriangle,
  CheckCircle2,
  Github,
  Gitlab,
  Globe,
  KeyRound,
  Loader2,
  MoreHorizontal,
  Plus,
  Star,
  Trash2,
} from "lucide-react";
import {
  accountAdd,
  accountCheck,
  accountList,
  accountRemove,
  accountSetDefault,
  httpRequest,
  type AccountCheckStatus,
  type HostingAccount,
} from "@/commands";
import { cn } from "@/lib/utils";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { confirmDialog } from "@/components/confirm";
import { timeAgo } from "@/features/git/utils";

export type ProviderKind = "github" | "gitlab" | "gitlab-self" | "bitbucket" | "other";

const FINE_GRAINED_TOKEN_URL = "https://github.com/settings/personal-access-tokens/new";

interface ProviderPreset {
  labelKey: string;
  defaultHost: string;
  hostEditable: boolean;
  tokenPage: (host: string) => string | null;
}

const PROVIDERS: Record<ProviderKind, ProviderPreset> = {
  github: {
    labelKey: "gitRepo.remote.accounts.provider.github",
    defaultHost: "github.com",
    hostEditable: false,
    tokenPage: () => "https://github.com/settings/tokens/new?scopes=repo&description=MaBang",
  },
  gitlab: {
    labelKey: "gitRepo.remote.accounts.provider.gitlab",
    defaultHost: "gitlab.com",
    hostEditable: false,
    tokenPage: () => "https://gitlab.com/-/user_settings/personal_access_tokens",
  },
  "gitlab-self": {
    labelKey: "gitRepo.remote.accounts.provider.gitlabSelf",
    defaultHost: "",
    hostEditable: true,
    tokenPage: (host) => (host ? `http://${host}/-/user_settings/personal_access_tokens` : null),
  },
  bitbucket: {
    labelKey: "gitRepo.remote.accounts.provider.bitbucket",
    defaultHost: "bitbucket.org",
    hostEditable: false,
    tokenPage: () => "https://id.atlassian.com/manage-profile/security/api-tokens",
  },
  other: {
    labelKey: "gitRepo.remote.accounts.provider.other",
    defaultHost: "",
    hostEditable: true,
    tokenPage: () => null,
  },
};

const PROVIDER_ORDER: ProviderKind[] = ["github", "gitlab", "gitlab-self", "bitbucket", "other"];

export function providerIcon(provider: string) {
  if (provider === "github") return <Github className="size-4" />;
  if (provider.startsWith("gitlab")) return <Gitlab className="size-4" />;
  return <Globe className="size-4" />;
}

function accountKey(account: Pick<HostingAccount, "host" | "username">): string {
  return `${account.host}:${account.username}`;
}

export function parseExpiry(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const iso = raw.includes(" UTC") ? `${raw.replace(" ", "T").replace(" UTC", "")}Z` : raw;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

function daysUntil(date: Date): number {
  return Math.ceil((date.getTime() - Date.now()) / 86_400_000);
}

function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn("animate-spin", className)} />;
}

async function validateToken(
  provider: ProviderKind,
  host: string,
  identity: string,
  token: string
): Promise<{ login: string } | null | "unreachable"> {
  if (provider === "bitbucket") {
    if (!identity) {
      throw new Error("accounts.error.bitbucketEmail");
    }
    const res = await httpRequest({
      url: "https://api.bitbucket.org/2.0/user",
      method: "GET",
      headers: {
        authorization: `Basic ${btoa(`${identity}:${token}`)}`,
        "user-agent": "MaBang",
      },
    });
    if (res.status === 401 || res.status === 403)
      throw new Error("accounts.error.bitbucketRejected");
    if (res.status !== 200) throw new Error(`accounts.error.bitbucketStatus|${res.status}`);
    return { login: (JSON.parse(res.body) as { username: string }).username };
  }
  if (provider === "github") {
    const res = await httpRequest({
      url: "https://api.github.com/user",
      method: "GET",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "user-agent": "MaBang",
      },
    });
    if (res.status !== 200) throw new Error(`accounts.error.githubStatus|${res.status}`);
    return { login: (JSON.parse(res.body) as { login: string }).login };
  }
  if (provider === "gitlab" || provider === "gitlab-self") {
    for (const scheme of ["https", "http"]) {
      try {
        const res = await httpRequest({
          url: `${scheme}://${host}/api/v4/user`,
          method: "GET",
          headers: { "private-token": token, "user-agent": "MaBang" },
        });
        if (res.status === 200) {
          return { login: (JSON.parse(res.body) as { username: string }).username };
        }
        if (res.status === 401 || res.status === 403) {
          throw new Error(`accounts.error.gitlabStatus|${res.status}`);
        }
      } catch (error) {
        if ((error as Error).message?.includes("accounts.error")) throw error;
      }
    }
    return "unreachable";
  }
  return null;
}

function AccountStatus({
  account,
  check,
}: {
  account: HostingAccount;
  check: AccountCheckStatus | "checking" | undefined;
}) {
  const { t } = useAppTranslation();
  if (check === "checking") return <Spinner className="size-3.5" />;
  if (check === "unreachable") {
    return (
      <span className="text-muted-foreground text-xs">
        {t("gitRepo.remote.accounts.status.unreachable")}
      </span>
    );
  }
  if (check === "no_token") {
    return (
      <span className="text-destructive flex items-center gap-1 text-xs">
        <AlertTriangle className="size-3.5" />
        {t("gitRepo.remote.accounts.status.noToken")}
      </span>
    );
  }
  if (!account.verified || check === "unauthorized") {
    if (!account.verifiedAt) {
      return (
        <span className="text-muted-foreground/70 text-xs">
          {t("gitRepo.remote.accounts.status.notVerified")}
        </span>
      );
    }
    return (
      <span className="text-destructive flex items-center gap-1 text-xs">
        <AlertTriangle className="size-3.5" />
        {t("gitRepo.remote.accounts.status.expiredRevoked")}
      </span>
    );
  }
  const expiry = parseExpiry(account.expiresAt);
  if (expiry) {
    const days = daysUntil(expiry);
    if (days <= 0) {
      return (
        <span className="text-destructive flex items-center gap-1 text-xs">
          <AlertTriangle className="size-3.5" />
          {t("gitRepo.remote.accounts.status.expired")}
        </span>
      );
    }
    return (
      <span
        className={cn("flex items-center gap-1 text-xs", days <= 14 ? "text-primary" : "text-info")}
      >
        <CheckCircle2 className="size-3.5" />
        {t("gitRepo.remote.accounts.status.expiresIn", { days })}
      </span>
    );
  }
  return <CheckCircle2 className="text-info size-3.5" />;
}

function TokenHint({ provider, host }: { provider: ProviderKind; host: string }) {
  const { t } = useAppTranslation();
  const open = (url: string) => (event: React.MouseEvent) => {
    event.preventDefault();
    void openUrl(url);
  };
  if (provider === "github") {
    return (
      <>
        {t("gitRepo.remote.accounts.hint.githubPre")}
        <a
          href={FINE_GRAINED_TOKEN_URL}
          className="text-primary hover:underline"
          onClick={open(FINE_GRAINED_TOKEN_URL)}
        >
          {t("gitRepo.remote.accounts.hint.githubLink")}
        </a>
        {t("gitRepo.remote.accounts.hint.githubPost")}
      </>
    );
  }
  if (provider === "gitlab" || provider === "gitlab-self") {
    const page = PROVIDERS[provider].tokenPage(host);
    return (
      <>
        {t("gitRepo.remote.accounts.hint.gitlabPre")}
        {page && (
          <a href={page} className="text-primary hover:underline" onClick={open(page)}>
            {t("gitRepo.remote.accounts.hint.gitlabLink")}
          </a>
        )}
        {t("gitRepo.remote.accounts.hint.gitlabPost")}
      </>
    );
  }
  if (provider === "bitbucket") {
    const page = PROVIDERS.bitbucket.tokenPage(host);
    return (
      <>
        {t("gitRepo.remote.accounts.hint.bitbucketPre")}
        {page && (
          <a href={page} className="text-primary hover:underline" onClick={open(page)}>
            {t("gitRepo.remote.accounts.hint.bitbucketLink")}
          </a>
        )}
        {t("gitRepo.remote.accounts.hint.bitbucketPost")}
      </>
    );
  }
  return <>{t("gitRepo.remote.accounts.hint.other")}</>;
}

function usernameHintKey(provider: ProviderKind): string {
  if (provider === "bitbucket") return "gitRepo.remote.accounts.usernameHint.bitbucket";
  if (provider === "other") return "gitRepo.remote.accounts.usernameHint.plain";
  return "gitRepo.remote.accounts.usernameHint.detected";
}

function localError(
  t: (key: string, options?: Record<string, unknown>) => string,
  raw: string
): string {
  const [key, arg] = raw.split("|");
  const id = `gitRepo.remote.${key}`;
  return arg ? t(id, { status: arg }) : t(id);
}

export function AccountsPanel() {
  const { t } = useAppTranslation();
  const [accounts, setAccounts] = useState<HostingAccount[]>([]);
  const [checks, setChecks] = useState<Record<string, AccountCheckStatus | "checking">>({});
  const [provider, setProvider] = useState<ProviderKind>("github");
  const [host, setHost] = useState(PROVIDERS.github.defaultHost);
  const [username, setUsername] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [adding, setAdding] = useState(false);
  const [reconnecting, setReconnecting] = useState<HostingAccount | null>(null);
  const tokenInputRef = useRef<HTMLInputElement>(null);
  const focusTokenRef = useRef(false);
  const skipMenuRefocusRef = useRef(false);

  useEffect(() => {
    if (adding && focusTokenRef.current) {
      focusTokenRef.current = false;
      tokenInputRef.current?.focus();
    }
  }, [adding]);

  useEffect(() => {
    let cancelled = false;
    void accountList()
      .then((list) => {
        if (cancelled) return;
        setAccounts(list);
        setLoading(false);
        void runChecks(list);
      })
      .catch(() => {
        if (cancelled) return;
        setLoading(false);
        setLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function runChecks(list: HostingAccount[]) {
    const eligible = list.filter((account) => {
      if (account.provider === "other") return false;
      if (account.provider === "bitbucket" && !account.email) return false;
      return true;
    });
    if (eligible.length === 0) return;
    setChecks((prev) => {
      const next = { ...prev };
      for (const account of eligible) next[accountKey(account)] = "checking";
      return next;
    });
    await Promise.all(
      eligible.map(async (account) => {
        try {
          const result = await accountCheck(account.host, account.username);
          setChecks((prev) => ({ ...prev, [accountKey(account)]: result.status }));
          setAccounts(result.accounts);
        } catch {
          setChecks((prev) => ({ ...prev, [accountKey(account)]: "unreachable" }));
        }
      })
    );
  }

  const changeProvider = (value: string) => {
    const kind = value as ProviderKind;
    setProvider(kind);
    setHost(PROVIDERS[kind].defaultHost);
  };

  const reconnect = (account: HostingAccount) => {
    const kind =
      (account.provider as ProviderKind) in PROVIDERS
        ? (account.provider as ProviderKind)
        : "other";
    setProvider(kind);
    setHost(account.host);
    setUsername(kind === "bitbucket" ? (account.email ?? "") : account.username);
    setToken("");
    setReconnecting(account);
    if (adding) {
      requestAnimationFrame(() => tokenInputRef.current?.focus());
    } else {
      focusTokenRef.current = true;
      setAdding(true);
    }
  };

  const closeForm = () => {
    setAdding(false);
    setReconnecting(null);
  };

  const startAdd = () => {
    setReconnecting(null);
    setToken("");
    setUsername("");
    setAdding(true);
  };

  const connect = async () => {
    const cleanHost = host
      .trim()
      .replace(/^https?:\/\//, "")
      .replace(/\/$/, "");
    if (!cleanHost || !token.trim() || busy) return;
    const wasReconnect = reconnecting !== null;
    setBusy(true);
    try {
      let finalUsername = username.trim();
      let isVerified = false;
      try {
        const verified = await validateToken(provider, cleanHost, username.trim(), token.trim());
        if (verified === "unreachable") {
          if (!finalUsername) {
            toast.warning(t("gitRepo.remote.accounts.toast.usernameRequired", { host: cleanHost }));
            setBusy(false);
            return;
          }
          toast.warning(t("gitRepo.remote.accounts.toast.unreachable", { host: cleanHost }));
        } else if (verified) {
          finalUsername = verified.login;
          isVerified = true;
        } else if (!finalUsername) {
          setBusy(false);
          return;
        }
      } catch (error) {
        toast.error(localError(t, (error as Error).message ?? String(error)));
        setBusy(false);
        return;
      }
      const email = provider === "bitbucket" ? username.trim() : undefined;
      const list = await accountAdd(
        cleanHost,
        finalUsername,
        provider,
        token.trim(),
        isVerified,
        email
      );
      setAccounts(list);
      setToken("");
      setUsername("");
      closeForm();
      toast.success(
        wasReconnect
          ? t("gitRepo.remote.accounts.toast.reconnected", {
              username: finalUsername,
              host: cleanHost,
            })
          : t("gitRepo.remote.accounts.toast.connected", {
              username: finalUsername,
              host: cleanHost,
            })
      );
      const added = list.find((a) => a.host === cleanHost && a.username === finalUsername);
      if (added) void runChecks([added]);
    } catch (error) {
      toast.error(
        t("gitRepo.remote.accounts.toast.connectFailed", {
          error: (error as { message?: string })?.message ?? String(error),
        })
      );
    } finally {
      setBusy(false);
    }
  };

  const remove = async (account: HostingAccount) => {
    const confirmed = await confirmDialog({
      title: t("gitRepo.remote.accounts.removeConfirm.title", {
        username: account.username,
        host: account.host,
      }),
      description: t("gitRepo.remote.accounts.removeConfirm.description"),
      confirmLabel: t("gitRepo.remote.accounts.removeConfirm.confirm"),
      destructive: true,
    });
    if (!confirmed) return;
    try {
      const list = await accountRemove(account.host, account.username);
      setAccounts(list);
      if (reconnecting && accountKey(reconnecting) === accountKey(account)) closeForm();
    } catch (error) {
      toast.error(
        t("gitRepo.remote.accounts.toast.removeFailed", {
          error: (error as { message?: string })?.message ?? String(error),
        })
      );
    }
  };

  const makeDefault = async (account: HostingAccount) => {
    try {
      const list = await accountSetDefault(account.host, account.username);
      setAccounts(list);
    } catch (error) {
      toast.error(
        t("gitRepo.remote.accounts.toast.defaultFailed", {
          error: (error as { message?: string })?.message ?? String(error),
        })
      );
    }
  };

  const hostCounts = accounts.reduce<Record<string, number>>((acc, account) => {
    acc[account.host] = (acc[account.host] ?? 0) + 1;
    return acc;
  }, {});

  const preset = PROVIDERS[provider];
  const showForm = adding || (!loading && accounts.length === 0);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-1">
          <h3 className="text-sm font-medium">{t("gitRepo.remote.accounts.title")}</h3>
          <p className="text-muted-foreground text-xs">
            {t("gitRepo.remote.accounts.description")}
          </p>
        </div>
        {!showForm && (
          <Button variant="secondary" size="sm" onClick={startAdd}>
            <Plus className="size-3.5" />
            {t("gitRepo.remote.accounts.add")}
          </Button>
        )}
      </div>

      {loading ? (
        <div className="flex flex-col gap-2">
          {[0, 1].map((index) => (
            <div
              key={index}
              className="border-border bg-muted/40 flex items-center gap-3 rounded-lg border p-3"
            >
              <div className="bg-muted size-8 animate-pulse rounded-md" />
              <div className="flex flex-1 flex-col gap-1.5">
                <div className="bg-muted h-3 w-32 animate-pulse rounded" />
                <div className="bg-muted h-3 w-48 animate-pulse rounded" />
              </div>
            </div>
          ))}
        </div>
      ) : loadFailed ? (
        <p className="text-destructive text-xs">{t("gitRepo.remote.accounts.loadFailed")}</p>
      ) : accounts.length > 0 ? (
        <div className="flex flex-col gap-2">
          {accounts.map((account) => {
            const key = accountKey(account);
            const check = checks[key];
            const multi = hostCounts[account.host] > 1;
            const needsReconnect =
              !account.verified || check === "no_token" || check === "unauthorized";
            return (
              <div
                key={key}
                className="border-border bg-muted/40 flex items-center gap-3 rounded-lg border p-3"
              >
                <span className="bg-card text-muted-foreground flex size-8 shrink-0 items-center justify-center rounded-md">
                  {providerIcon(account.provider)}
                </span>
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <p className="flex min-w-0 items-center gap-2 text-sm">
                    <span className="truncate font-medium">{account.username}</span>
                    <span className="text-muted-foreground shrink-0">@ {account.host}</span>
                    {multi && account.isDefault && (
                      <Badge variant="secondary" className="shrink-0">
                        {t("gitRepo.remote.accounts.default")}
                      </Badge>
                    )}
                  </p>
                  <p className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-xs">
                    <AccountStatus account={account} check={check} />
                    <span>·</span>
                    <span>{t("gitRepo.remote.accounts.tokenKeychain")}</span>
                    {account.verifiedAt && (
                      <>
                        <span>·</span>
                        <span>
                          {t("gitRepo.remote.accounts.checkedAgo", {
                            ago: timeAgo(account.verifiedAt),
                          })}
                        </span>
                      </>
                    )}
                  </p>
                </div>
                {needsReconnect && (
                  <Button variant="secondary" size="sm" onClick={() => reconnect(account)}>
                    {t("gitRepo.remote.accounts.reconnect")}
                  </Button>
                )}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t("gitRepo.remote.accounts.menu")}
                    >
                      <MoreHorizontal className="size-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    align="end"
                    onCloseAutoFocus={(event) => {
                      if (skipMenuRefocusRef.current) {
                        skipMenuRefocusRef.current = false;
                        event.preventDefault();
                        tokenInputRef.current?.focus();
                      }
                    }}
                  >
                    {multi && !account.isDefault && (
                      <DropdownMenuItem onSelect={() => void makeDefault(account)}>
                        <Star className="size-4" />
                        {t("gitRepo.remote.accounts.makeDefault", { host: account.host })}
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuItem
                      onSelect={() => {
                        skipMenuRefocusRef.current = true;
                        reconnect(account);
                      }}
                    >
                      <KeyRound className="size-4" />
                      {t("gitRepo.remote.accounts.reconnectWithToken")}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant="destructive" onSelect={() => void remove(account)}>
                      <Trash2 className="size-4" />
                      {t("gitRepo.remote.accounts.remove")}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            );
          })}
        </div>
      ) : null}

      {showForm && (
        <div className="border-primary/30 bg-primary/5 flex flex-col gap-3 rounded-lg border p-3">
          <div className="flex items-center gap-2 text-sm font-medium">
            <KeyRound className="text-primary size-4" />
            {reconnecting
              ? t("gitRepo.remote.accounts.form.reconnect", {
                  username: reconnecting.username,
                  host: reconnecting.host,
                })
              : accounts.length === 0
                ? t("gitRepo.remote.accounts.form.first")
                : t("gitRepo.remote.accounts.form.add")}
          </div>
          <div className="grid grid-cols-2 gap-x-6 gap-y-3">
            <label className="flex min-w-0 flex-col gap-1.5">
              <span className="text-muted-foreground text-xs font-medium">
                {t("gitRepo.remote.accounts.form.provider")}
              </span>
              <Select
                value={provider}
                onValueChange={changeProvider}
                disabled={reconnecting !== null}
              >
                <SelectTrigger size="sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PROVIDER_ORDER.map((kind) => (
                    <SelectItem key={kind} value={kind}>
                      <span className="flex items-center gap-2">
                        {providerIcon(kind)}
                        {t(PROVIDERS[kind].labelKey)}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            <label className="flex min-w-0 flex-col gap-1.5">
              <span className="text-muted-foreground text-xs font-medium">
                {t("gitRepo.remote.accounts.form.host")}
              </span>
              <Input
                className="font-mono text-xs"
                value={host}
                placeholder={preset.defaultHost || "git.example.com"}
                disabled={!preset.hostEditable || reconnecting !== null}
                onChange={(event) => setHost(event.target.value)}
              />
            </label>
            <label className="flex min-w-0 flex-col gap-1.5">
              <span className="text-muted-foreground text-xs font-medium">
                {t("gitRepo.remote.accounts.form.username")}
              </span>
              <Input
                value={username}
                placeholder={t(usernameHintKey(provider))}
                disabled={reconnecting !== null && username.trim() !== ""}
                onChange={(event) => setUsername(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void connect();
                }}
              />
            </label>
            <label className="flex min-w-0 flex-col gap-1.5">
              <span className="text-muted-foreground text-xs font-medium">
                {t("gitRepo.remote.accounts.form.token")}
              </span>
              <Input
                ref={tokenInputRef}
                type="password"
                value={token}
                placeholder="••••••••"
                onChange={(event) => setToken(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void connect();
                  if (event.key === "Escape" && accounts.length > 0) closeForm();
                }}
              />
            </label>
          </div>
          <div className="flex items-start justify-between gap-3">
            <p className="text-muted-foreground text-xs">
              <TokenHint provider={provider} host={host.trim()} />{" "}
              {preset.tokenPage(host.trim()) && (
                <a
                  href={preset.tokenPage(host.trim()) ?? "#"}
                  className="text-primary hover:underline"
                  onClick={(event) => {
                    event.preventDefault();
                    const page = preset.tokenPage(host.trim());
                    if (page) void openUrl(page);
                  }}
                >
                  {t("gitRepo.remote.accounts.form.openTokenPage")}
                </a>
              )}
            </p>
            <div className="flex shrink-0 items-center gap-2">
              {accounts.length > 0 && (
                <Button variant="ghost" size="sm" onClick={closeForm} disabled={busy}>
                  {t("gitRepo.remote.accounts.form.cancel")}
                </Button>
              )}
              <Button
                size="sm"
                onClick={() => void connect()}
                disabled={busy || !token.trim() || !host.trim()}
              >
                {busy && <Loader2 className="animate-spin" />}
                {reconnecting
                  ? t("gitRepo.remote.accounts.form.reconnectAction")
                  : t("gitRepo.remote.accounts.form.connect")}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
