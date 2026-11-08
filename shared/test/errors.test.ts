import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeError, errorSummary, redact } from '../src/errors.js';
import { LiteLLMError, ProviderAccessError } from '../src/openai/compatible.js';

/** The shapes below are the ones Node 24's `fetch` actually throws, reproduced by hand. */
const fetchFailed = (cause: unknown) => new TypeError('fetch failed', { cause });

const connectError = (address: string, code = 'ETIMEDOUT') =>
  Object.assign(new Error(`connect ${code} ${address}:443`), {
    code,
    syscall: 'connect',
    address,
    port: 443,
  });

test('a bare "fetch failed" is summarised with the cause that explains it', () => {
  assert.equal(
    errorSummary(fetchFailed(connectError('192.0.2.10'))),
    'fetch failed: connect ETIMEDOUT 192.0.2.10:443',
  );
});

test("an AggregateError's empty message is replaced by the errors it holds", () => {
  const cause = Object.assign(
    new AggregateError(
      [connectError('10.0.0.1', 'ECONNREFUSED'), connectError('::1', 'ECONNREFUSED')],
      '',
    ),
    { code: 'ECONNREFUSED' },
  );
  assert.equal(
    errorSummary(fetchFailed(cause)),
    'fetch failed: connect ECONNREFUSED 10.0.0.1:443; connect ECONNREFUSED ::1:443',
  );
});

test('a cause the wrapper already quotes is not repeated', () => {
  const inner = new Error('gateway answered 503: busy');
  const outer = new Error('analyse: gateway answered 503: busy', { cause: inner });
  assert.equal(errorSummary(outer), 'analyse: gateway answered 503: busy');
});

test('a self-referential cause ends the walk instead of looping', () => {
  const error = new Error('loop') as Error & { cause?: unknown };
  error.cause = error;
  assert.equal(errorSummary(error), 'loop');
  assert.ok(describeError(error).cause);
});

test('a thrown non-error is still described', () => {
  assert.equal(errorSummary('plain string'), 'plain string');
  assert.deepEqual(describeError(42), { name: 'number', message: '42' });
});

test('the structured form keeps the network fields of each link', () => {
  assert.deepEqual(describeError(fetchFailed(connectError('192.0.2.10'))), {
    name: 'TypeError',
    message: 'fetch failed',
    cause: {
      name: 'Error',
      message: 'connect ETIMEDOUT 192.0.2.10:443',
      code: 'ETIMEDOUT',
      syscall: 'connect',
      address: '192.0.2.10',
      port: 443,
    },
  });
});

test('a provider error keeps its status, code, type and request id', () => {
  const error = new LiteLLMError(429, 'x: gateway answered 429: slow down', {
    code: 'rate_limit_exceeded',
    type: 'requests',
    requestId: 'req_1',
  });
  assert.deepEqual(describeError(error), {
    name: 'LiteLLMError',
    message: 'x: gateway answered 429: slow down',
    code: 'rate_limit_exceeded',
    type: 'requests',
    status: 429,
    requestId: 'req_1',
  });
});

test('an access error reports the detail it carries instead of the retry status', () => {
  const error = new ProviderAccessError(401, 'x: OpenAI answered 401: bad key', {
    code: 'invalid_api_key',
  });
  const info = describeError(error);
  assert.equal(info.status, 401);
  assert.equal(info.code, 'invalid_api_key');
});

test('an AWS SDK exception keeps its HTTP status, request id and fault', () => {
  const error = Object.assign(new Error('Rate exceeded'), {
    name: 'ThrottlingException',
    $fault: 'client',
    $metadata: { httpStatusCode: 429, requestId: 'aws-req-1' },
  });
  assert.deepEqual(describeError(error), {
    name: 'ThrottlingException',
    message: 'Rate exceeded',
    status: 429,
    requestId: 'aws-req-1',
    fault: 'client',
  });
});

// Fake credentials, assembled at run time so secret scanners do not read them as real ones.
const fakeKey = (prefix: string, body: string) => `${prefix}-${body}`;

test('keys, bearer tokens and inline images never survive into the text', () => {
  const bearer = fakeKey('sk', 'abcdefghijklmnop');
  const project = fakeKey('sk-proj', '1234567890abc');
  const text = redact(
    `Authorization: Bearer ${bearer} was rejected; key ${project}; data:image/png;base64,iVBORw0KGgo=`,
  );
  assert.ok(!text.includes('abcdefghijklmnop'));
  assert.ok(!text.includes('1234567890abc'));
  assert.ok(!text.includes('iVBORw0KGgo'));
  assert.equal(
    errorSummary(new Error(`echoed Bearer ${fakeKey('sk', 'secretsecret')}`)),
    'echoed Bearer [redacted]',
  );
});

test('a long message is clipped', () => {
  assert.equal(errorSummary(new Error('x'.repeat(2000))).length, 500);
});
