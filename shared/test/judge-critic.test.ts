import assert from 'node:assert/strict';
import { test } from 'node:test';
import sharp from 'sharp';
import type { ProductSpec } from '@sketch-to-product-views/contracts';
import { resolveModel } from '../src/registry/index.js';
import {
  COMPARISON_MIN_TOKENS,
  CONFIRMATION_TEMPERATURE,
  createJudgeCritic,
  modelImage,
  type CriticRequest,
  type CriticRunner,
} from '../src/qc/judge/index.js';

const entry = resolveModel('critic');

type Answers = Record<string, 'same' | 'different' | 'cant_tell'>;

/**
 * Answers the comparison with `same` everywhere except `turns[n]` on the nth comparison call,
 * and the request check with `requests`. Records every request.
 */
function fakeRunner(
  turns: Answers[] = [],
  { requests = [], usable = true }: { requests?: unknown[]; usable?: boolean } = {},
) {
  const calls: CriticRequest[] = [];
  let comparisons = 0;
  const runner: CriticRunner = async (request) => {
    calls.push(request);
    const usage = { inputTokens: 1, outputTokens: 1 };
    if (request.purpose === 'request check') return { output: { requests }, usage };
    const over = turns[comparisons++] ?? {};
    const shape = (request.schema as unknown as { shape: { aspects: { shape: object } } }).shape;
    const said = (name: string) => ({
      reference: `sketched ${name}`,
      observed: `rendered ${name}`,
      reason: 'compared',
      answer: over[name] ?? 'same',
    });
    return {
      output: {
        aspects: Object.fromEntries(Object.keys(shape.aspects.shape).map((n) => [n, said(n)])),
        parts: [{ part: 'tie belt', ...said('part: tie belt') }],
        image: { usable, imageQuality: 0.9, problems: [] },
      },
      usage,
    };
  };
  return { runner, calls, comparisons: () => calls.filter((c) => c.purpose === 'comparison') };
}

async function noise() {
  const width = 128;
  const data = Buffer.alloc(width * width * 3);
  for (let i = 0; i < data.length; i += 1) data[i] = (i * 97) % 256;
  return new Uint8Array(
    await sharp(data, { raw: { width, height: width, channels: 3 } })
      .png()
      .toBuffer(),
  );
}

const supplied = (value: string) => ({ value, provenance: 'supplied' as const });
const spec: ProductSpec = {
  model: 'BAG-11',
  productType: supplied('Tote bag with tie belt'),
  colorDescription: supplied('OPTICAL WHITE'),
};

async function input(over: Record<string, unknown> = {}) {
  const bytes = await noise();
  return {
    sketch: bytes,
    sketchContentType: 'image/png',
    candidate: bytes,
    candidateContentType: 'image/png',
    spec,
    ...over,
  };
}

test('a view is judged in one call that sees the sketch, the view and the material sample', async () => {
  const fake = fakeRunner();
  const swatch = await noise();
  const evaluation = await createJudgeCritic({ runner: fake.runner }).evaluate(
    await input({ view: 'back', swatch, swatchContentType: 'image/png' }),
  );
  assert.equal(evaluation.verdict, 'pass');
  assert.equal(fake.calls.length, 1);
  const [call] = fake.calls;
  assert.deepEqual(
    call.images.map((i) => i.label),
    ['Sketch', 'Generated image (back view)', 'Material sample'],
  );
  assert.equal(call.minOutputTokens, COMPARISON_MIN_TOKENS);
  assert.equal(evaluation.reviewer, 'judge');
  assert.equal(evaluation.model?.id, entry.id);
  assert.equal(evaluation.confirmation, undefined);
});

test('a part described in other words but answered the same passes', async () => {
  const fake = fakeRunner();
  const evaluation = await createJudgeCritic({ runner: fake.runner }).evaluate(await input());
  const belt = evaluation.attributes?.find((a) => a.attribute === 'part: tie belt');
  assert.equal(belt?.outcome, 'match');
  assert.equal(evaluation.verdict, 'pass');
});

test('a soft difference warns in one call, its issue kept', async () => {
  const fake = fakeRunner([{ proportions: 'different', 'part: tie belt': 'different' }]);
  const evaluation = await createJudgeCritic({ runner: fake.runner }).evaluate(await input());
  assert.equal(evaluation.verdict, 'warn');
  assert.equal(fake.calls.length, 1);
  assert.deepEqual(
    evaluation.issues.map((i) => i.split(':')[0]),
    ['proportions', 'part'],
  );
});

test('a wrong colour fails only after a second request, at its own temperature, agrees', async () => {
  const fake = fakeRunner([{ color: 'different' }, { color: 'different' }]);
  const evaluation = await createJudgeCritic({ runner: fake.runner }).evaluate(await input());
  assert.equal(evaluation.verdict, 'fail');
  const [first, second] = fake.comparisons();
  assert.equal(second.system, first.system);
  assert.equal(second.images.length, first.images.length);
  assert.equal(first.temperature, undefined, 'the first reading keeps the entry temperature');
  assert.equal(second.temperature, CONFIRMATION_TEMPERATURE);
  assert.deepEqual(evaluation.confirmation, { failedOn: ['color'], confirmed: ['color'] });
});

test('a second reading that disagrees downgrades the fail to a warn', async () => {
  const fake = fakeRunner([{ object_type: 'different' }, {}]);
  const evaluation = await createJudgeCritic({ runner: fake.runner }).evaluate(await input());
  assert.equal(evaluation.verdict, 'warn');
  assert.equal(fake.calls.length, 2);
  assert.deepEqual(evaluation.confirmation, { failedOn: ['object_type'], confirmed: [] });
  assert.match(evaluation.issues[0], /a second reading disagreed/);
});

test('an unusable image is confirmed like any hard fact', async () => {
  const fake = fakeRunner([], { usable: false });
  const evaluation = await createJudgeCritic({ runner: fake.runner }).evaluate(await input());
  assert.equal(evaluation.verdict, 'fail');
  assert.equal(fake.comparisons().length, 2);
  assert.equal(evaluation.issues[0], 'presentation: not a usable studio product image');
});

test('a request confidently not applied fails the view, named first among its issues', async () => {
  const fake = fakeRunner([], {
    requests: [
      { applied: true, confidence: 0.9, note: 'the strap is longer' },
      { applied: false, confidence: 0.8, note: 'the zip is still visible' },
    ],
  });
  const evaluation = await createJudgeCritic({ runner: fake.runner }).evaluate(
    await input({
      view: 'back',
      requests: ['Lengthen the strap.', 'Make the back zip invisible.'],
    }),
  );
  assert.equal(evaluation.verdict, 'fail');
  assert.equal(
    evaluation.issues[0],
    'requested change not applied: Make the back zip invisible. (the zip is still visible)',
  );
  const check = fake.calls.find((c) => c.purpose === 'request check')!;
  assert.match(check.system, /1\. "Lengthen the strap\."\n2\. "Make the back zip/);
  assert.match(check.system, /seen from directly behind/);
  assert.doesNotMatch(check.system, /garment/);
  assert.equal(fake.comparisons().length, 1, 'a missed request is not confirmed');
});

test('a doubtful miss only warns, and no check runs without a request', async () => {
  const doubtful = fakeRunner([], {
    requests: [{ applied: false, confidence: 0.3, note: 'hard to tell' }],
  });
  const warned = await createJudgeCritic({ runner: doubtful.runner }).evaluate(
    await input({ requests: ['Narrow the handle.'] }),
  );
  assert.equal(warned.verdict, 'warn');

  const none = fakeRunner();
  await createJudgeCritic({ runner: none.runner }).evaluate(await input());
  assert.ok(none.calls.every((c) => c.purpose === 'comparison'));
});

test('an aspect the reviewer changed is not asked', async () => {
  const fake = fakeRunner([], { requests: [{ applied: true, confidence: 0.9, note: 'green' }] });
  const evaluation = await createJudgeCritic({ runner: fake.runner }).evaluate(
    await input({ requests: ['Make it green.'], changed: ['color'] }),
  );
  assert.ok(!evaluation.attributes?.some((a) => a.attribute === 'color'));
  assert.doesNotMatch(fake.comparisons()[0].system, /- color,/);
});

test('a request check that skips a request is an error, for the step to retry', async () => {
  const critic = createJudgeCritic({ runner: fakeRunner().runner });
  await assert.rejects(
    critic.evaluate(await input({ requests: ['Narrow the handle.'] })),
    /did not answer each request/,
  );
});

test('an answer outside the schema is an error naming the model', async () => {
  const runner: CriticRunner = async () => ({
    output: { aspects: {}, image: {} },
    usage: { inputTokens: 0, outputTokens: 0 },
  });
  await assert.rejects(createJudgeCritic({ runner }).evaluate(await input()), {
    message: `${entry.id}: comparison did not match its schema`,
  });
});

test('an undecodable candidate throws rather than being scored', async () => {
  const fake = fakeRunner();
  await assert.rejects(
    createJudgeCritic({ runner: fake.runner }).evaluate(
      await input({ candidate: new TextEncoder().encode('not an image') }),
    ),
  );
  assert.equal(fake.calls.length, 0);
});

test('an image too large for the model is sent within 1568 px, as a JPEG', async () => {
  const large = new Uint8Array(
    await sharp({ create: { width: 1536, height: 2304, channels: 3, background: '#777' } })
      .png()
      .toBuffer(),
  );
  const sent = await modelImage(large, 'image/png');
  const { width, height, format } = await sharp(sent.bytes).metadata();
  assert.deepEqual([width, height, format, sent.contentType], [1045, 1568, 'jpeg', 'image/jpeg']);

  const small = await noise();
  assert.equal((await modelImage(small, 'image/png')).bytes, small, 'a small one is untouched');
});
