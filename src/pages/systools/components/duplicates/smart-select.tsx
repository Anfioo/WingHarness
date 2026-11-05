import { ChevronDown, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { DUPLICATE_KEEPER_RULES, type DuplicateKeeperRule } from "@/lib/systools/duplicates";

function isKeeperRule(value: string): value is DuplicateKeeperRule {
  return (DUPLICATE_KEEPER_RULES as readonly string[]).includes(value);
}

type DuplicateSmartSelectProps = {
  rule: DuplicateKeeperRule;
  selectedCount: number;
  disabled: boolean;
  /** Selects the suggested copies, or clears the whole selection. */
  onToggle: () => void;
  onRuleChange: (rule: DuplicateKeeperRule) => void;
};

/**
 * Smart selection is expressed as "keep one copy per group": the rule picks
 * the keeper and every remaining cleanable copy becomes a delete candidate.
 * The menu names each rule by the copy it keeps to keep that direction clear.
 */
export function DuplicateSmartSelect({
  rule,
  selectedCount,
  disabled,
  onToggle,
  onRuleChange,
}: DuplicateSmartSelectProps) {
  const { t } = useAppTranslation();

  return (
    <div className="bg-muted/60 inline-flex shrink-0 items-center rounded-md" role="group">
      <Button
        variant="ghost"
        size="xs"
        className="rounded-r-none"
        disabled={disabled}
        onClick={onToggle}
        title={t("systools.duplicates.smartSelect.hint")}
      >
        {selectedCount > 0 ? <X className="size-3.5" /> : <Sparkles className="size-3.5" />}
        <span className="hidden sm:inline">
          {selectedCount > 0
            ? t("systools.duplicates.smartSelect.clear")
            : t("systools.duplicates.smartSelect.select")}
        </span>
        {selectedCount > 0 && <span className="tabular-nums">({selectedCount})</span>}
      </Button>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            className="rounded-l-none"
            disabled={disabled}
            aria-label={t("systools.duplicates.smartSelect.menuLabel")}
          >
            <ChevronDown className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          <DropdownMenuLabel className="text-muted-foreground text-[11px]">
            {t("systools.duplicates.smartSelect.menuLabel")}
          </DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={rule}
            onValueChange={(value) => {
              if (isKeeperRule(value)) onRuleChange(value);
            }}
          >
            {DUPLICATE_KEEPER_RULES.map((value) => (
              <DropdownMenuRadioItem key={value} value={value}>
                {t(`systools.duplicates.smartSelect.rules.${value}`)}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <p className="text-muted-foreground px-2 py-1.5 text-[11px] leading-relaxed">
            {t("systools.duplicates.smartSelect.safety")}
          </p>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
