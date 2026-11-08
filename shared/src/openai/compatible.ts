import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

/**
 * What the two OpenAI-compatible transports share: a LiteLLM gateway (`litellm`) and
 * OpenAI's own API (`openai`). Both take `Authorization: Bearer <key>`, both speak
 * `/v1/images/edits` and `/v1/chat/completions`, and both report errors as
 * `{ error: { message, type, code } }` (https://developers.openai.com/api/reference/overview).
 *
 * Raw `fetch`, not the `openai` SDK, on purpose: the SDK retries twice by default, which would
 * stack on the durable step's three attempts and turn one throttled image into nine paid calls.
 */

export type CompatibleProvider = 'litellm' | 'openai';

/**
 * How long one image call may take. A view at the registry's default size and quality takes
 * about 90 s alone; OpenAI runs two calls at once and queues the rest, so the last of the three
 * views made from the front can take about 200 s. Well under the pipeline Lambda's 900 s per
 * invocation, which also has to hold the front call before them.
 */
export const IMAGE_CALL_TIMEOUT_MS = 300_000;

/** `IMAGE_CALL_TIMEOUT_MS`, unless the environment sets a positive number of milliseconds. */
export function imageCallTimeout(env: NodeJS.ProcessEnv = process.env): number {
  const set = Number(env.IMAGE_CALL_TIMEOUT_MS);
  return Number.isFinite(set) && set > 0 ? set : IMAGE_CALL_TIMEOUT_MS;
}

export interface OpenAICompatibleConfig {
  baseUrl: string;
  apiKey: () => Promise<string>;
  fetch: typeof fetch;
  /** The image adapter's request timeout (`IMAGE_CALL_TIMEOUT_MS`); the analyser sets its own. */
  timeoutMs: number;
  /** Sent on every request besides the key: OpenAI's `OpenAI-Organization` / `OpenAI-Project`. */
  headers?: Record<string, string>;
  /** Who answers, for the error class and its wording. Omitted means the LiteLLM gateway. */
  provider?: CompatibleProvider;
}

export async function authHeaders(
  config: OpenAICompatibleConfig,
  extra: Record<string, string> = {},
): Promise<Record<string, string>> {
  return { Authorization: `Bearer ${await config.apiKey()}`, ...config.headers, ...extra };
}

export const answererOf = (config: Pick<OpenAICompatibleConfig, 'provider'>) =>
  config.provider === 'openai' ? 'OpenAI' : 'gateway';

// --- Keys ------------------------------------------------------------------------------------

const secretCache = new Map<string, Promise<string>>();

/**
 * The key held by a Secrets Manager secret: the bare key, or a JSON object with an `apiKey`
 * field. Read once per process and ARN (a failed read is forgotten, so the next call tries
 * again), and never logged or put in an error message.
 */
export function readKeySecret(arn: string, label: string): Promise<string> {
  let cached = secretCache.get(arn);
  if (!cached) {
    cached = fetchKeySecret(arn, label).catch((err: unknown) => {
      secretCache.delete(arn);
      throw err;
    });
    secretCache.set(arn, cached);
  }
  return cached;
}

async function fetchKeySecret(arn: string, label: string): Promise<string> {
  const out = await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: arn }));
  const raw = out.SecretString?.trim();
  if (!raw) throw new Error(`${label} key secret is empty`);
  if (raw.startsWith('{')) {
    const parsed = JSON.parse(raw) as { apiKey?: unknown };
    if (typeof parsed.apiKey !== 'string' || !parsed.apiKey) { // pragma: allowlist secret
      throw new Error(`${label} key secret has no apiKey field`);
    }
    return parsed.apiKey;
  }
  return raw;
}

/**
 * The key a process uses: the environment value when set (a laptop, a script), otherwise the
 * secret (a deployed Lambda), otherwise a rejection naming both ways to provide one.
 */
export function keySource(
  label: string,
  names: { direct: string; secret: string },
  env: NodeJS.ProcessEnv,
  readSecret: (arn: string) => Promise<string> = (arn) => readKeySecret(arn, label),
): () => Promise<string> {
  const direct = env[names.direct]?.trim();
  const secretArn = env[names.secret]?.trim();
  return () => {
    if (direct) return Promise.resolve(direct);
    if (!secretArn) {
      return Promise.reject(
        new Error(`${label} key missing: set ${names.direct} or ${names.secret}`),
      );
    }
    return readSecret(secretArn);
  };
}

// --- Errors ----------------------------------------------------------------------------------

export interface ProviderReason {
  code?: string;
  type?: string;
  message: string;
}

/** The error body as a short reason. Never contains the key. */
export function gatewayReason(body: string): ProviderReason {
  try {
    const parsed = JSON.parse(body) as {
      error?: { message?: unknown; code?: unknown; type?: unknown };
    };
    const error = parsed.error ?? {};
    const code = typeof error.code === 'string' ? error.code : undefined;
    const type = typeof error.type === 'string' ? error.type : undefined;
    const message = typeof error.message === 'string' ? error.message : body;
    return { code, type, message: message.slice(0, 300) };
  } catch {
    return { message: body.slice(0, 300) };
  }
}

interface ErrorDetail {
  code?: string;
  type?: string;
  /** OpenAI's `x-request-id`, the one thing its support can look a call up by. */
  requestId?: string;
}

/**
 * An answer that is not a success and not one of the classified cases below. It carries the HTTP
 * status where the pipeline's retry classification looks for one (`$metadata.httpStatusCode`),
 * so a rate-limit 429, a 408 or a 5xx is retried and any other 4xx is not.
 */
export class ProviderHttpError extends Error {
  readonly $metadata: { httpStatusCode: number };
  readonly code?: string;
  readonly type?: string;
  readonly requestId?: string;

  constructor(
    readonly status: number,
    message: string,
    detail: ErrorDetail = {},
  ) {
    super(message);
    this.name = 'ProviderHttpError';
    this.$metadata = { httpStatusCode: status };
    this.code = detail.code;
    this.type = detail.type;
    this.requestId = detail.requestId;
  }
}

export class LiteLLMError extends ProviderHttpError {
  constructor(status: number, message: string, detail?: ErrorDetail) {
    super(status, message, detail);
    this.name = 'LiteLLMError';
  }
}

export class OpenAIError extends ProviderHttpError {
  constructor(status: number, message: string, detail?: ErrorDetail) {
    super(status, message, detail);
    this.name = 'OpenAIError';
  }
}

/**
 * Terminal: the key cannot call the model (401, 403), or the account is out of quota or credit.
 * OpenAI answers the latter with a 429 but says "Retrying … won't restore API access"
 * (https://developers.openai.com/api/docs/guides/error-codes), so this carries no
 * `$metadata.httpStatusCode` for the retry policy to read.
 */
export class ProviderAccessError extends Error {
  override name = 'ProviderAccessError';

  constructor(
    readonly status: number,
    message: string,
    readonly detail: ErrorDetail = {},
  ) {
    super(message);
  }
}

/**
 * OpenAI's moderation refusals: the input's fault, so retrying would pay to fail again. OpenAI
 * says to use `error.code` as the stable discriminator and not to retry
 * (https://developers.openai.com/api/docs/guides/image-generation); the HTTP status it comes with
 * is not documented, so it is matched whatever the status. `content_policy_violation` is the
 * older spelling LiteLLM passes through.
 */
const REFUSAL_CODES = new Set(['content_policy_violation', 'moderation_blocked']);
/** Every image-generation input OpenAI rejects as the user's fault, moderation included. */
const REFUSAL_TYPES = new Set(['image_generation_user_error']);

/**
 * Quota and billing exhaustion (https://developers.openai.com/api/docs/guides/rate-limits and
 * error-codes): a 429 that no amount of waiting clears.
 */
const QUOTA_CODES = new Set([
  'insufficient_quota',
  'credit_balance_exhausted',
  'organization_spend_limit_exceeded',
  'project_spend_limit_exceeded',
  'organization_usage_limit_exceeded',
]);
const QUOTA_TYPES = new Set(['insufficient_quota']);

export type ProviderFailure =
  { kind: 'refused'; reason: ProviderReason; requestId?: string } | { kind: 'error'; error: Error };

/**
 * A refusal is returned for the caller to raise as its own terminal error (`ContentRefusedError`,
 * `AnalysisInvalidError`); anything else comes back as the error to throw.
 *
 * Whether LiteLLM passes OpenAI's `code` and `type` through unchanged is not verified; when it
 * does not, a gateway quota 429 is retried like a rate limit, which costs at most the step's
 * three attempts.
 */
export function classifyFailure(
  config: Pick<OpenAICompatibleConfig, 'provider'>,
  entryId: string,
  response: Pick<Response, 'status' | 'headers'>,
  body: string,
): ProviderFailure {
  const reason = gatewayReason(body);
  const requestId = response.headers.get('x-request-id') ?? undefined;
  const { status } = response;
  const detail = { code: reason.code, type: reason.type, requestId };

  if (
    (reason.code && REFUSAL_CODES.has(reason.code)) ||
    (reason.type && REFUSAL_TYPES.has(reason.type))
  ) {
    return { kind: 'refused', reason, requestId };
  }

  const answerer = answererOf(config);
  const suffix = requestId ? ` (request ${requestId})` : '';
  const message = `${entryId}: ${answerer} answered ${status}: ${reason.message}${suffix}`;

  if (
    status === 401 ||
    status === 403 ||
    (reason.code && QUOTA_CODES.has(reason.code)) ||
    (reason.type && QUOTA_TYPES.has(reason.type))
  ) {
    return { kind: 'error', error: new ProviderAccessError(status, message, detail) };
  }

  const ErrorClass = config.provider === 'openai' ? OpenAIError : LiteLLMError;
  return { kind: 'error', error: new ErrorClass(status, message, detail) };
}

export function refusalText(failure: { reason: ProviderReason; requestId?: string }): string {
  const code = failure.reason.code ?? failure.reason.type;
  const id = failure.requestId ? ` (request ${failure.requestId})` : '';
  return `${code ? `${code}: ` : ''}${failure.reason.message}${id}`;
}
