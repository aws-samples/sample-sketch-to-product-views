/**
 * Character hygiene for every free-text input, before any check or model sees it. Pure and
 * idempotent, so the SPA, the CLI, the API and the pipeline can each apply it.
 *
 * It removes characters that hide or reorder text (controls, format and bidi characters,
 * invisible fillers, variation selectors used to smuggle data), applies Unicode NFKC, and
 * tidies whitespace. It does not judge meaning: that is the guardrail's job.
 */

export interface SanitizeOptions {
  /** Keeps line breaks and tabs. Single-line fields turn them into a space. */
  multiline?: boolean;
}

export interface Sanitized {
  text: string;
  /** Characters removed as hidden or control characters (whitespace tidying not counted). */
  removed: number;
}

// Line breaks in every form: CRLF, CR, NEL, LINE and PARAGRAPH SEPARATOR.
const LINE_BREAKS = /\r\n?|[\u0085\u2028\u2029]/g;

/**
 * C0 and C1 controls and DEL (tab and line feed handled apart), every format character (Cf:
 * zero-width, bidi embeddings, overrides and isolates, the soft hyphen, tag characters), lone
 * surrogates, the Hangul fillers that render as blank, and the variation selectors other than
 * VS15/VS16 (the emoji text/emoji switches).
 */
const HIDDEN =
  /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]|\p{Cf}|\p{Cs}|[\u115F\u1160\u3164\uFFA0]|[\uFE00-\uFE0D]|[\u{E0100}-\u{E01EF}]/gu;

export function sanitizeTextReport(text: string, options: SanitizeOptions = {}): Sanitized {
  const multiline = options.multiline ?? false;
  let out = text.replace(LINE_BREAKS, '\n');
  if (!multiline) out = out.replace(/[\n\t]/g, ' ');

  let removed = 0;
  out = out.replace(HIDDEN, (match) => {
    removed += [...match].length;
    return '';
  });

  out = out.normalize('NFKC');

  // A run of blanks becomes one: a tab when it held one (a pasted spreadsheet row), else a space.
  out = out.replace(/[ \t]+/g, (run) => (run.includes('\t') ? '\t' : ' '));
  if (multiline) {
    out = out
      .split('\n')
      .map((line) => line.trim())
      .join('\n')
      .replace(/\n{3,}/g, '\n\n');
  }
  return { text: out.trim(), removed };
}

export function sanitizeText(text: string, options: SanitizeOptions = {}): string {
  return sanitizeTextReport(text, options).text;
}

/**
 * Product details: JSON (an object or an array) keeps its structure, with every key
 * (single-line) and string value (multiline) sanitised, then is pretty-printed; anything else
 * is sanitised as multiline text.
 */
export function sanitizeProductDetails(text: string): Sanitized {
  const asText = sanitizeTextReport(text, { multiline: true });
  const raw = parseJsonDocument(text);
  const parsed = raw ?? parseJsonDocument(asText.text);
  if (parsed === undefined) return asText;

  // Parsed only once cleaned: the hidden characters were between the tokens.
  let removed = raw ? 0 : asText.removed;
  const clean = (value: unknown): unknown => {
    if (typeof value === 'string') {
      const r = sanitizeTextReport(value, { multiline: true });
      removed += r.removed;
      return r.text;
    }
    if (Array.isArray(value)) return value.map(clean);
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value).map(([key, v]) => {
          const k = sanitizeTextReport(key);
          removed += k.removed;
          return [k.text, clean(v)];
        }),
      );
    }
    return value;
  };
  const cleaned = clean(parsed.value);
  return { text: JSON.stringify(cleaned, null, 2), removed };
}

/** An object or an array; a JSON scalar (`42`, `"ivory"`) is text. */
function parseJsonDocument(text: string): { value: object } | undefined {
  try {
    const value: unknown = JSON.parse(text.replace(/^\uFEFF/, ''));
    return value && typeof value === 'object' ? { value } : undefined;
  } catch {
    return undefined;
  }
}

// ── Request bodies, before their schemas run ────────────────────────────────

type Body = Record<string, unknown>;
const isBody = (value: unknown): value is Body =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const single = (value: unknown) => (typeof value === 'string' ? sanitizeText(value) : value);
const multi = (value: unknown) =>
  typeof value === 'string' ? sanitizeText(value, { multiline: true }) : value;

function withDetails(value: unknown): unknown {
  if (!isBody(value) || typeof value.text !== 'string') return value;
  return { ...value, text: sanitizeProductDetails(value.text).text };
}

function withFiles(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((file) => (isBody(file) ? { ...file, filename: single(file.filename) } : file));
}

/** `POST /api/revisions` and the pipeline payload: ids, file names, details and notes. */
export function sanitizeSubmitBody(body: unknown): unknown {
  if (!isBody(body)) return body;
  const out: Body = { ...body };
  if ('productId' in out) out.productId = single(out.productId);
  if ('inputs' in out) out.inputs = withFiles(out.inputs);
  if ('productMetadata' in out) out.productMetadata = withDetails(out.productMetadata);
  if ('notes' in out) out.notes = multi(out.notes);
  if (isBody(out.requests)) out.requests = { ...out.requests, notes: multi(out.requests.notes) };
  return out;
}

/** A review decision: its notes. */
export function sanitizeReviewBody(body: unknown): unknown {
  if (!isBody(body) || !('notes' in body)) return body;
  return { ...body, notes: multi(body.notes) };
}

/** `POST /api/uploads/presign`: the product id and the file name. */
export function sanitizePresignBody(body: unknown): unknown {
  if (!isBody(body)) return body;
  const out: Body = { ...body };
  if ('productId' in out) out.productId = single(out.productId);
  if ('filename' in out) out.filename = single(out.filename);
  return out;
}
