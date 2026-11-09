export function documentError(format: 'PDF' | 'OFD' | 'Word' | 'RTF', reason: unknown): string {
  const error = reason as { name?: string; message?: string } | null;
  const detail =
    error?.message || String(reason ?? 'No details were given; load the file again.');
  if (format === 'PDF' && error?.name === 'PasswordException')
    return 'This PDF is password-protected. Unlock it in a PDF reader first, then preview it again.';
  if (format === 'PDF' && error?.name === 'InvalidPDFException')
    return `The PDF is invalid or damaged: ${detail}`;
  return `Failed to load the ${format} file: ${detail}`;
}
