import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AnalysisInvalidError, AnalysisMalformedError } from '@sketch-to-product-views/shared/analyse';
import {
  ContentRefusedError,
  LiteLLMError,
  OpenAIError,
  ProviderAccessError,
} from '@sketch-to-product-views/shared/generate';
import { GuardrailBlockedError } from '@sketch-to-product-views/shared/guardrail';
import { StageFailed, isTransient, retryStrategy } from '../src/handler.js';
import { ValidationError } from '../src/stages/validate.js';

/**
 * These tests pin the retry classification that decides whether the pipeline pays for a
 * second Bedrock generation. Getting it wrong in either direction costs something: a
 * refusal retried three times is money burnt on a certain failure, and a throttle treated
 * as terminal fails a run that would have succeeded on its own.
 */

/** A Bedrock-shaped error: the SDK sets `name` from the modelled exception. */
function awsError(name: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(`${name} raised`), { name }, extra);
}

test('a Bedrock ThrottlingException is transient, because the same request may well succeed', () => {
  assert.equal(isTransient(awsError('ThrottlingException')), true);
});

test('a 429 is transient even when the error name is not one the pipeline knows', () => {
  assert.equal(
    isTransient(awsError('SomeUnlistedException', { $metadata: { httpStatusCode: 429 } })),
    true,
  );
});

test('a 503 is transient, so a Bedrock capacity blip does not fail the run', () => {
  assert.equal(isTransient(awsError('ServiceError', { $metadata: { httpStatusCode: 503 } })), true);
});

test("an error the AWS SDK marked $retryable is transient on the SDK's own word", () => {
  // The SDK's verdict outranks the name list: this error is named nothing recognisable
  // and carries a 400, yet the SDK says it is worth another attempt.
  const error = awsError('MysteryException', {
    $retryable: { throttling: true },
    $metadata: { httpStatusCode: 400 },
  });
  assert.equal(isTransient(error), true);
});

test('a legacy `code` field is classified as well as `name`', () => {
  assert.equal(isTransient(awsError('Error', { code: 'ECONNRESET' })), true);
});

test('a ValidationError is terminal — the same package would fail the same way', () => {
  assert.equal(isTransient(new ValidationError('front.png is not readable')), false);
});

test('a ContentRefusedError is terminal — retrying a refusal pays Bedrock for a repeat no', () => {
  assert.equal(isTransient(new ContentRefusedError('CONTENT_FILTERED')), false);
});

test('a StageFailed wrapping a throttle is transient, read through the cause chain', () => {
  // This is the whole point of carrying `cause`: every stage failure reaches the retry
  // strategy wrapped in a StageFailed, so without the walk a throttle and a refusal are
  // indistinguishable.
  const wrapped = new StageFailed('generate_2d', 'ThrottlingException raised', {
    cause: awsError('ThrottlingException'),
  });
  assert.equal(isTransient(wrapped), true);
});

test('a StageFailed wrapping a refusal stays terminal, read through the cause chain', () => {
  const wrapped = new StageFailed('generate_2d', 'CONTENT_FILTERED', {
    cause: new ContentRefusedError('CONTENT_FILTERED'),
  });
  assert.equal(isTransient(wrapped), false);
});

test('classification stops at the outermost verdict: a throttling name outranks a refusal below it', () => {
  // Documents current behaviour rather than endorsing it. The name check runs before the
  // cause walk, so a transient-looking wrapper hides a terminal cause. `stage()` only ever
  // wraps in `StageFailed`, whose name matches nothing, so this cannot arise in the
  // pipeline as written — but a future wrapper that borrows the inner error's name would
  // reintroduce paid retries of a certain refusal.
  const outer = awsError('ThrottlingException', {
    cause: new ContentRefusedError('CONTENT_FILTERED'),
  });
  assert.equal(isTransient(outer), true);

  const refusalOutermost = Object.assign(new ContentRefusedError('CONTENT_FILTERED'), {
    cause: awsError('ThrottlingException'),
  });
  assert.equal(isTransient(refusalOutermost), false);
});

test('a bare StageFailed with no cause is terminal', () => {
  assert.equal(isTransient(new StageFailed('human_review', 'Reviewer asked to reject.')), false);
});

test('an unknown error is terminal, because fail-fast is the safe direction for a paid call', () => {
  assert.equal(isTransient(new Error('something odd happened')), false);
  assert.equal(isTransient(new TypeError('x is not a function')), false);
});

test('a non-Error value is terminal rather than throwing during classification', () => {
  assert.equal(isTransient('ThrottlingException'), false);
  assert.equal(isTransient(undefined), false);
  assert.equal(isTransient(null), false);
  assert.equal(isTransient({ name: 'ThrottlingException' }), false);
});

test('a self-referential cause cannot loop: the walk is depth-bounded', () => {
  const loop = new Error('round and round');
  (loop as { cause?: unknown }).cause = loop;
  assert.equal(isTransient(loop), false);
});

test('a transient cause buried deeper than the depth bound is not found', () => {
  // Documents the bound rather than endorsing a particular depth: six wrappers is far
  // more nesting than `stage()` can produce, which is why the bound is safe.
  const deep = (levels: number): Error => {
    let error: Error = awsError('ThrottlingException');
    for (let i = 0; i < levels; i += 1) error = new Error(`wrap ${i}`, { cause: error });
    return error;
  };
  assert.equal(isTransient(deep(5)), true);
  assert.equal(isTransient(deep(6)), false);
});

test('retryStrategy refuses to retry a deterministic failure at the first attempt', () => {
  const decision = retryStrategy(new ContentRefusedError('CONTENT_FILTERED'), 1);
  assert.equal(decision.shouldRetry, false);
});

test('retryStrategy retries a transient failure with a deterministic, replay-safe delay', () => {
  const error = awsError('ThrottlingException');
  const first = retryStrategy(error, 1);
  const second = retryStrategy(error, 2);

  assert.equal(first.shouldRetry, true);
  assert.equal(second.shouldRetry, true);
  // Jitter is off on purpose, so the same attempt number must always yield the same delay:
  // the strategy is evaluated outside a step and must not differ between run and replay.
  assert.deepEqual(first.delay, retryStrategy(error, 1).delay);
  assert.deepEqual(second.delay, retryStrategy(error, 2).delay);
  assert.notDeepEqual(first.delay, second.delay, 'the backoff must actually back off');
});

test('retryStrategy stops after three attempts, so a throttle cannot retry forever', () => {
  const error = awsError('ThrottlingException');
  assert.equal(retryStrategy(error, 3).shouldRetry, false);
  assert.equal(retryStrategy(error, 4).shouldRetry, false);
});

test('a LiteLLM gateway throttle or outage is transient', () => {
  assert.equal(isTransient(new LiteLLMError(429, 'gpt-image: gateway answered 429')), true);
  assert.equal(isTransient(new LiteLLMError(503, 'gpt-image: gateway answered 503')), true);
});

test('a LiteLLM 4xx other than a throttle is terminal', () => {
  assert.equal(isTransient(new LiteLLMError(400, 'gpt-image: gateway answered 400')), false);
  assert.equal(isTransient(new LiteLLMError(401, 'gpt-image: gateway answered 401')), false);
});

test('an image call cut by its own timeout is transient', () => {
  const timeout = new Error('The operation was aborted due to timeout');
  timeout.name = 'TimeoutError';
  assert.equal(isTransient(timeout), true);
});

test('a malformed analyser answer is transient — the next call usually follows the schema', () => {
  assert.equal(isTransient(new AnalysisMalformedError('schema: materialCues')), true);
  assert.equal(
    isTransient(new StageFailed('analyse', 'x', { cause: new AnalysisMalformedError('x') })),
    true,
  );
});

test('an analyser refusal is terminal — the same request would be refused again', () => {
  assert.equal(isTransient(new AnalysisInvalidError('refused (content_filtered)')), false);
});

test('an OpenAI rate limit, timeout or overload is transient', () => {
  for (const status of [408, 429, 500, 503]) {
    assert.equal(
      isTransient(new OpenAIError(status, `openai answered ${status}`)),
      true,
      `${status}`,
    );
  }
  assert.equal(
    isTransient(new OpenAIError(429, 'x', { code: 'rate_limit_exceeded', requestId: 'req_1' })),
    true,
  );
});

test('an OpenAI 4xx other than a throttle or timeout is terminal', () => {
  assert.equal(isTransient(new OpenAIError(400, 'openai answered 400')), false);
  assert.equal(isTransient(new OpenAIError(404, 'openai answered 404')), false);
});

test('an exhausted quota is terminal even though OpenAI answers it with a 429', () => {
  const quota = new ProviderAccessError(429, 'openai answered 429: insufficient_quota', {
    code: 'insufficient_quota',
  });
  assert.equal(isTransient(quota), false);
  assert.equal(retryStrategy(quota, 1).shouldRetry, false);
  assert.equal(
    isTransient(new StageFailed('generate_2d', 'x', { cause: quota })),
    false,
    'terminal through the cause chain',
  );
});

test('a denied key is terminal on either transport', () => {
  assert.equal(isTransient(new ProviderAccessError(401, 'openai answered 401')), false);
  assert.equal(isTransient(new ProviderAccessError(403, 'gateway answered 403')), false);
});

test('a terminal access error outranks a transient cause below it', () => {
  const outer = Object.assign(new ProviderAccessError(429, 'quota'), {
    cause: Object.assign(new Error('throttled'), { name: 'ThrottlingException' }),
  });
  assert.equal(isTransient(outer), false);
});

const fetchFailed = (cause: Error) => new TypeError('fetch failed', { cause });

test('a fetch that timed out connecting is transient, like a socket timeout from the AWS SDK', () => {
  const cause = Object.assign(new Error('Connect Timeout Error'), {
    name: 'ConnectTimeoutError',
    code: 'UND_ERR_CONNECT_TIMEOUT',
  });
  assert.equal(isTransient(new StageFailed('analyse', 'x', { cause: fetchFailed(cause) })), true);
});

test('a refused connection is transient, read from the AggregateError fetch puts in cause', () => {
  const refused = (address: string) =>
    Object.assign(new Error(`connect ECONNREFUSED ${address}:443`), { code: 'ECONNREFUSED' });
  const cause = Object.assign(new AggregateError([refused('10.0.0.1'), refused('10.0.0.2')], ''), {
    code: 'ECONNREFUSED',
  });
  assert.equal(isTransient(fetchFailed(cause)), true);
});

test('a host that does not resolve is terminal: the name is configuration, not load', () => {
  const cause = Object.assign(new Error('getaddrinfo ENOTFOUND gateway'), { code: 'ENOTFOUND' });
  assert.equal(isTransient(fetchFailed(cause)), false);
});

test('a guardrail block is terminal, even wrapped in a stage failure', () => {
  const blocked = new GuardrailBlockedError('Design notes', ['prompt attack']);
  assert.equal(isTransient(blocked), false);
  assert.equal(
    isTransient(new StageFailed('validate', blocked.message, { cause: blocked })),
    false,
  );
  assert.equal(retryStrategy(blocked, 1).shouldRetry, false);
});
