// Ported from Argus (https://github.com/Ray-lea/Argus), AGPL-3.0-or-later.
// See docs/UPSTREAM_PROJECTS.md for the porting record.

// The privileged service's state as a coloured badge. The page header and the
// service panel both read it; clicking it is the caller's decision.

import type { ServiceStatus } from "@/commands";
import { Badge } from "@/components/ui/badge";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { cn } from "@/lib/utils";

/** The states the backend reports; anything else renders as unavailable. */
const KNOWN_STATES = [
  "notInstalled",
  "stopped",
  "running",
  "startPending",
  "stopPending",
  "unavailable",
];

export function isKnownServiceState(state: string): boolean {
  return KNOWN_STATES.includes(state);
}

/** The i18n key for a service state; unknown states fall back to unavailable. */
export function serviceStateKey(state: string): string {
  return isKnownServiceState(state)
    ? `taskManager.service.state.${state}`
    : "taskManager.service.state.unavailable";
}

export type ServiceTone = "ok" | "off" | "warn" | "bad";

/**
 * Green when the service answers, grey when it is not installed, red for a
 * protocol mismatch and amber for every state that should work but does not
 * right now (stopped, unreachable, unauthorized, unknown).
 */
export function serviceTone(service: ServiceStatus | null): ServiceTone {
  if (!service || service.state === "notInstalled") return "off";
  if (service.incompatible) return "bad";
  if (service.state === "running" && service.authorized && !service.error) return "ok";
  return "warn";
}

/**
 * The badge's label. A running service that the app cannot use reads as
 * unavailable, and a version mismatch reads as incompatible rather than as the
 * raw SCM state.
 */
function serviceBadgeKey(service: ServiceStatus | null): string {
  if (!service) return "taskManager.service.state.unknown";
  if (service.incompatible) return "taskManager.service.state.incompatible";
  if (service.state === "running" && (!service.authorized || service.error)) {
    return "taskManager.service.state.unavailable";
  }
  return serviceStateKey(service.state);
}

const TONE_CLASS: Record<ServiceTone, string> = {
  ok: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  off: "border-transparent bg-muted text-muted-foreground",
  warn: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  bad: "border-destructive/40 bg-destructive/10 text-destructive",
};

type ServiceBadgeProps = {
  service: ServiceStatus | null;
  onClick?: () => void;
  className?: string;
};

/** The service state as a badge; pass `onClick` to make it a button. */
export function ServiceBadge({ service, onClick, className }: ServiceBadgeProps) {
  const { t } = useAppTranslation();
  const badge = (
    <Badge variant="outline" className={cn(TONE_CLASS[serviceTone(service)], className)}>
      {t(serviceBadgeKey(service))}
    </Badge>
  );

  if (!onClick) return badge;

  return (
    <button
      type="button"
      onClick={onClick}
      className="focus-visible:ring-ring/50 cursor-pointer rounded-md focus-visible:ring-[3px] focus-visible:outline-none"
    >
      {badge}
    </button>
  );
}
