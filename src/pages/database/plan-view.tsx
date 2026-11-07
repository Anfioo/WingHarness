// The execution plan of one statement: the nodes in the order the server
// returned them (their `depth` is the indent) and the properties of the node
// the user picked.

import { useState, type ReactNode } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { PlanNode } from "@/commands";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { cn } from "@/lib/utils";

export type PlanViewProps = {
  nodes: PlanNode[];
  busy?: boolean;
  onExplainAgain(): void;
};

export function PlanView(props: PlanViewProps): ReactNode {
  const { nodes, busy, onExplainAgain } = props;
  const { t } = useAppTranslation();
  const [pickedId, setPickedId] = useState<number | null>(null);

  // Another plan (Explain Again) starts at its root; an id that is gone falls
  // back the same way.
  const selected = nodes.find((node) => node.id === pickedId) ?? nodes[0] ?? null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b px-2 py-1">
        <span className="text-xs font-medium">{t("database.plan.title")}</span>
        <Button
          variant="ghost"
          size="xs"
          className="ml-auto"
          disabled={busy}
          onClick={onExplainAgain}
        >
          {busy ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          {t("database.plan.explainAgain")}
        </Button>
      </div>

      {nodes.length === 0 ? (
        <p className="text-muted-foreground p-3 text-xs">{t("database.plan.noPlan")}</p>
      ) : (
        <div className="flex min-h-0 flex-1">
          <ul
            className="min-w-0 flex-1 overflow-auto py-1"
            role="listbox"
            aria-label={t("database.plan.operation")}
          >
            {nodes.map((node) => {
              const active = node === selected;
              return (
                <li key={node.id} role="option" aria-selected={active}>
                  <button
                    type="button"
                    className={cn(
                      "flex w-full items-baseline gap-2 px-2 py-1 text-left text-xs",
                      active ? "bg-accent text-accent-foreground" : "hover:bg-accent/60"
                    )}
                    style={{ paddingLeft: 8 + Math.max(0, node.depth) * 16 }}
                    onClick={() => setPickedId(node.id)}
                  >
                    <span className="shrink-0 font-medium">{node.operation}</span>
                    {node.detail && (
                      <span className="text-muted-foreground truncate">{node.detail}</span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>

          <aside className="w-72 shrink-0 overflow-auto border-l">
            {selected && (
              <>
                <div className="bg-muted/40 border-b px-3 py-1.5 text-xs font-medium">
                  {t("database.plan.node", { id: selected.id })}
                </div>
                {selected.properties.length === 0 ? (
                  <p className="text-muted-foreground p-3 text-xs">
                    {t("database.plan.properties")}
                  </p>
                ) : (
                  <dl className="divide-border divide-y text-xs">
                    {selected.properties.map((property, index) => (
                      <div key={`${property.name}\u0000${index}`} className="flex gap-2 px-3 py-1">
                        <dt className="text-muted-foreground w-28 shrink-0 truncate">
                          {property.name}
                        </dt>
                        <dd className="min-w-0 flex-1 font-mono break-all whitespace-pre-wrap">
                          {property.value}
                        </dd>
                      </div>
                    ))}
                  </dl>
                )}
              </>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}
