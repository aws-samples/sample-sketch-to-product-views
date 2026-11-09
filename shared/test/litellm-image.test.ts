import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLiteLLMImageGenerator } from '../src/generate/litellm-image.js';
import { createImageGenerator } from '../src/generate/dispatch.js';
import { ContentRefusedError, type ImageGenerator } from '../src/generate/types.js';
import { LiteLLMError, litellmConfigFromEnv, type LiteLLMConfig } from '../src/litellm/client.js';
import { IMAGE_CALL_TIMEOUT_MS } from '../src/openai/compatible.js';
import { defaultFor, modelById } from '../src/registry/index.js';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 9]);
const KEY = 'sk-test-not-a-real-key';

function fakeGateway(respond: () => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const config: LiteLLMConfig = {
    baseUrl: 'https://gateway.test',
    apiKey: async () => KEY,
    timeoutMs: 1_000,
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return respond();
    }) as typeof fetch,
  };
  return { config, calls };
}

const ok = () =>
  new Response(JSON.stringify({ data: [{ b64_json: Buffer.from(PNG).toString('base64') }] }), {
    status: 200,
  });

const entry = modelById('gpt-image-flare');

test('the sketch goes to the edits endpoint as a file, with the registry defaults', async () => {
  const gw = fakeGateway(ok);
  await createLiteLLMImageGenerator(gw.config).generate({
    modelId: 'gpt-image-flare',
    prompt: 'a grey ceramic kettle',
    sketch: JPEG,
  });
  assert.equal(gw.calls.length, 1);
  const { url, init } = gw.calls[0];
  assert.equal(url, 'https://gateway.test/v1/images/edits');
  assert.equal((init.headers as Record<string, string>).Authorization, `Bearer ${KEY}`);
  const form = init.body as FormData;
  assert.equal(form.get('model'), entry.bedrockModelId);
  assert.equal(form.get('prompt'), 'a grey ceramic kettle');
  assert.equal(form.get('size'), '2336x3504');
  assert.equal(form.get('quality'), 'max');
  assert.equal(form.get('input_fidelity'), null);
  const image = form.get('image') as File;
  assert.equal(image.type, 'image/jpeg');
  assert.equal(image.name, 'sketch.jpeg');
  assert.equal(image.size, JPEG.length);
});

test('reference images follow the sketch as repeated image parts', async () => {
  const gw = fakeGateway(ok);
  await createLiteLLMImageGenerator(gw.config).generate({
    modelId: 'gpt-image-flare',
    prompt: 'the back view',
    sketch: JPEG,
    references: [PNG],
  });
  const form = gw.calls[0].init.body as FormData;
  const images = form.getAll('image') as File[];
  assert.deepEqual(
    images.map((f) => [f.name, f.type, f.size]),
    [
      ['sketch.jpeg', 'image/jpeg', JPEG.length],
      ['reference-1.png', 'image/png', PNG.length],
    ],
  );
});

test('a param override replaces the registry default', async () => {
  const gw = fakeGateway(ok);
  await createLiteLLMImageGenerator(gw.config).generate({
    modelId: 'gpt-image-flare',
    prompt: 'p',
    sketch: PNG,
    params: { quality: 'high' },
  });
  assert.equal((gw.calls[0].init.body as FormData).get('quality'), 'high');
});

test('the returned image is decoded, typed from its bytes, and carries no seed', async () => {
  const gw = fakeGateway(ok);
  const result = await createLiteLLMImageGenerator(gw.config).generate({
    modelId: 'gpt-image-flare',
    prompt: 'p',
    sketch: PNG,
  });
  assert.deepEqual([...result.image], [...PNG]);
  assert.equal(result.contentType, 'image/png');
  assert.equal(result.seed, undefined);
  assert.equal(result.model.id, 'gpt-image-flare');
});

test('a moderation refusal is a content refusal, not a retryable error', async () => {
  const gw = fakeGateway(
    () =>
      new Response(
        JSON.stringify({ error: { code: 'moderation_blocked', message: 'blocked by safety' } }),
        { status: 400 },
      ),
  );
  await assert.rejects(
    createLiteLLMImageGenerator(gw.config).generate({
      modelId: 'gpt-image-flare',
      prompt: 'p',
      sketch: PNG,
    }),
    ContentRefusedError,
  );
});

test('a throttle carries its status for the retry policy and never the key', async () => {
  const gw = fakeGateway(
    () => new Response(JSON.stringify({ error: { message: 'rate limit' } }), { status: 429 }),
  );
  const err = await createLiteLLMImageGenerator(gw.config)
    .generate({ modelId: 'gpt-image-flare', prompt: 'p', sketch: PNG })
    .then(
      () => undefined,
      (e: unknown) => e,
    );
  assert.ok(err instanceof LiteLLMError);
  assert.equal(err.$metadata.httpStatusCode, 429);
  assert.match(err.message, /429: rate limit/);
  assert.doesNotMatch(err.message, new RegExp(KEY));
});

test('an unexpected body is reported as a response-shape error naming the model', async () => {
  const gw = fakeGateway(() => new Response('<html>gateway error</html>', { status: 200 }));
  await assert.rejects(
    createLiteLLMImageGenerator(gw.config).generate({
      modelId: 'gpt-image-flare',
      prompt: 'p',
      sketch: PNG,
    }),
    { message: `gpt-image-flare: unrecognised response shape from ${entry.bedrockModelId}` },
  );
});

test('a missing key names both ways to provide one', async () => {
  const config = litellmConfigFromEnv({});
  await assert.rejects(config.apiKey(), /LITELLM_API_KEY or LITELLM_API_KEY_SECRET_ARN/);
  assert.equal(config.baseUrl, 'https://litellm.example.internal');
});

test('a key in the environment wins over the secret', async () => {
  const config = litellmConfigFromEnv({
    LITELLM_API_KEY: KEY,
    LITELLM_API_KEY_SECRET_ARN: 'arn:aws:secretsmanager:us-east-1:1:secret:x', // pragma: allowlist secret
    LITELLM_BASE_URL: 'https://gateway.test/',
  });
  assert.equal(await config.apiKey(), KEY);
  assert.equal(config.baseUrl, 'https://gateway.test');
});

test('the image call timeout is the default unless the environment sets a positive one', () => {
  assert.equal(litellmConfigFromEnv({}).timeoutMs, IMAGE_CALL_TIMEOUT_MS);
  assert.equal(litellmConfigFromEnv({ IMAGE_CALL_TIMEOUT_MS: '900000' }).timeoutMs, 900_000);
  for (const set of ['0', '-1', 'soon']) {
    assert.equal(
      litellmConfigFromEnv({ IMAGE_CALL_TIMEOUT_MS: set }).timeoutMs,
      IMAGE_CALL_TIMEOUT_MS,
    );
  }
});

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

test('the dispatcher sends each model to its provider and fills in the default', async () => {
  const log: string[] = [];
  const generator = createImageGenerator({
    litellm: recorder('litellm', log),
    openai: recorder('openai', log),
  });
  await generator.generate({ modelId: 'gpt-image-flare', prompt: 'p', sketch: PNG });
  await generator.generate({ modelId: 'gpt-image-sunburst', prompt: 'p', sketch: PNG });
  await generator.generate({ prompt: 'p', sketch: PNG });
  assert.deepEqual(log, [
    'litellm:gpt-image-flare',
    'litellm:gpt-image-sunburst',
    'openai:gpt-image-2.6-sunburst-openai',
  ]);
});

test('OpenAI direct is the image generation default and Bedrock entries keep their provider', () => {
  assert.equal(defaultFor('image-control').id, 'gpt-image-2.6-sunburst-openai');
  assert.equal(modelById('critic-sonnet').provider, 'bedrock');
});
