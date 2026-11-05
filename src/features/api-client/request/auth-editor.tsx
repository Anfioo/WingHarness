import type { ReactNode } from "react";
import { ShieldAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { Auth, AuthKind } from "@/lib/api-core/types";

/** The auth kinds in picker order. */
const AUTH_KINDS: readonly AuthKind[] = ["none", "bearer", "basic", "apiKey"];

function Field({ label, children }: { label: string; children: ReactNode }): ReactNode {
  return (
    <div className="flex flex-col gap-1.5">
      <Label className="text-xs">{label}</Label>
      {children}
    </div>
  );
}

export interface AuthEditorProps {
  auth: Auth;
  onChange: (auth: Auth) => void;
}

/**
 * The Auth tab: pick a scheme and fill its fields. A visible warning makes the
 * v1 trade-off explicit — these values are stored in plain text inside the
 * request JSON rather than a secret store.
 */
export function AuthEditor({ auth, onChange }: AuthEditorProps) {
  const { t } = useTranslation("translation", { keyPrefix: "apiClient.request.auth" });
  const { t: tCommon } = useTranslation("translation", { keyPrefix: "apiClient.common" });

  const set = (patch: Partial<Auth>) => onChange({ ...auth, ...patch });
  const kindLabel = (kind: AuthKind) =>
    kind === "none" ? tCommon("labels.none") : t(`kind.${kind}`);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2.5 text-xs text-amber-700 dark:text-amber-400">
        <ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
        <span>{t("warning")}</span>
      </div>

      <div className="flex items-center gap-2">
        <Label htmlFor="auth-kind" className="text-xs">
          {t("label")}
        </Label>
        <Select value={auth.kind} onValueChange={(value) => set({ kind: value as AuthKind })}>
          <SelectTrigger id="auth-kind" size="sm" className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {AUTH_KINDS.map((kind) => (
              <SelectItem key={kind} value={kind}>
                {kindLabel(kind)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {auth.kind === "bearer" ? (
        <Field label={t("token")}>
          <Input
            type="password"
            value={auth.token}
            spellCheck={false}
            autoComplete="off"
            placeholder={t("tokenPlaceholder")}
            className="h-8 text-xs"
            onChange={(event) => set({ token: event.target.value })}
          />
        </Field>
      ) : null}

      {auth.kind === "basic" ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t("username")}>
            <Input
              value={auth.username}
              spellCheck={false}
              autoComplete="off"
              placeholder={t("usernamePlaceholder")}
              className="h-8 text-xs"
              onChange={(event) => set({ username: event.target.value })}
            />
          </Field>
          <Field label={t("password")}>
            <Input
              type="password"
              value={auth.password}
              autoComplete="off"
              placeholder={t("passwordPlaceholder")}
              className="h-8 text-xs"
              onChange={(event) => set({ password: event.target.value })}
            />
          </Field>
        </div>
      ) : null}

      {auth.kind === "apiKey" ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t("apiKeyName")}>
              <Input
                value={auth.apiKeyName}
                spellCheck={false}
                autoComplete="off"
                placeholder={t("apiKeyNamePlaceholder")}
                className="h-8 text-xs"
                onChange={(event) => set({ apiKeyName: event.target.value })}
              />
            </Field>
            <Field label={t("apiKeyValue")}>
              <Input
                type="password"
                value={auth.apiKeyValue}
                autoComplete="off"
                placeholder={t("apiKeyValuePlaceholder")}
                className="h-8 text-xs"
                onChange={(event) => set({ apiKeyValue: event.target.value })}
              />
            </Field>
          </div>
          <p className="text-muted-foreground text-[11px]">{t("apiKeyNote")}</p>
        </>
      ) : null}
    </div>
  );
}

export default AuthEditor;
