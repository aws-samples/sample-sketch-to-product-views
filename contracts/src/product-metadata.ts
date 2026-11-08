import { z } from 'zod';
import { sanitizeProductDetails } from './sanitize.js';

/**
 * Product details: whatever the business knows about the product, in whatever shape it has it.
 * Plain text (`lounge chair, walnut frame, cream wool seat, 78 cm wide`) or JSON (often an exported spreadsheet row,
 * whose column names change between exports).
 *
 * The pipeline never reads it by key. It is sent verbatim to the analyser, as data, which reads
 * it next to the images and returns the structured specification; the prompt is built from
 * that, never from this. Nothing is defaulted from it.
 *
 * The text is sanitised first (`sanitizeProductDetails`); the only checks are then on the
 * container: non-empty and of a sane size. JSON is pretty-printed when it parses to an object
 * or an array, so what the analyser reads is stable; anything else is kept as text. The wire name stays `productMetadata` for compatibility.
 */

/** A row is well under 1 KB; this is room for a generous export, not for a whole season. */
export const PRODUCT_METADATA_MAX_BYTES = 64 * 1024;

export const PRODUCT_METADATA_FORMATS = ['text', 'json'] as const;

export const productMetadataSchema = z.object({
  format: z.enum(PRODUCT_METADATA_FORMATS),
  text: z.string().min(1).max(PRODUCT_METADATA_MAX_BYTES),
});
export type ProductMetadata = z.infer<typeof productMetadataSchema>;

export type ProductMetadataErrorCode = 'unsupported_file' | 'too_large' | 'empty' | 'invalid';

export type ProductMetadataResult =
  | { ok: true; metadata: ProductMetadata }
  | { ok: false; error: { code: ProductMetadataErrorCode; message: string } };

const fail = (code: ProductMetadataErrorCode, message: string): ProductMetadataResult => ({
  ok: false,
  error: { code, message },
});

/** True when the document carries no data at all: `{}`, `[]`, `""`, `null`, or only those. */
function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.every(isEmpty);
  if (typeof value === 'object') return Object.values(value).every(isEmpty);
  return false;
}

/** The parsed JSON value, or undefined when the text is not JSON. */
function parseJson(text: string): { value: unknown } | undefined {
  try {
    return { value: JSON.parse(text) };
  } catch {
    return undefined;
  }
}

/**
 * SPA only: the file as picked, `.txt` or `.json`. The message is shown verbatim under the
 * upload, so it is written for the person who picked the file.
 */
export function validateProductMetadataFile(file: {
  name: string;
  type: string;
  size: number;
  text: string;
}): ProductMetadataResult {
  const named = /\.(json|txt)$/i.test(file.name);
  if (!named && file.type !== 'application/json' && file.type !== 'text/plain') {
    return fail('unsupported_file', `${file.name} is not a .txt or .json file.`);
  }
  if (file.size > PRODUCT_METADATA_MAX_BYTES) {
    return fail(
      'too_large',
      `${file.name} is larger than 64 KB; one product's details are expected.`,
    );
  }
  return validateProductMetadataText(file.text);
}

/** The product details as typed or read from a file, sanitised first (`./sanitize.ts`). */
export function validateProductMetadataText(text: string): ProductMetadataResult {
  const clean = sanitizeProductDetails(text).text;
  if (new TextEncoder().encode(clean).byteLength > PRODUCT_METADATA_MAX_BYTES) {
    return fail('too_large', 'The product details are larger than 64 KB; one product is expected.');
  }
  if (clean === '') return fail('empty', 'The product details are empty.');

  const parsed = parseJson(clean);
  if (parsed && isEmpty(parsed.value)) {
    return fail('empty', 'The product details have no data in them.');
  }
  // Only an object or an array is a document; `42` or `"ivory"` is text.
  if (!parsed || typeof parsed.value !== 'object') {
    return { ok: true, metadata: { format: 'text', text: clean } };
  }
  return { ok: true, metadata: { format: 'json', text: clean } };
}

/**
 * SPA and API: the value in a submit body. Re-reads the text rather than trusting the client's
 * `format`, because the API is what stands between an arbitrary request and the analyser's
 * prompt. A stored `{ format: "json" }` value still parses.
 */
export function validateProductMetadata(value: unknown): ProductMetadataResult {
  const shape = productMetadataSchema.safeParse(value);
  if (!shape.success) {
    return fail('invalid', 'productMetadata must be { format: "text" | "json", text: string }.');
  }
  return validateProductMetadataText(shape.data.text);
}
