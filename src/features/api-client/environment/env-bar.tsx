import { useEffect, useState } from "react";
import { Settings2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useApiClient } from "@/features/api-client/store";
import { BASE_URL_VARIABLE } from "@/lib/api-core/request-model";
import type { Environment } from "@/lib/api-core/types";
import { isHttpUrl } from "@/lib/api-core/url";
import { cn } from "@/lib/utils";

/**
 * Stable fallback shared by every render: a selector must never return a fresh
 * array, or zustand's snapshot check loops until React gives up.
 */
const NO_ENVIRONMENTS: Environment[] = [];

/**
 * The workspace header's environment controls: which environment resolves the
 * variables, the active environment's base URL, and the entry point to the
 * management dialog. The base URL is edited here because it is the one variable
 * every imported collection needs before it can be sent.
 *
 * The field buffers keystrokes and writes to the workspace on blur or Enter, so
 * a half-typed or invalid URL never lands in the saved tree.
 */
export function EnvironmentBar({ onManage }: { onManage: () => void }) {
  const { t } = useTranslation("translation", { keyPrefix: "apiClient.environment" });
  const { t: tCommon } = useTranslation("translation", { keyPrefix: "apiClient.common" });
  const environments = useApiClient((state) => state.tree?.environments) ?? NO_ENVIRONMENTS;
  const activeId = useApiClient((state) => state.activeEnvironmentId);
  const setActiveEnvironment = useApiClient((state) => state.setActiveEnvironment);
  const setBaseUrl = useApiClient((state) => state.setBaseUrl);

  const active = environments.find((env) => env.id === activeId) ?? environments[0] ?? null;
  const baseUrl = active?.variables.find((row) => row.key === BASE_URL_VARIABLE)?.value ?? "";

  const [buffer, setBuffer] = useState<string | null>(null);
  useEffect(() => setBuffer(null), [active?.id]);

  const value = buffer ?? baseUrl;
  const trimmed = value.trim();
  const invalid = trimmed !== "" && !isHttpUrl(trimmed);

  const commit = () => {
    if (invalid) return;
    if (trimmed !== baseUrl) setBaseUrl(trimmed);
    setBuffer(null);
  };

  return (
    <div className="flex min-w-0 items-center gap-2">
      <Select
        value={active?.id}
        onValueChange={(id) => setActiveEnvironment(id)}
        disabled={environments.length === 0}
      >
        <SelectTrigger
          size="sm"
          className="h-7 w-28 text-xs"
          aria-label={t("label")}
          title={t("label")}
        >
          <SelectValue placeholder={t("label")} />
        </SelectTrigger>
        <SelectContent>
          {environments.map((environment) => (
            <SelectItem key={environment.id} value={environment.id}>
              {environment.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <div className="relative">
        <Input
          value={value}
          spellCheck={false}
          autoComplete="off"
          placeholder={t("baseUrlPlaceholder")}
          aria-label={t("baseUrl")}
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? "api-base-url-error" : undefined}
          title={invalid ? tCommon("validation.baseUrlInvalid") : t("baseUrlHint")}
          className={cn("h-7 w-56 text-xs", invalid && "text-destructive")}
          disabled={active === null}
          onChange={(event) => setBuffer(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            commit();
          }}
        />
        {invalid ? (
          <p
            id="api-base-url-error"
            role="alert"
            className="bg-background text-destructive absolute top-full left-0 z-20 mt-1 rounded px-1 py-0.5 text-[10px] whitespace-nowrap shadow-sm"
          >
            {tCommon("validation.baseUrlInvalid")}
          </p>
        ) : null}
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={t("manage")}
        title={t("manage")}
        onClick={onManage}
      >
        <Settings2 className="size-3.5" />
      </Button>
    </div>
  );
}

export default EnvironmentBar;
