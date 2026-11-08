import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';
import sharp from 'sharp';
import type { PipelineInput, RawAnalysis } from '@sketch-to-product-views/contracts';
// The real implementations, bound before their modules are mocked: the analyser is the unit
// under test, only the gateway it calls is faked.
import * as realAnalyse from '@sketch-to-product-views/shared/analyse';
import { sniffImageType } from '@sketch-to-product-views/shared/store';
import { fakeContext, fakeStore } from './fakes.js';

// The analyser under test is the gateway entry, answered by the fake fetch below.
process.env.ANALYSER_MODEL = 'analyser-luna-litellm';

const store = fakeStore(sniffImageType);

/** What the fake Bedrock answers next: an analysis, or an error to throw. */
let next: Array<RawAnalysis | Error> = [];
/** Every chat request the fake gateway received, parsed. */
const sent: { messages: { role: string; content: { type: string; text?: string }[] }[] }[] = [];

mock.module('@sketch-to-product-views/shared/store', { namedExports: store.exports });
mock.module('@sketch-to-product-views/shared/analyse', {
  namedExports: {
    ...realAnalyse,
    analyseImages: (input: realAnalyse.AnalyseInput) =>
      realAnalyse.analyseImages(input, {
        litellm: {
          baseUrl: 'https://gateway.test',
          apiKey: async () => 'sk-test',
          timeoutMs: 1000,
          fetch: (async (_url: string, init: RequestInit) => {
            sent.push(JSON.parse(String(init.body)));
            const answer = next.shift();
            if (!answer) throw new Error('no answer queued');
            if (answer instanceof Error) throw answer;
            return new Response(
              JSON.stringify({
                choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(answer) } }],
              }),
            );
          }) as typeof fetch,
        },
      }),
  },
});

const { runDurable, runIntake, StageFailed } = await import('../src/handler.js');

const none = { value: '', source: 'none' } as const;
const sketchRead = { image: 1, kind: 'sketch', views: ['front'], description: 'a sketch' } as const;
const reading = (
  product: Partial<RawAnalysis['product']> = {},
  images: RawAnalysis['images'] = [{ ...sketchRead, views: [...sketchRead.views] }],
): RawAnalysis => ({
  product: {
    type: none,
    colour: none,
    material: none,
    dimensions: none,
    ...product,
  },
  images,
  parts: [],
  details: [],
  ignored: [],
  observedColours: ['navy'],
  materialCues: ['matte woven'],
  assumptions: [],
});

async function packageWith(productMetadata?: string): Promise<PipelineInput> {
  const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#223' } })
    .png()
    .toBuffer();
  store.objects.set('k/sketch.png', png);
  return {
    revisionId: 'r-1',
    productId: 'MODEL-1',
    modelId: 'gpt-image-flare',
    createdAt: '2026-09-28T10:00:00.000Z',
    inputs: [
      { role: 'image', filename: 'sketch.png', url: 'https://x/sketch.png', key: 'k/sketch.png' },
    ],
    ...(productMetadata ? { productMetadata: { format: 'json', text: productMetadata } } : {}),
  };
}

beforeEach(() => {
  store.objects.clear();
  store.revision = {};
  store.events.length = 0;
  sent.length = 0;
  next = [];
});

test('an image-only package ends with a spec observed from the images', async () => {
  next = [reading({ type: { value: 'lounge chair', source: 'image' } })];
  const { ctx, steps } = fakeContext();

  const spec = await runIntake(ctx, await packageWith());

  assert.deepEqual(steps, ['validate', 'analyse', 'complete_spec']);
  assert.equal(spec.productType?.provenance, 'observed');
  assert.deepEqual(spec.colorDescription, { value: 'navy', provenance: 'observed' });
  assert.equal(store.revision.analysis?.product.type.value, 'lounge chair');
  assert.equal(
    store.revision.warning,
    'Only the front view is available; the back and the side will be assumed.',
  );
});

test('metadata with column names no code knows still reaches the spec as supplied', async () => {
  const metadata =
    '{\n  "Model Desc": "Desk Lamp",\n  "Color Desc": "IVORY",\n  "Size": "H 45 cm"\n}';
  next = [
    reading({
      type: { value: 'Desk Lamp', source: 'metadata' },
      colour: { value: 'IVORY', source: 'metadata' },
      dimensions: { value: 'H 45 cm', source: 'metadata' },
    }),
  ];
  const { ctx } = fakeContext();

  const spec = await runIntake(ctx, await packageWith(metadata));

  // Sent verbatim: the pipeline never parsed the keys.
  const content = sent[0].messages[1].content;
  assert.ok(content.at(-1)!.text!.includes(metadata));
  assert.deepEqual(spec.colorDescription, { value: 'ivory', raw: 'IVORY', provenance: 'supplied' });
  assert.equal(spec.productType?.provenance, 'supplied');
  assert.equal(spec.dimensions?.provenance, 'supplied');
  assert.match(
    store.events.at(-1)!.message!,
    /Supplied: productType, colorDescription, dimensions\. Observed: materialDescription\./,
  );
});

test('a metadata value the analyser paraphrased is kept, and its assumptions reach the run', async () => {
  next = [
    {
      ...reading({
        colour: { value: 'OFF-WHITE', source: 'metadata' },
        material: { value: '100% cotton', source: 'metadata' },
      }),
      assumptions: ['The blouse is ivory and the skirt navy.'],
    },
  ];
  const { ctx } = fakeContext();

  const spec = await runIntake(ctx, await packageWith('{"Color Desc": "IVORY"}'));

  // Kept as the analyser gave it: the metadata is not matched word for word any more.
  assert.equal(spec.colorDescription?.value, 'off-white');
  assert.equal(spec.colorDescription?.provenance, 'supplied');
  assert.equal(
    store.revision.warning,
    'Only the front view is available; the back and the side will be assumed. ' +
      'Assumed: The blouse is ivory and the skirt navy. No product type found.',
  );
});

test('a throttle is retried by the durable step and the run carries on', async () => {
  next = [Object.assign(new Error('slow down'), { name: 'ThrottlingException' }), reading()];
  const { ctx, steps } = fakeContext();

  await runIntake(ctx, await packageWith());

  assert.deepEqual(steps, ['validate', 'analyse', 'analyse', 'complete_spec']);
});

test('an analyser that keeps timing out fails the stage and the run after three attempts', async () => {
  const timeout = () => Object.assign(new Error('timed out'), { name: 'TimeoutError' });
  next = [timeout(), timeout(), timeout()];
  const { ctx, steps } = fakeContext();

  await assert.rejects(async () => runIntake(ctx, await packageWith()), StageFailed);

  assert.deepEqual(steps, ['validate', 'analyse', 'analyse', 'analyse']);
  assert.deepEqual(store.events.at(-1), {
    stage: 'analyse',
    status: 'failed',
    message: 'timed out (retry 2)',
  });
  assert.equal(store.revision.spec, undefined);
});

test('an answer that ignored its schema is retried, and the next one is used', async () => {
  // Measured: Bedrock occasionally drops required keys despite structured outputs.
  const { materialCues: _cues, ...missing } = reading();
  next = [missing as RawAnalysis, reading()];
  const { ctx, steps } = fakeContext();

  await runIntake(ctx, await packageWith());

  assert.deepEqual(steps, ['validate', 'analyse', 'analyse', 'complete_spec']);
});

test('an analyser that keeps answering outside its schema fails the run after three attempts', async () => {
  const bad = {
    ...reading(),
    images: [{ ...sketchRead, views: ['detail'] }],
  } as unknown as RawAnalysis;
  next = [bad, bad, bad];
  const { ctx, steps } = fakeContext();

  await assert.rejects(
    async () => runIntake(ctx, await packageWith()),
    /does not match the schema: images\.0\.views/,
  );

  assert.deepEqual(steps, ['validate', 'analyse', 'analyse', 'analyse']);
  assert.equal(store.events.at(-1)?.status, 'failed');
});

test('every stage the intake runs is announced running, then passed', async () => {
  next = [reading()];
  const { ctx } = fakeContext();

  await runIntake(ctx, await packageWith());

  assert.deepEqual(
    store.events.map((e) => `${e.stage}:${e.status}`),
    [
      'validate:running',
      'validate:passed',
      'analyse:running',
      'analyse:passed',
      'complete_spec:running',
      'complete_spec:passed',
    ],
  );
});

test('every image reaches the analyser, which decides which one is the material sample', async () => {
  next = [
    reading({}, [
      { image: 1, kind: 'sketch', views: ['front'], description: 'a sketch' },
      { image: 2, kind: 'material', views: [], description: 'a woven sample' },
    ]),
  ];
  const input = await packageWith();
  store.objects.set('k/sample.png', store.objects.get('k/sketch.png')!);
  // No role: the designer tags nothing.
  input.inputs.push({ filename: 'sample.png', url: 'https://x/s.png', key: 'k/sample.png' });
  const { ctx } = fakeContext();

  const spec = await runIntake(ctx, input);

  const content = sent[0].messages[1].content;
  assert.equal(content.filter((c) => c.type === 'image_url').length, 2);
  assert.deepEqual(spec.imageKinds, ['sketch', 'material']);
  // With a material sample, the colour observed in the sketch is not used.
  assert.equal(spec.colorDescription, undefined);
  assert.deepEqual(
    store.revision.analysis?.images?.map((i) => i.kind),
    ['sketch', 'material'],
  );
});

test('no sketch or photo of the product fails the run at once, saying what each image was read as', async () => {
  next = [reading({}, [{ image: 1, kind: 'material', views: [], description: 'oak veneer' }])];
  const { ctx, steps } = fakeContext();

  await assert.rejects(async () => runIntake(ctx, await packageWith()), StageFailed);

  // Terminal: not retried.
  assert.deepEqual(steps, ['validate', 'analyse']);
  assert.match(
    store.events.at(-1)!.message!,
    /No image is a sketch or a photo of the product \(the analyser read image 1 as a material sample\)/,
  );
});

function fetchFailed(cause: Error): TypeError {
  return new TypeError('fetch failed', { cause });
}

const connectTimeout = () =>
  fetchFailed(
    Object.assign(
      new Error('Connect Timeout Error (attempted address: 192.0.2.10:443, timeout: 10000ms)'),
      { name: 'ConnectTimeoutError', code: 'UND_ERR_CONNECT_TIMEOUT' },
    ),
  );

test('a gateway that cannot be reached is retried, and every attempt is logged with its cause', async () => {
  next = [connectTimeout(), connectTimeout(), connectTimeout()];
  const { ctx, steps, logs } = fakeContext();

  await assert.rejects(async () => runIntake(ctx, await packageWith()), StageFailed);

  assert.deepEqual(steps, ['validate', 'analyse', 'analyse', 'analyse']);
  // The rail says why, not just "fetch failed".
  assert.deepEqual(store.events.at(-1), {
    stage: 'analyse',
    status: 'failed',
    message:
      'fetch failed: Connect Timeout Error (attempted address: 192.0.2.10:443, timeout: 10000ms) (retry 2)',
  });

  const failures = logs.filter((l) => l.record.event === 'stage_failed');
  assert.deepEqual(
    failures.map((l) => [l.level, l.record.stepAttempt, l.record.willRetry]),
    [
      ['warn', 1, true],
      ['warn', 2, true],
      ['error', 3, false],
    ],
  );
  const last = failures.at(-1)!.record;
  assert.equal(last.revisionId, 'r-1');
  assert.equal(last.stage, 'analyse');
  assert.deepEqual(last.model, {
    id: 'analyser-luna-litellm',
    provider: 'litellm',
    region: 'litellm.example.internal',
  });
  assert.deepEqual(last.error, {
    name: 'TypeError',
    message: 'fetch failed',
    cause: {
      name: 'ConnectTimeoutError',
      message: 'Connect Timeout Error (attempted address: 192.0.2.10:443, timeout: 10000ms)',
      code: 'UND_ERR_CONNECT_TIMEOUT',
    },
  });
  assert.ok(!JSON.stringify(logs).includes('sk-test'), 'the key never reaches a log line');
});

test('a gateway host that does not resolve fails at once, logged as an error with its code', async () => {
  next = [
    fetchFailed(
      Object.assign(new Error('getaddrinfo ENOTFOUND litellm.example.internal'), {
        code: 'ENOTFOUND',
        syscall: 'getaddrinfo',
        hostname: 'litellm.example.internal',
      }),
    ),
  ];
  const { ctx, steps, logs } = fakeContext();

  await assert.rejects(
    async () => runIntake(ctx, await packageWith()),
    /fetch failed: getaddrinfo ENOTFOUND litellm\.example\.internal/,
  );

  assert.deepEqual(steps, ['validate', 'analyse']);
  const [failure] = logs.filter((l) => l.record.event === 'stage_failed');
  assert.equal(failure.level, 'error');
  assert.equal(failure.record.willRetry, false);
  assert.deepEqual((failure.record.error as { cause: unknown }).cause, {
    name: 'Error',
    message: 'getaddrinfo ENOTFOUND litellm.example.internal',
    code: 'ENOTFOUND',
    syscall: 'getaddrinfo',
    hostname: 'litellm.example.internal',
  });
});

test('a stage that passes logs one info line and nothing at warn or error', async () => {
  next = [reading()];
  const { ctx, logs } = fakeContext();

  await runIntake(ctx, await packageWith());

  assert.deepEqual(
    logs.map((l) => `${l.level}:${l.record.event}:${l.record.stage}`),
    ['info:stage_passed:validate', 'info:stage_passed:analyse', 'info:stage_passed:complete_spec'],
  );
});

test('a run that fails records the cause on the revision and logs it once', async () => {
  next = [connectTimeout(), connectTimeout(), connectTimeout()];
  const { ctx, logs } = fakeContext();

  const outcome = await runDurable(await packageWith(), ctx);

  assert.equal(outcome.status, 'failed');
  assert.match(store.revision.failureReason ?? '', /^fetch failed: Connect Timeout Error/);
  const runFailed = logs.filter((l) => l.record.event === 'run_failed');
  assert.equal(runFailed.length, 1);
  assert.equal(runFailed[0].level, 'error');
  assert.equal(runFailed[0].record.revisionId, 'r-1');
});

test('an error the run cannot record is logged before it is rethrown', async () => {
  const { ctx, logs } = fakeContext();

  await assert.rejects(runDurable({ revisionId: 'r-bad' }, ctx));

  assert.equal(logs.length, 1);
  assert.equal(logs[0].level, 'error');
  assert.equal(logs[0].record.event, 'unhandled_error');
  assert.equal(logs[0].record.revisionId, 'r-bad');
  assert.equal((logs[0].record.error as { name: string }).name, 'ZodError');
});
