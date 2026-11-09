// The `sp_*` commands reject with `{ code, message, detail }` rather than an
// Error, so `String(reason)` would print "[object Object]" and `reason.message`
// would be undefined. Every viewer funnels its catches through this helper.
export function errorText(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  if (typeof reason === 'string') return reason;
  if (reason && typeof reason === 'object') {
    const value = reason as { message?: unknown; detail?: unknown };
    if (typeof value.message === 'string' && value.message) return value.message;
    if (typeof value.detail === 'string' && value.detail) return value.detail;
  }
  return '';
}
