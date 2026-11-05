import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { KeyValueTable } from "@/components/api-client/key-value-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useApiClient } from "@/features/api-client/store";
import { createEmptyEnvironment } from "@/lib/api-core/request-model";
import { countVariableUsage } from "@/lib/api-core/resolve-request";
import type { CollectionNode, Environment } from "@/lib/api-core/types";
import { cn } from "@/lib/utils";

/**
 * Stable fallbacks for the null-tree case: a selector returning a fresh array
 * on every snapshot read makes React loop with "getSnapshot should be cached".
 */
const NO_ENVIRONMENTS: Environment[] = [];
const NO_COLLECTIONS: CollectionNode[] = [];

/**
 * Environment management: one list to pick or add an environment, and one panel
 * for its name and variables. Every edit is written through to the workspace
 * tree immediately (marked dirty, saved with the workspace), so there is no
 * separate confirm step to lose work to.
 */
export function EnvironmentDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation("translation", { keyPrefix: "apiClient.environment" });
  const { t: tCommon } = useTranslation("translation", { keyPrefix: "apiClient.common" });
  const environments = useApiClient((state) => state.tree?.environments) ?? NO_ENVIRONMENTS;
  const collections = useApiClient((state) => state.tree?.collections) ?? NO_COLLECTIONS;
  const activeId = useApiClient((state) => state.activeEnvironmentId);
  const saveEnvironment = useApiClient((state) => state.saveEnvironment);
  const removeEnvironment = useApiClient((state) => state.removeEnvironment);
  const setActiveEnvironment = useApiClient((state) => state.setActiveEnvironment);

  const usage = countVariableUsage(collections);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected =
    environments.find((environment) => environment.id === selectedId) ??
    environments.find((environment) => environment.id === activeId) ??
    environments[0] ??
    null;

  const addEnvironment = () => {
    const environment = createEmptyEnvironment(t("newName"));
    saveEnvironment(environment);
    setSelectedId(environment.id);
    setActiveEnvironment(environment.id);
  };

  const deleteSelected = () => {
    if (!selected) return;
    removeEnvironment(selected.id);
    setSelectedId(null);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

        <div className="grid min-h-64 grid-cols-[10rem_minmax(0,1fr)] gap-3">
          <div className="flex min-h-0 flex-col gap-1">
            <div className="min-h-0 flex-1 overflow-y-auto">
              {environments.map((environment) => (
                <button
                  key={environment.id}
                  type="button"
                  onClick={() => {
                    setSelectedId(environment.id);
                    setActiveEnvironment(environment.id);
                  }}
                  className={
                    environment.id === selected?.id
                      ? "bg-accent text-accent-foreground w-full truncate rounded-md px-2 py-1.5 text-left text-xs"
                      : "text-muted-foreground hover:bg-muted w-full truncate rounded-md px-2 py-1.5 text-left text-xs"
                  }
                >
                  {environment.name}
                </button>
              ))}
              {environments.length === 0 ? (
                <p className="text-muted-foreground px-2 py-1.5 text-xs">{t("empty")}</p>
              ) : null}
            </div>
            <Button type="button" variant="outline" size="xs" onClick={addEnvironment}>
              <Plus />
              {t("create")}
            </Button>
          </div>

          {selected ? (
            <div className="flex min-h-0 flex-col gap-2">
              <div className="flex items-center gap-2">
                <Input
                  value={selected.name}
                  spellCheck={false}
                  autoComplete="off"
                  aria-label={t("name")}
                  placeholder={t("name")}
                  className="h-8 text-xs"
                  onChange={(event) => saveEnvironment({ ...selected, name: event.target.value })}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="text-destructive shrink-0"
                  aria-label={t("delete")}
                  title={t("delete")}
                  onClick={deleteSelected}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
              <p className="text-muted-foreground text-[11px]">{t("deleteHint")}</p>
              <p className="text-muted-foreground mt-1 text-[11px]">{t("variables")}</p>
              <KeyValueTable
                rows={selected.variables}
                onChange={(variables) => saveEnvironment({ ...selected, variables })}
                className="min-h-0 flex-1 overflow-y-auto"
                renderRowExtra={(row) => {
                  const count = row.key === "" ? 0 : (usage.get(row.key) ?? 0);
                  return (
                    <Badge
                      variant="outline"
                      className={cn(
                        "text-[10px] font-normal tabular-nums",
                        count === 0 && "text-muted-foreground/60"
                      )}
                      title={count === 0 ? t("unused") : t("usage", { count })}
                    >
                      {count}
                    </Badge>
                  );
                }}
              />
            </div>
          ) : (
            <div className="text-muted-foreground flex items-center justify-center text-xs">
              {tCommon("labels.empty")}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default EnvironmentDialog;
