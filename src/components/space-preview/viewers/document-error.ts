import type { TFunction } from 'i18next';
import { errorText } from './errors';

// The parsers (pdf.js, the OFD reader, docx-preview) report Error subclasses,
// while the sp_* commands reject with `{ code, message, detail }`.
export function documentError(
  format: 'PDF' | 'OFD' | 'Word' | 'RTF',
  reason: unknown,
  t: TFunction,
): string {
  const error = reason as { name?: string } | null;
  const detail =
    errorText(reason) ||
    t('spacePreview.viewer.errorNoDetail', {
      defaultValue: 'No details were given; load the file again.',
    });
  if (format === 'PDF' && error?.name === 'PasswordException')
    return t('spacePreview.viewer.pdfPasswordProtected', {
      defaultValue:
        'This PDF is password-protected. Unlock it in a PDF reader first, then preview it again.',
    });
  if (format === 'PDF' && error?.name === 'InvalidPDFException')
    return t('spacePreview.viewer.pdfDamaged', {
      defaultValue: 'The PDF is invalid or damaged: {{detail}}',
      detail,
    });
  return t('spacePreview.viewer.documentLoadFailed', {
    defaultValue: 'Failed to load the {{format}} file: {{detail}}',
    format,
    detail,
  });
}
