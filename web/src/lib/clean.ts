import { sanitizeProductDetails, sanitizeTextReport, type Sanitized } from '@sketch-to-product-views/contracts';

/**
 * The form's text as the API will keep it (`sanitizeText` in contracts), applied on blur so
 * the user sees the cleaned text before submitting.
 */
export type CleanKind = 'single' | 'multiline' | 'details';

export function clean(text: string, kind: CleanKind): Sanitized {
  if (kind === 'details') return text.trim() ? sanitizeProductDetails(text) : { text, removed: 0 };
  return sanitizeTextReport(text, { multiline: kind === 'multiline' });
}

/** Shown under a field when cleaning removed anything; null otherwise. */
export function removedHint(removed: number): string | null {
  if (removed <= 0) return null;
  return `${removed} hidden or control character${removed === 1 ? '' : 's'} removed.`;
}
