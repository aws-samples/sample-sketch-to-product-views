/**
 * A one-line reason for the run's events and a structured record for CloudWatch.
 *
 * Both walk the `cause` chain: Node's `fetch` rejects every network failure with a bare
 * `TypeError: fetch failed` and puts the real error (`getaddrinfo ENOTFOUND …`, an
 * `AggregateError` of `connect ECONNREFUSED` per address) in `cause`, and the pipeline wraps every
 * stage failure in a `StageFailed`.
 *
 * Nothing here reads a request, a header or a body; the text kept is still redacted, in case a
 * provider echoes a key back in a message.
 */

/** A self-referential `cause` must not turn reporting into an infinite loop. */
const MAX_DEPTH = 5;
/** An `AggregateError` lists one error per address tried; the first few say it all. */
const MAX_ERRORS = 3;
const MAX_TEXT = 500;

export interface ErrorInfo {
  name: string;
  message: string;
  /** Node's `code` (`ENOTFOUND`, `UND_ERR_CONNECT_TIMEOUT`) or the provider's error code. */
  code?: string | number;
  type?: string;
  status?: number;
  requestId?: string;
  /** `client` or `server`, as the AWS SDK classifies its own exceptions. */
  fault?: string;
  syscall?: string;
  hostname?: string;
  address?: string;
  port?: number;
  errors?: ErrorInfo[];
  cause?: ErrorInfo;
}

/** Keys, bearer tokens and inline images, should a provider ever quote one back. */
export function redact(text: string): string {
  return text
    .replace(/Bearer\s+[\w.~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\bsk-[\w-]{8,}/g, 'sk-[redacted]')
    .replace(/data:[\w/+.-]+;base64,[A-Za-z0-9+/=]+/g, 'data:[redacted]');
}

const clip = (text: string, max = MAX_TEXT) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

const str = (value: unknown) => (typeof value === 'string' && value ? value : undefined);
const num = (value: unknown) => (typeof value === 'number' ? value : undefined);

export function describeError(error: unknown, depth = 0): ErrorInfo {
  if (!(error instanceof Error)) {
    return { name: typeof error, message: clip(redact(String(error))) };
  }

  const e = error as Error & {
    code?: unknown;
    type?: unknown;
    status?: unknown;
    requestId?: unknown;
    detail?: { code?: unknown; type?: unknown; requestId?: unknown };
    $fault?: unknown;
    $metadata?: { httpStatusCode?: unknown; requestId?: unknown };
    syscall?: unknown;
    hostname?: unknown;
    address?: unknown;
    port?: unknown;
  };

  const info: ErrorInfo = { name: error.name, message: clip(redact(error.message)) };
  const code = str(e.code) ?? num(e.code) ?? str(e.detail?.code);
  if (code !== undefined) info.code = code;
  const fields: Partial<ErrorInfo> = {
    type: str(e.type) ?? str(e.detail?.type),
    status: num(e.$metadata?.httpStatusCode) ?? num(e.status),
    requestId: str(e.requestId) ?? str(e.detail?.requestId) ?? str(e.$metadata?.requestId),
    fault: str(e.$fault),
    syscall: str(e.syscall),
    hostname: str(e.hostname),
    address: str(e.address),
    port: num(e.port),
  };
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) Object.assign(info, { [key]: value });
  }

  if (depth < MAX_DEPTH) {
    if (error instanceof AggregateError && error.errors.length > 0) {
      info.errors = error.errors
        .slice(0, MAX_ERRORS)
        .map((inner) => describeError(inner, depth + 1));
    }
    if (error.cause !== undefined) info.cause = describeError(error.cause, depth + 1);
  }
  return info;
}

/** What one link of the chain says for itself; an `AggregateError`'s message is often empty. */
function ownText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  if (error.message) return error.message;
  if (error instanceof AggregateError && error.errors.length > 0) {
    return error.errors.slice(0, MAX_ERRORS).map(ownText).filter(Boolean).join('; ');
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : error.name;
}

/**
 * The error and its causes as one line ("fetch failed: connect ETIMEDOUT …"). A cause whose text
 * the line already contains is skipped, so a wrapper that quotes its cause is not repeated.
 */
export function errorSummary(error: unknown, max = MAX_TEXT): string {
  const parts: string[] = [];
  let node: unknown = error;
  for (let depth = 0; node !== undefined && node !== null && depth <= MAX_DEPTH; depth += 1) {
    const text = ownText(node);
    if (text && !parts.some((part) => part.includes(text))) parts.push(text);
    node = node instanceof Error ? node.cause : undefined;
  }
  return clip(redact(parts.join(': ') || 'unknown error'), max);
}
