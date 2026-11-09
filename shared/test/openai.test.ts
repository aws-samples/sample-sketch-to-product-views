import assert from 'node:assert/strict';
import { test } from 'node:test';
import { adapterFor, createImageGenerator } from '../src/generate/dispatch.js';
import { createOpenAIImageGenerator } from '../src/generate/openai-image.js';
import { ContentRefusedError, type ImageGenerator } from '../src/generate/types.js';
import { openaiConfigFromEnv } from '../src/openai/client.js';
import { OpenAIError, ProviderAccessError, classifyFailure } from '../src/openai/compatible.js';
import { modelById } from '../src/registry/index.js';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const KEY = 'sk-proj-test-not-a-real-key';
const FLARE = 'gpt-image-flare-openai';

/** A fetch that records each call and answers with `respond`. */
function fakeFetch(respond: () => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return respond();
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const ok = () =>
  new Response(JSON.stringify({ data: [{ b64_json: Buffer.from(PNG).toString('base64') }] }), {
    status: 200,
  });

const openaiError = (status: number, error: Record<string, string>, requestId = 'req_123') =>
  new Response(JSON.stringify({ error }), { status, headers: { 'x-request-id': requestId } });

/** The generator exactly as deployed, but with the environment and fetch given here. */
function generator(env: NodeJS.ProcessEnv, respond: () => Response) {
  const fake = fakeFetch(respond);
  const gen = createOpenAIImageGenerator((entry) =>
    openaiConfigFromEnv(entry, env, { fetch: fake.fetch }),
  );
  return { gen, calls: fake.calls };
}

const failureOf = (promise: Promise<unknown>) =>
  promise.then(
    () => assert.fail('expected a rejection'),
    (e: unknown) => e,
  );

// --- openaiConfigFromEnv -------------------------------------------------------------------

test('the base URL is the entry region, so the registry decides where the call is processed', () => {
  const config = openaiConfigFromEnv(modelById(FLARE), { OPENAI_API_KEY: KEY });
  assert.equal(config.baseUrl, 'https://api.openai.com');
  assert.equal(config.provider, 'openai');
  assert.deepEqual(config.headers, {});

  const eu = openaiConfigFromEnv({ ...modelById(FLARE), region: 'eu.api.openai.com' }, {});
  assert.equal(eu.baseUrl, 'https://eu.api.openai.com');
});

test('OPENAI_BASE_URL overrides the host, for tests and proxies', () => {
  const config = openaiConfigFromEnv(modelById(FLARE), {
    OPENAI_BASE_URL: 'http://127.0.0.1:4010/',
  });
  assert.equal(config.baseUrl, 'http://127.0.0.1:4010');
});

test('a key in the environment wins over the secret, which is not read', async () => {
  const read: string[] = [];
  const config = openaiConfigFromEnv(
    modelById(FLARE),
    {
      OPENAI_API_KEY: KEY,
      OPENAI_API_KEY_SECRET_ARN: 'arn:aws:secretsmanager:us-east-1:1:secret:o', // pragma: allowlist secret
    },
    { readSecret: async (arn) => (read.push(arn), 'from-secret') },
  );
  assert.equal(await config.apiKey(), KEY);
  assert.deepEqual(read, []);
});

test('without an environment key the secret named by OPENAI_API_KEY_SECRET_ARN is read', async () => {
  const arn = 'arn:aws:secretsmanager:us-east-1:1:secret:openai';
  const read: string[] = [];
  const config = openaiConfigFromEnv(
    modelById(FLARE),
    { OPENAI_API_KEY_SECRET_ARN: arn },
    { readSecret: async (a) => (read.push(a), 'from-secret') },
  );
  assert.equal(await config.apiKey(), 'from-secret');
  assert.deepEqual(read, [arn]);
});

test('a missing key names both ways to provide one', async () => {
  const config = openaiConfigFromEnv(modelById(FLARE), {});
  await assert.rejects(config.apiKey(), /OPENAI_API_KEY or OPENAI_API_KEY_SECRET_ARN/);
});

test('only an openai entry gets an OpenAI config', () => {
  assert.throws(
    () => openaiConfigFromEnv(modelById('gpt-image-flare'), {}),
    /gpt-image-flare is a litellm model, not an OpenAI one/,
  );
});

// --- The image adapter on OpenAI -----------------------------------------------------------

test('an OpenAI image goes to api.openai.com/v1/images/edits with the snapshot id and the key', async () => {
  const { gen, calls } = generator({ OPENAI_API_KEY: KEY }, ok);
  const result = await gen.generate({
    modelId: FLARE,
    prompt: 'a grey ceramic kettle',
    sketch: PNG,
  });

  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  assert.equal(url, 'https://api.openai.com/v1/images/edits');
  const headers = init.headers as Record<string, string>;
  assert.equal(headers.Authorization, `Bearer ${KEY}`);
  assert.equal(headers['OpenAI-Organization'], undefined);
  assert.equal(headers['OpenAI-Project'], undefined);

  const form = init.body as FormData;
  assert.equal(form.get('model'), 'gpt-image-2.5-flare-2026-09-08');
  assert.equal(form.get('prompt'), 'a grey ceramic kettle');
  assert.equal(form.get('size'), '2336x3504');
  assert.equal(form.get('quality'), 'max');
  // One reference image, in the `image` part, as the gateway gets it.
  assert.equal(form.getAll('image').length, 1);
  assert.equal((form.get('image') as File).type, 'image/png');

  assert.deepEqual([...result.image], [...PNG]);
  assert.equal(result.model.id, FLARE);
  assert.equal(result.model.region, 'api.openai.com');
});

test('several images go to OpenAI as image[] parts, sketch first', async () => {
  const { gen, calls } = generator({ OPENAI_API_KEY: KEY }, ok);
  await gen.generate({ modelId: FLARE, prompt: 'a checked wool cushion', sketch: PNG, references: [PNG] });

  const form = calls[0].init.body as FormData;
  assert.equal(form.getAll('image').length, 0);
  assert.deepEqual(
    (form.getAll('image[]') as File[]).map((f) => f.name),
    ['sketch.png', 'reference-1.png'],
  );
});

test('the organisation and project travel as OpenAI headers when set', async () => {
  const { gen, calls } = generator(
    { OPENAI_API_KEY: KEY, OPENAI_ORGANIZATION: 'org-demo', OPENAI_PROJECT: 'proj_s3d' },
    ok,
  );
  await gen.generate({ modelId: 'gpt-image-sunburst-openai', prompt: 'p', sketch: PNG });
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers['OpenAI-Organization'], 'org-demo');
  assert.equal(headers['OpenAI-Project'], 'proj_s3d');
  assert.equal((calls[0].init.body as FormData).get('model'), 'gpt-image-2.5-sunburst-2026-09-08');
});

test('moderation_blocked is a content refusal whatever the status', async () => {
  for (const status of [400, 403, 422, 500]) {
    const { gen } = generator({ OPENAI_API_KEY: KEY }, () =>
      openaiError(status, {
        type: 'image_generation_user_error',
        code: 'moderation_blocked',
        message: 'Your request was rejected by the safety system.',
      }),
    );
    const err = await failureOf(gen.generate({ modelId: FLARE, prompt: 'p', sketch: PNG }));
    assert.ok(err instanceof ContentRefusedError, `status ${status}`);
    assert.match(err.message, /moderation_blocked/);
    assert.match(err.message, /req_123/);
  }
});

test('an image_generation_user_error with another code is a content refusal too', async () => {
  const { gen } = generator({ OPENAI_API_KEY: KEY }, () =>
    openaiError(400, { type: 'image_generation_user_error', message: 'bad input image' }),
  );
  const err = await failureOf(gen.generate({ modelId: FLARE, prompt: 'p', sketch: PNG }));
  assert.ok(err instanceof ContentRefusedError);
});

test('a quota or billing 429 is terminal: no status for the retry policy to read', async () => {
  for (const code of [
    'insufficient_quota',
    'credit_balance_exhausted',
    'organization_spend_limit_exceeded',
    'project_spend_limit_exceeded',
    'organization_usage_limit_exceeded',
  ]) {
    const { gen } = generator({ OPENAI_API_KEY: KEY }, () =>
      openaiError(429, { type: 'insufficient_quota', code, message: 'You exceeded your quota.' }),
    );
    const err = await failureOf(gen.generate({ modelId: FLARE, prompt: 'p', sketch: PNG }));
    assert.ok(err instanceof ProviderAccessError, code);
    assert.equal(err.status, 429);
    assert.equal((err as { $metadata?: unknown }).$metadata, undefined);
    assert.equal(err.detail.requestId, 'req_123');
  }
});

test('a 401 or 403 is terminal access denial', async () => {
  for (const status of [401, 403]) {
    const { gen } = generator({ OPENAI_API_KEY: KEY }, () =>
      openaiError(status, { type: 'invalid_request_error', message: 'Incorrect API key' }),
    );
    const err = await failureOf(gen.generate({ modelId: FLARE, prompt: 'p', sketch: PNG }));
    assert.ok(err instanceof ProviderAccessError, `status ${status}`);
    assert.doesNotMatch(err.message, new RegExp(KEY));
  }
});

test('a rate-limit 429 and a 503 are OpenAIErrors carrying their status, and never the key', async () => {
  for (const [status, code] of [
    [429, 'rate_limit_exceeded'],
    [503, 'server_is_overloaded'],
  ] as const) {
    const { gen } = generator({ OPENAI_API_KEY: KEY }, () =>
      openaiError(status, { type: 'requests', code, message: 'slow down' }, 'req_abc'),
    );
    const err = await failureOf(gen.generate({ modelId: FLARE, prompt: 'p', sketch: PNG }));
    assert.ok(err instanceof OpenAIError, `status ${status}`);
    assert.equal(err.$metadata.httpStatusCode, status);
    assert.equal(err.code, code);
    assert.equal(err.requestId, 'req_abc');
    assert.match(
      err.message,
      new RegExp(`OpenAI answered ${status}: slow down \\(request req_abc\\)`),
    );
    assert.doesNotMatch(err.message, new RegExp(KEY));
  }
});

test('the OpenAI adapter refuses a LiteLLM model instead of calling OpenAI with an alias', async () => {
  const { gen, calls } = generator({ OPENAI_API_KEY: KEY }, ok);
  await assert.rejects(gen.generate({ modelId: 'gpt-image-flare', prompt: 'p', sketch: PNG }), {
    message: 'gpt-image-flare is a litellm model, not an OpenAI one',
  });
  assert.equal(calls.length, 0);
});

test('the gateway classification names the gateway and keeps LiteLLMError', () => {
  const failure = classifyFailure(
    {},
    'gpt-image-flare',
    new Response('', { status: 502 }),
    '{"error":{"message":"bad gateway"}}',
  );
  assert.equal(failure.kind, 'error');
  if (failure.kind !== 'error') return;
  assert.equal(failure.error.name, 'LiteLLMError');
  assert.match(failure.error.message, /gateway answered 502: bad gateway/);
});

// --- Dispatch ------------------------------------------------------------------------------

function recorder(name: string, log: string[]): ImageGenerator {
  return {
    async generate(request) {
      log.push(`${name}:${request.modelId}`);
      return {
        image: PNG,
        contentType: 'image/png',
        model: modelById(request.modelId!),
        durationMs: 1,
      };
    },
  };
}

test('the dispatcher sends each model to its own provider', async () => {
  const log: string[] = [];
  const generator = createImageGenerator({
    litellm: recorder('litellm', log),
    openai: recorder('openai', log),
  });
  for (const modelId of [
    'gpt-image-flare',
    'gpt-image-flare-openai',
    'gpt-image-sunburst-openai',
  ]) {
    await generator.generate({ modelId, prompt: 'p', sketch: PNG });
  }
  assert.deepEqual(log, [
    'litellm:gpt-image-flare',
    'openai:gpt-image-flare-openai',
    'openai:gpt-image-sunburst-openai',
  ]);
});

test('a provider with no adapter throws rather than falling through to another one', () => {
  const log: string[] = [];
  const adapters = {
    litellm: recorder('litellm', log),
    openai: recorder('openai', log),
  };
  assert.throws(
    () => adapterFor({ id: 'probe', provider: 'azure' as never }, adapters),
    /probe: unsupported provider azure/,
  );
  assert.throws(
    () => adapterFor({ id: 'probe', provider: 'bedrock' }, adapters),
    /probe: no Bedrock image adapter/,
  );
  assert.deepEqual(log, []);
});
