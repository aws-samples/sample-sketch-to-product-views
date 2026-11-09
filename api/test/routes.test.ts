import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mock, test } from 'node:test';
import { ROUTES, handler } from '../src/handler.js';
import { badRequest, caller, parseBody, HttpError, type ApiEvent } from '../src/http.js';
import { ORIGIN_HEADER, fromCloudFront, originSecrets } from '../src/origin.js';
import { pipelineInputSchema, presignRequestSchema, type PipelineState } from '@sketch-to-product-views/contracts';
import * as realGuardrail from '@sketch-to-product-views/shared/guardrail';
// Bound before the store is mocked below: the real key builder and ownership check.
import { inputKey, isOwnedKey } from '@sketch-to-product-views/shared/store';

const TERRAFORM = join(import.meta.dirname, '../../infra/modules/api/main.tf');

/**
 * Routes implemented here whose Terraform side is still to add. Remove each key once it appears
 * in `locals.routes`; the test fails if one is declared there and still listed.
 */
const PENDING_INFRA_ROUTES = new Set<string>([]);

/** What CloudFront adds as an origin custom header; read per request by the handler. */
const ORIGIN_SECRET = 'test-origin-secret'; // pragma: allowlist secret
process.env.ORIGIN_VERIFY_SECRETS = ORIGIN_SECRET;

/** Minimal payload-v2 event, as CloudFront forwards it. Only the fields the handlers read. */
function eventFor(routeKey: string, extra: Partial<ApiEvent> = {}): ApiEvent {
  return {
    routeKey,
    headers: { [ORIGIN_HEADER]: ORIGIN_SECRET },
    requestContext: {
      requestId: 'test-request',
      authorizer: { jwt: { claims: { sub: 'user-1', name: 'Reviewer One' }, scopes: [] } },
    },
    ...extra,
  } as unknown as ApiEvent;
}

test('the dispatch table matches the routes Terraform creates', () => {
  const tf = readFileSync(TERRAFORM, 'utf8');
  const block = /locals\s*\{\s*routes\s*=\s*\[([^\]]*)\]/.exec(tf);
  assert.ok(block, 'could not find local.routes in infra/modules/api/main.tf');

  const declared = [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();
  const implemented = Object.keys(ROUTES)
    .filter((key) => !PENDING_INFRA_ROUTES.has(key))
    .sort();

  for (const key of PENDING_INFRA_ROUTES) {
    assert.ok(Object.hasOwn(ROUTES, key), `${key} is pending infra but has no handler`);
    assert.ok(!declared.includes(key), `${key} is in Terraform now; drop it from the pending set`);
  }

  // Without a $default route, a route only Terraform knows about invokes a handler that
  // does not exist, and one only the handler knows about is never reachable.
  assert.deepEqual(implemented, declared);
});

// ── Bypass protection: only CloudFront knows the origin secret ─────────────

test('a request without the origin secret is a 403 before any route runs', async () => {
  // A valid JWT and an unknown route: the 403 must win over the 404, so no route ran.
  const event = eventFor('DELETE /api/revisions/{id}', { headers: {} } as Partial<ApiEvent>);
  const result = (await handler(event)) as { statusCode: number; body: string };
  assert.equal(result.statusCode, 403);
  assert.deepEqual(JSON.parse(result.body), { error: 'Forbidden.' });
});

test('a wrong origin secret is a 403, even one that shares a prefix', async () => {
  for (const value of ['nope', `${ORIGIN_SECRET}x`, ORIGIN_SECRET.slice(0, -1), '']) {
    const event = eventFor('GET /api/models', {
      headers: { [ORIGIN_HEADER]: value },
    } as Partial<ApiEvent>);
    assert.equal(((await handler(event)) as { statusCode: number }).statusCode, 403, value);
  }
});

test('with no secret configured every request is refused (fail closed)', async () => {
  const saved = process.env.ORIGIN_VERIFY_SECRETS;
  process.env.ORIGIN_VERIFY_SECRETS = '';
  try {
    const result = (await handler(eventFor('GET /api/models'))) as { statusCode: number };
    assert.equal(result.statusCode, 403);
  } finally {
    process.env.ORIGIN_VERIFY_SECRETS = saved;
  }
});

test('during a rotation both the old and the new secret are accepted', () => {
  const secrets = originSecrets({ ORIGIN_VERIFY_SECRETS: 'old-secret, new-secret' });
  assert.deepEqual(secrets, ['old-secret', 'new-secret']);
  assert.ok(fromCloudFront({ [ORIGIN_HEADER]: 'old-secret' }, secrets));
  assert.ok(fromCloudFront({ [ORIGIN_HEADER]: 'new-secret' }, secrets));
  assert.ok(!fromCloudFront({ [ORIGIN_HEADER]: 'other' }, secrets));
  assert.ok(!fromCloudFront(undefined, secrets));
  assert.ok(!fromCloudFront({ [ORIGIN_HEADER]: 'old-secret' }, []));
});

test('CloudFront sends the header the function checks', () => {
  const tf = readFileSync(join(import.meta.dirname, '../../infra/modules/web/main.tf'), 'utf8');
  assert.match(tf, new RegExp(`name\\s*=\\s*"${ORIGIN_HEADER}"`));
});

test('an unmatched route key reports the drift rather than a bare 404', async () => {
  const result = await handler(eventFor('DELETE /api/revisions/{id}'));
  assert.equal((result as { statusCode: number }).statusCode, 404);
  assert.match((result as { body: string }).body, /DELETE \/api\/revisions/);
});

test('an unexpected throw becomes a 500 that names the request id and nothing else', async () => {
  // No TABLE_NAME in the test environment, so the store throws on the first call.
  delete process.env.TABLE_NAME;
  const result = (await handler(
    eventFor('GET /api/revisions/{id}', { pathParameters: { id: 'r1' } } as Partial<ApiEvent>),
  )) as { statusCode: number; body: string };

  assert.equal(result.statusCode, 500);
  assert.match(result.body, /test-request/);
  assert.doesNotMatch(result.body, /TABLE_NAME/);
});

test('a validation failure names the field that failed', () => {
  const parsed = presignRequestSchema.safeParse({ productId: 'MODEL-9' });
  assert.equal(parsed.success, false);
  if (parsed.success) return;

  const result = badRequest(parsed.error) as { statusCode: number; body: string };
  assert.equal(result.statusCode, 400);
  // The SPA shows this string verbatim, so "Required" on its own would be useless.
  assert.match(JSON.parse(result.body).error, /^filename: /);
});

test('a body that is not JSON is a 400, not a 500', () => {
  assert.throws(
    () => parseBody(eventFor('POST /api/revisions', { body: '{oops' } as Partial<ApiEvent>)),
    {
      statusCode: 400,
    },
  );
});

test('a base64 body is decoded before parsing', () => {
  const body = Buffer.from(JSON.stringify({ decision: 'approve' })).toString('base64');
  const parsed = parseBody(
    eventFor('POST /api/revisions/{id}/review', {
      body,
      isBase64Encoded: true,
    } as Partial<ApiEvent>),
  );
  assert.deepEqual(parsed, { decision: 'approve' });
});

test('the caller comes from validated JWT claims, never from the body', () => {
  assert.deepEqual(caller(eventFor('POST /api/revisions')), {
    sub: 'user-1',
    name: 'Reviewer One',
  });
});

test('a subject that could not be a key prefix is a 403 before the role is assumed', async () => {
  // With the user-data role configured every route runs as its caller; an unusable `sub`
  // must stop here, not reach STS (there is no STS client in this test to reach).
  process.env.USER_DATA_ROLE_ARN = 'arn:aws:iam::000000000000:role/test-api-user-data';
  try {
    const event = eventFor('GET /api/models');
    (event.requestContext.authorizer as unknown as { jwt: { claims: { sub: string } } }).jwt.claims.sub =
      'user/../other';
    const result = (await handler(event)) as { statusCode: number };
    assert.equal(result.statusCode, 403);
  } finally {
    delete process.env.USER_DATA_ROLE_ARN;
  }
});

test('a request with no verified subject is rejected rather than treated as anonymous', () => {
  const event = eventFor('POST /api/revisions');
  (event.requestContext as { authorizer?: unknown }).authorizer = undefined;
  assert.throws(
    () => caller(event),
    (error: unknown) => error instanceof HttpError && error.statusCode === 401,
  );
});

test('an unauthenticated submit is a 401 before anything is written', async () => {
  const event = eventFor('POST /api/revisions', {
    body: JSON.stringify({ productId: 'MODEL-9', inputs: [] }),
  } as Partial<ApiEvent>);
  (event.requestContext as { authorizer?: unknown }).authorizer = undefined;

  // 401 rather than the 400 the empty `inputs` would earn: identity is resolved first, so
  // no revision row or rail event exists by the time the body is looked at.
  const result = (await handler(event)) as { statusCode: number };
  assert.equal(result.statusCode, 401);
});

test('confirm refuses a key it could not have minted', async () => {
  const result = (await handler(
    eventFor('POST /api/uploads/confirm', {
      body: JSON.stringify({ key: 'delivery/someone-else/front.png' }),
    } as Partial<ApiEvent>),
  )) as { statusCode: number };

  // Short-circuits before the HEAD, so confirm cannot report back on objects the caller
  // never uploaded.
  assert.equal(result.statusCode, 400);
});

test("confirm refuses another user's upload key, even one shaped exactly right", async () => {
  // The caller is user-1; this key was minted for user-2.
  const result = (await handler(
    eventFor('POST /api/uploads/confirm', {
      body: JSON.stringify({ key: inputKey('user-2', 'MODEL-1', 'sketch.png') }),
    } as Partial<ApiEvent>),
  )) as { statusCode: number };
  assert.equal(result.statusCode, 400);
});

test("upload keys live under the owner's own prefix, and an id that could escape it throws", () => {
  const key = inputKey('user-1', 'MODEL-1', 'sketch.png');
  assert.match(key, /^user\/user-1\/product\/MODEL-1\/uploads\/[\w-]+\/sketch\.png$/);
  assert.equal(isOwnedKey('user-1', key), true);
  assert.equal(isOwnedKey('user-2', key), false);
  // A prefix of another id is not that id's prefix.
  assert.equal(isOwnedKey('user', key), false);
  for (const bad of ['', 'a/b', 'a#b', '../x', 'a b', 'a*']) {
    assert.throws(() => inputKey(bad, 'MODEL-1', 'sketch.png'), /invalid owner id/, bad);
  }
});

// ── Per-revision authorization ──────────────────────────────────────────────
//
// These drive the route functions directly against a mocked store, because the store is
// the only thing standing between the authorization check and DynamoDB. The mock is
// installed once — the runtime refuses to re-mock a specifier — and each test swaps the
// state it returns.

let mockOwner = 'user-1';
/**
 * When true the mocked store returns the revision whoever asks, which is what a key built the
 * wrong way would do: the ownership check behind the key must still refuse it.
 */
let mockIgnoresKey = false;
/** The owner part of every revision address the routes looked up. */
const lookedUpAs: string[] = [];
let mockRegenerations: PipelineState['regenerations'];

const mockState = (): PipelineState => ({
  revisionId: 'r1',
  productId: 'MODEL-9',
  revision: 1,
  status: 'awaiting_review',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  modelId: 'stub',
  attemptBudget: 3,
  attempt: 0,
  inputs: [],
  stages: {},
  candidates: [],
  events: [],
  owner: mockOwner,
  ...(mockRegenerations ? { regenerations: mockRegenerations } : {}),
});

/** What submit handed to `createRevision`, and what it invoked the pipeline with. */
const created: Record<string, unknown>[] = [];
const invoked: { FunctionName?: string; DurableExecutionName?: string; Payload?: Uint8Array }[] =
  [];

class FakeCommand {
  constructor(readonly input: Record<string, unknown>) {}
}
mock.module('@aws-sdk/client-lambda', {
  namedExports: {
    LambdaClient: class {
      async send(command: FakeCommand) {
        invoked.push(command.input as (typeof invoked)[number]);
        return {};
      }
    },
    InvokeCommand: FakeCommand,
    SendDurableExecutionCallbackSuccessCommand: FakeCommand,
  },
});

mock.module('@sketch-to-product-views/shared/store', {
  namedExports: {
    // Like DynamoDB under `USER#{owner}#REV#{id}`: only the owner's own key finds it.
    getRevision: async (ref: { owner: string; revisionId: string }) => {
      lookedUpAs.push(ref.owner);
      return mockIgnoresKey || ref.owner === mockOwner ? mockState() : undefined;
    },
    isOwnedKey,
    etagFor: () => 'W/"stub"',
    presignDownload: async (key: string) => `https://example.invalid/${key}`,
    createRevision: async (input: Record<string, unknown>) => {
      created.push(input);
      return mockState();
    },
    emit: async () => ({}),
    // No callback token recorded, so an authorized review stops at the 409 rather than
    // reaching into the Lambda client.
    getReviewCallbackId: async () => undefined,
    getArtifact: async () => new Uint8Array(),
  },
});
mock.module('../src/routes/models.js', {
  namedExports: {
    attemptBudgetFromEnv: () => 2,
    models: async () => ({}),
  },
});

// The review route screens notes with ApplyGuardrail: a fake client blocks "Ignore …".
const screened: string[] = [];
mock.module('@sketch-to-product-views/shared/guardrail', {
  namedExports: {
    ...realGuardrail,
    screenText: (fields: realGuardrail.ScreenField[]) =>
      realGuardrail.screenText(fields, {
        guardrail: { id: 'gr-test', version: '1' },
        client: {
          send: async (command: { input: { content: { text: { text: string } }[] } }) => {
            const text = command.input.content[0].text.text;
            screened.push(text);
            return /^Ignore/.test(text)
              ? {
                  action: 'GUARDRAIL_INTERVENED',
                  assessments: [
                    { contentPolicy: { filters: [{ type: 'PROMPT_ATTACK', action: 'BLOCKED' }] } },
                  ],
                }
              : { action: 'NONE', assessments: [] };
          },
        } as never,
      }),
  },
});

// A cache-busting query, so this instance of the module binds the mocked store rather than
// the real one the statically imported handler above already holds.
const authzModule = '../src/routes/revisions.js?authz=1';
const revisions = (await import(authzModule)) as typeof import('../src/routes/revisions.js');

function revisionEvent(sub: string | undefined, body?: unknown): ApiEvent {
  const event = eventFor('GET /api/revisions/{id}', {
    pathParameters: { id: 'r1' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  } as Partial<ApiEvent>);
  if (sub === undefined) (event.requestContext as { authorizer?: unknown }).authorizer = undefined;
  else
    (
      event.requestContext.authorizer as unknown as { jwt: { claims: { sub: string } } }
    ).jwt.claims.sub = sub;
  return event;
}

test('the owner can read their own revision', async () => {
  mockOwner = 'user-1';
  const result = (await revisions.status(revisionEvent('user-1'))) as { statusCode: number };
  assert.equal(result.statusCode, 200);
});

test("another user's revision is not found: it is looked up under the caller's own key", async () => {
  mockOwner = 'user-2';
  lookedUpAs.length = 0;
  const read = (await revisions.status(revisionEvent('user-1'))) as {
    statusCode: number;
    body: string;
  };
  // 404, the same answer as for an id that does not exist: the route says nothing about
  // which ids are someone else's.
  assert.equal(read.statusCode, 404);
  assert.doesNotMatch(read.body, /MODEL-9/);

  const resolved = (await revisions.review(revisionEvent('user-1', { decision: 'approve' }))) as {
    statusCode: number;
  };
  assert.equal(resolved.statusCode, 404);
  assert.deepEqual(lookedUpAs, ['user-1', 'user-1']);
});

test('a revision that comes back with another owner is still refused', async () => {
  // The second boundary: if a key were ever built wrongly, the owner check still holds.
  mockOwner = 'user-2';
  mockIgnoresKey = true;
  try {
    const read = (await revisions.status(revisionEvent('user-1'))) as {
      statusCode: number;
      body: string;
    };
    assert.equal(read.statusCode, 404);
    assert.doesNotMatch(read.body, /MODEL-9/);

    const resolved = (await revisions.review(
      revisionEvent('user-1', { decision: 'approve' }),
    )) as { statusCode: number };
    assert.equal(resolved.statusCode, 403);
  } finally {
    mockIgnoresKey = false;
  }
});

test('an unauthenticated read or review is a 401 before the store is touched', async () => {
  mockOwner = 'user-1';
  await assert.rejects(
    () => revisions.status(revisionEvent(undefined)),
    (error: unknown) => error instanceof HttpError && error.statusCode === 401,
  );
  await assert.rejects(
    () => revisions.review(revisionEvent(undefined, { decision: 'approve' })),
    (error: unknown) => error instanceof HttpError && error.statusCode === 401,
  );
});

// ── Submit ──────────────────────────────────────────────────────────────────

process.env.PIPELINE_ALIAS_ARN = 'arn:aws:lambda:us-east-1:000000000000:function:pipeline:live';

const image = (name = 'sketch.jpg') => ({
  role: 'image',
  filename: name,
  url: `https://cdn.invalid/${name}`,
  key: `user/user-1/product/MODEL-1/uploads/u1/${name}`,
});

function submitEvent(body: unknown): ApiEvent {
  return eventFor('POST /api/revisions', { body: JSON.stringify(body) } as Partial<ApiEvent>);
}

async function submitWith(body: unknown) {
  created.length = 0;
  invoked.length = 0;
  return (await revisions.submit(submitEvent(body))) as { statusCode: number; body: string };
}

test("a submission that points at another user's upload is a 400 before anything is written", async () => {
  const foreign = { ...image(), key: 'user/user-2/product/MODEL-1/uploads/u1/sketch.jpg' };
  const result = await submitWith({ productId: 'MODEL-1', inputs: [foreign] });
  assert.equal(result.statusCode, 400);
  assert.match(result.body, /not one of your uploads/);
  assert.equal(created.length, 0);
  assert.equal(invoked.length, 0);

  const keyless = { role: 'image', filename: 'a.jpg', url: 'https://x/a.jpg' };
  assert.equal((await submitWith({ productId: 'MODEL-1', inputs: [keyless] })).statusCode, 400);
});

test('the pipeline is started with the verified caller as its owner', async () => {
  const result = await submitWith({ productId: 'MODEL-1', inputs: [image()] });
  assert.equal(result.statusCode, 202);
  assert.equal(created[0].owner, 'user-1');
  const payload = JSON.parse(Buffer.from(invoked[0].Payload!).toString());
  assert.equal(payload.submittedBy, 'user-1');
});

test('an image-only submission creates one revision and one execution named after it', async () => {
  const result = await submitWith({ productId: 'MODEL-1', inputs: [image()] });
  assert.equal(result.statusCode, 202);
  assert.equal(created.length, 1);
  assert.equal(created[0].productMetadata, undefined);
  assert.equal(invoked.length, 1);
  assert.equal(invoked[0].DurableExecutionName, JSON.parse(result.body).revisionId);
});

test('product metadata with any column names is stored and forwarded verbatim', async () => {
  const text = '{"Color Desc": "IVORY", "Model Desc": "Tracksuit Short"}';
  const result = await submitWith({
    productId: 'MODEL-1',
    inputs: [image()],
    productMetadata: { format: 'json', text },
  });
  assert.equal(result.statusCode, 202);
  const stored = created[0].productMetadata as { text: string };
  assert.deepEqual(JSON.parse(stored.text), JSON.parse(text));
  const payload = JSON.parse(Buffer.from(invoked[0].Payload!).toString('utf8'));
  assert.equal(payload.productMetadata.text, stored.text);
});

test('the pipeline payload matches the pipeline input schema', async () => {
  await submitWith({ productId: 'MODEL-1', inputs: [image(), image('back.jpg')] });
  const payload = JSON.parse(Buffer.from(invoked[0].Payload!).toString('utf8'));
  assert.equal(pipelineInputSchema.safeParse(payload).success, true);
  assert.equal(payload.createdAt, '2026-01-01T00:00:00.000Z');
  assert.equal('metadata' in payload, false);
});

test('a submission with no image is rejected before any revision or execution', async () => {
  const result = await submitWith({ productId: 'MODEL-1', inputs: [] });
  assert.equal(result.statusCode, 400);
  assert.match(result.body, /inputs/);
  assert.equal(created.length, 0);
  assert.equal(invoked.length, 0);
});

test('product details that are not JSON are stored as trimmed text', async () => {
  const result = await submitWith({
    productId: 'MODEL-1',
    inputs: [image()],
    productMetadata: { format: 'json', text: ' oak and boucle, ecru, 78 cm wide \n' },
  });
  assert.equal(result.statusCode, 202);
  assert.deepEqual(created[0].productMetadata, {
    format: 'text',
    text: 'oak and boucle, ecru, 78 cm wide',
  });
});

test('product details of an unknown format are rejected with a 400 naming the problem', async () => {
  const result = await submitWith({
    productId: 'MODEL-1',
    inputs: [image()],
    productMetadata: { format: 'csv', text: 'a,b' },
  });
  assert.equal(result.statusCode, 400);
  assert.match(result.body, /productMetadata/);
  assert.equal(invoked.length, 0);
});

test('empty metadata is rejected rather than sent to the analyser', async () => {
  const result = await submitWith({
    productId: 'MODEL-1',
    inputs: [image()],
    productMetadata: { format: 'json', text: '{}' },
  });
  assert.equal(result.statusCode, 400);
  assert.match(result.body, /no data/);
});

test("untagged images and an older client's swatch are accepted alike", async () => {
  const untagged = {
    filename: 'a.jpg',
    url: 'https://x/a.jpg',
    key: 'user/user-1/product/MODEL-1/uploads/u/a.jpg',
  };
  const swatch = { ...image('TPQ38-9002.jpeg'), role: 'swatch' };
  const result = await submitWith({ productId: 'MODEL-1', inputs: [untagged, swatch] });
  assert.equal(result.statusCode, 202);
  assert.deepEqual(
    (created[0].inputs as { role?: string }[]).map((i) => i.role),
    [undefined, 'swatch'],
  );
});

test('the removed view roles are rejected at the request schema', async () => {
  const result = await submitWith({
    productId: 'MODEL-1',
    inputs: [{ ...image(), role: 'front_sketch' }],
  });
  assert.equal(result.statusCode, 400);
  assert.equal(invoked.length, 0);
});

test('run settings the model offers are stored and forwarded to the pipeline', async () => {
  const settings = { size: '1536x1024', quality: 'medium', complexity: 'low', attemptBudget: 1 };
  const result = await submitWith({ productId: 'MODEL-1', inputs: [image()], settings });
  assert.equal(result.statusCode, 202);
  assert.deepEqual(created[0].settings, settings);
  assert.equal(created[0].attemptBudget, 1);
  const payload = JSON.parse(Buffer.from(invoked[0].Payload!).toString()) as {
    settings?: unknown;
  };
  assert.deepEqual(payload.settings, settings);
});

test('submitted text is sanitised before the schema and stored clean', async () => {
  const result = await submitWith({
    productId: 'MODEL-1\u200b',
    inputs: [image('sketch\u202e.jpg')],
    productMetadata: { format: 'json', text: '{"Color\u200b Desc": "IVORY\u0007"}' },
    notes: '  Darker\u2066 wood\r\n',
  });
  assert.equal(result.statusCode, 202);
  const payload = JSON.parse(Buffer.from(invoked[0].Payload!).toString('utf8'));
  assert.equal(payload.productId, 'MODEL-1');
  assert.equal(payload.inputs[0].filename, 'sketch.jpg');
  assert.deepEqual(JSON.parse(payload.productMetadata.text), { 'Color Desc': 'IVORY' });
  assert.equal(payload.requests.notes, 'Darker wood');
});

test('a setting the model does not offer is a 400 before any revision or execution', async () => {
  for (const settings of [{ size: '999x999' }, { quality: 'ultra' }, { attemptBudget: 9 }]) {
    const result = await submitWith({ productId: 'MODEL-1', inputs: [image()], settings });
    assert.equal(result.statusCode, 400, JSON.stringify(settings));
    assert.equal(created.length, 0);
    assert.equal(invoked.length, 0);
  }
});
