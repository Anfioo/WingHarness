// A compact select for toolbars.
//
// The ported viewers used native <select> elements, whose popup WebView2 draws
// with the OS palette instead of the app theme. The trigger carries the theme
// colours explicitly because the toolbar sits on surfaces that do not inherit
// the foreground colour.

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

export interface CompactSelectOption {
  value: string;
  label: string;
}

interface CompactSelectProps {
  value: string;
  options: CompactSelectOption[];
  onChange: (value: string) => void;
  ariaLabel: string;
  title?: string;
  disabled?: boolean;
  className?: string;
}

export function CompactSelect({
  value,
  options,
  onChange,
  ariaLabel,
  title,
  disabled,
  className,
}: CompactSelectProps) {
  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger
        size="sm"
        aria-label={ariaLabel}
        title={title ?? ariaLabel}
        className={cn("bg-background text-foreground h-7 text-xs", className)}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value} className="text-xs">
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
