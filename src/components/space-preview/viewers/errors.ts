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

/**
 * i18n key for a stable `sp_*` error code, or `null` for a code without
 * dedicated wording. The code names the category; `errorText` stays the
 * fallback because the backend's message is English.
 */
export function previewErrorKey(code: string | null | undefined): string | null {
  switch (code) {
    case 'not-authorized':
      return 'spacePreview.error.notAuthorized';
    case 'not-found':
      return 'spacePreview.error.notFound';
    case 'too-large':
      return 'spacePreview.error.tooLarge';
    case 'invalid-input':
      return 'spacePreview.error.invalidInput';
    case 'unsupported':
      return 'spacePreview.error.unsupported';
    case 'internal':
      return 'spacePreview.error.internal';
    default:
      return null;
  }
}

/** i18n key for a command rejected by the backend, or `null` for any other throw. */
export function previewErrorCodeKey(reason: unknown): string | null {
  if (reason && typeof reason === 'object') {
    const code = (reason as { code?: unknown }).code;
    if (typeof code === 'string') return previewErrorKey(code);
  }
  return null;
}
