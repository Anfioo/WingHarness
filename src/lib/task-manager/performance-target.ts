// The hand-off from the processes tab's vitals band to the performance tab.
//
// A vitals card names a device and switches tabs; the performance tab reads
// the pending device when it mounts, or subscribes while it stays mounted (the
// three tabs are kept alive, so it is usually already listening). The hand-off
// lives in this module rather than in React state because the two tabs share no
// provider, and it needs no store of its own.

/** A device named the way the vitals band names it, e.g. `cpu`, `disk:0`, `gpu:<id>`. */
export type PerformanceTarget = string;

let pending: PerformanceTarget | null = null;
const listeners = new Set<(target: PerformanceTarget) => void>();

/** Asks the performance tab to select a device; the caller switches the tab. */
export function requestPerformanceTarget(target: PerformanceTarget): void {
  // A mounted listener applies the request at once, so nothing is left behind
  // to override the user's next choice when the tab mounts again.
  if (listeners.size > 0) {
    for (const listener of listeners) listener(target);
    return;
  }
  pending = target;
}

/** The request made while the performance tab was not listening, if any. */
export function takePerformanceTarget(): PerformanceTarget | null {
  const target = pending;
  pending = null;
  return target;
}

export function subscribePerformanceTarget(
  listener: (target: PerformanceTarget) => void
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The performance tab's device key for a target. That tab has always named
 * devices `disk.0`, `nic.<id>`, `gpu.<id>` and `bat.<id>`; the vitals band
 * names them with a colon. `cpu` and `memory` pass through unchanged.
 */
export function performanceDeviceKey(target: PerformanceTarget): string {
  const separator = target.indexOf(":");
  if (separator === -1) return target;
  return `${target.slice(0, separator)}.${target.slice(separator + 1)}`;
}
