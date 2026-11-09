import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import sharp from 'sharp';
import type { CriticInput } from '@sketch-to-product-views/shared/qc/critic';
import type { Evaluation, PipelineInput, ProductSpec } from '@sketch-to-product-views/contracts';
import * as realGenerate from '@sketch-to-product-views/shared/generate';
import type { GenerationRequest } from '@sketch-to-product-views/shared/generate';
import * as realJudge from '@sketch-to-product-views/shared/qc/judge';
import { sniffImageType } from '@sketch-to-product-views/shared/store';
import { fakeContext, fakeStore } from './fakes.js';

/**
 * The 2D loop and delivery through the real handler, with S3, the image model and the critic
 * faked: what a run of the deployed pipeline writes, and what the revision records.
 */

const store = fakeStore(sniffImageType);
let keys = 0;
mock.module('@sketch-to-product-views/shared/store', {
  namedExports: {
    ...store.exports,
    candidateKey: (_o: string, _p: string, rev: string, id: string) =>
      `product/x/${rev}/candidates/${id}-${(keys += 1)}.png`,
    deliveryKey: (_o: string, _p: string, rev: string, filename: string) =>
      `product/x/${rev}/delivery/${filename}`,
  },
});

const IMAGE = new Uint8Array(
  await sharp({ create: { width: 8, height: 12, channels: 3, background: '#888' } })
    .png()
    .toBuffer(),
);

const requests: GenerationRequest[] = [];
mock.module('@sketch-to-product-views/shared/generate', {
  namedExports: {
    ...realGenerate,
    createImageGenerator: () => ({
      async generate(request: GenerationRequest) {
        requests.push(request);
        return {
          image: IMAGE,
          contentType: 'image/png',
          model: { id: 'gpt-image-flare', bedrockModelId: 'gpt-image-2.5-flare', region: 'x' },
          durationMs: 90_000,
        };
      },
    }),
  },
});

/** What the critic saw, and the verdicts it gives: the first view named `failing` fails. */
const scored: CriticInput[] = [];
let failing: CriticInput['view'] | undefined = 'left';
/** A view the critic rejects every time. */
let rejecting: CriticInput['view'] | undefined;
const verdict = (v: Evaluation['verdict']): Evaluation => ({
  verdict: v,
  scores: { sketchFidelity: 0.9, specAdherence: 0.9, imageQuality: 0.9 },
  issues: v === 'fail' ? ['the front faces the right edge: a right profile, not a left one'] : [],
  reviewer: 'fake',
});
mock.module('@sketch-to-product-views/shared/qc/judge', {
  namedExports: {
    ...realJudge,
    createJudgeCritic: () => ({
      async evaluate(input: CriticInput) {
        scored.push(input);
        const seen = scored.filter((s) => s.view === failing).length;
        const rejected = (input.view === failing && seen === 1) || input.view === rejecting;
        return verdict(rejected ? 'fail' : 'pass');
      },
    }),
  },
});

// Not the registry defaults, so the assertions below prove the Terraform settings are used.
process.env.EVALUATION_MODEL = 'critic-nova-pro';
process.env.IMAGE_SIZE = '1536x2304';
const { bestAttempt, regenerate, rejectedIssues, twoDLoop, deliver } =
  await import('../src/handler.js');

const input: PipelineInput = {
  revisionId: 'r-1',
  productId: 'MODEL-1',
  modelId: 'gpt-image-flare',
  submittedBy: 'u-1',
  createdAt: '2026-09-29T10:00:00.000Z',
  inputs: [{ role: 'image', filename: 's.png', url: 'https://x/s.png', key: 'user/u-1/k/sketch.png' }],
};
const spec: ProductSpec = {
  model: 'MODEL-1',
  productType: { value: 'cargo pants', provenance: 'supplied' },
  views: ['front', 'back'],
};

test('a failed profile is remade alone with its corrections; the kept views are delivered', async () => {
  store.objects.set('user/u-1/k/sketch.png', IMAGE);
  // A stale front from a try of attempt 1 that wrote before its checkpoint: replaced, not kept.
  store.revision = {
    candidates: [
      {
        id: 'stale',
        url: '',
        key: 'user/u-1/k/stale.png',
        modelId: 'm',
        attempt: 1,
        createdAt: '',
        view: 'front',
      },
    ],
  };
  const { ctx, steps } = fakeContext();

  const accepted = await twoDLoop(ctx, input, spec, 3, 'seg');

  assert.equal(requests.length, 5, 'four views, then the rejected one alone');
  assert.ok(
    requests.every((r) => r.params?.size === '1536x2304' && r.params?.quality === 'max'),
    'every view is rendered at the deployment size and the registry quality',
  );
  assert.deepEqual(steps, [
    'generate_2d-front-1',
    'generate_2d-back-1',
    'generate_2d-left-1',
    'generate_2d-right-1',
    'record_2d-1',
    'evaluate_2d-1',
    'generate_2d-left-2',
    'record_2d-2',
    'evaluate_2d-2',
    'select-2',
  ]);
  assert.deepEqual(
    scored.map((s) => s.view),
    ['front', 'back', 'left', 'right', 'left'],
    'the retry scores only the remade view',
  );
  assert.ok(
    scored.every((s) => s.modelId === 'critic-nova-pro'),
    'the critic is the one EVALUATION_MODEL names',
  );
  assert.ok(
    !requests[2].prompt.includes('CORRECTIONS'),
    'the first attempt has nothing to correct',
  );
  assert.match(
    requests[4].prompt,
    /CORRECTIONS FROM THE PREVIOUS ATTEMPT[\s\S]*- the front faces the right edge: a right profile, not a left one\./,
  );

  const candidates = store.revision.candidates!;
  assert.equal(candidates.length, 5);
  assert.ok(!candidates.some((c) => c.id === 'stale'), 'the stale try of the same call is gone');
  const first = candidates.filter((c) => c.attempt === 1);
  assert.deepEqual(
    first.map((c) => c.view),
    ['front', 'back', 'left', 'right'],
  );
  const front = first[0];
  assert.deepEqual(front.referenceKeys, ['user/u-1/k/sketch.png']);
  // The sketch draws the back, so the back gets the sketch and the front render; the profiles,
  // which it does not draw, get the front and back renders alone.
  assert.deepEqual(first[1].referenceKeys, ['user/u-1/k/sketch.png', front.key]);
  assert.deepEqual(first[2].referenceKeys, [front.key, first[1].key]);
  assert.deepEqual(first[3].referenceKeys, [front.key, first[1].key]);
  const second = candidates.filter((c) => c.attempt === 2);
  assert.deepEqual(
    second.map((c) => c.view),
    ['left'],
    'only the rejected view is remade',
  );
  assert.deepEqual(
    second[0].referenceKeys,
    [front.key, first[1].key],
    'from the kept front and back',
  );
  assert.ok(
    candidates.every((c) => c.key && store.objects.has(c.key)),
    'every view is in S3',
  );
  assert.ok(
    candidates.every((c) => c.evaluation),
    'every view keeps its verdict',
  );
  assert.equal(first[2].evaluation?.verdict, 'fail');
  const produced = store.events.filter((e) => e.stage === 'generate_2d' && e.status === 'passed');
  assert.deepEqual(
    produced.map((e) => e.message),
    [
      'Front view produced in 90.0s.',
      'Back view produced in 90.0s.',
      'Left side view produced in 90.0s.',
      'Right side view produced in 90.0s.',
      'Left side view produced in 90.0s.',
    ],
  );

  assert.equal(accepted.front.id, front.id, 'the accepted front is the first one');
  assert.equal(accepted.views.length, 4);
  assert.equal(store.revision.selectedCandidateId, front.id);
  assert.deepEqual(store.revision.selectedViews, {
    front: front.id,
    back: first[1].id,
    left: second[0].id,
    right: first[3].id,
  });

  await deliver(ctx, input, accepted, 'seg');
  assert.deepEqual(store.revision.deliveryKeys, {
    front: 'product/x/seg/delivery/MODEL-1-approved.png',
    back: 'product/x/seg/delivery/MODEL-1-approved-back.png',
    left: 'product/x/seg/delivery/MODEL-1-approved-left.png',
    right: 'product/x/seg/delivery/MODEL-1-approved-right.png',
  });
  assert.equal(store.revision.deliveryKey, store.revision.deliveryKeys!.front);
  for (const key of Object.values(store.revision.deliveryKeys!)) {
    assert.ok(store.objects.has(key), `${key} is in S3`);
  }
  assert.equal(store.revision.status, 'approved');
});

test('a rejected front remakes all four views, the front with its corrections', async () => {
  requests.length = 0;
  scored.length = 0;
  failing = 'front';
  store.revision = { candidates: [] };
  const { ctx } = fakeContext();

  const accepted = await twoDLoop(ctx, input, spec, 3, 'seg');

  assert.equal(requests.length, 8, 'the others are made from the front, so they follow it');
  assert.match(requests[4].prompt, /CORRECTIONS FROM THE PREVIOUS ATTEMPT/);
  assert.ok(
    requests.slice(5).every((r) => !r.prompt.includes('CORRECTIONS')),
    'the views that passed carry no corrections',
  );
  const second = store.revision.candidates!.filter((c) => c.attempt === 2);
  assert.deepEqual(
    second.map((c) => c.view),
    ['front', 'back', 'left', 'right'],
  );
  assert.equal(accepted.front.id, second[0].id);
});

test('a rejected back remakes the back and both profiles, which are made from it', async () => {
  requests.length = 0;
  scored.length = 0;
  failing = 'back';
  store.revision = { candidates: [] };
  const { ctx, steps } = fakeContext();

  const accepted = await twoDLoop(ctx, input, spec, 3, 'seg');

  assert.equal(requests.length, 7, 'four views, then the back and both profiles');
  assert.deepEqual(steps.slice(6), [
    'generate_2d-back-2',
    'generate_2d-left-2',
    'generate_2d-right-2',
    'record_2d-2',
    'evaluate_2d-2',
    'select-2',
  ]);
  const candidates = store.revision.candidates!;
  const second = candidates.filter((c) => c.attempt === 2);
  assert.deepEqual(
    second.map((c) => c.view),
    ['back', 'left', 'right'],
  );
  const front = candidates.find((c) => c.attempt === 1 && c.view === 'front')!;
  assert.equal(accepted.front.id, front.id, 'the front is kept');
  assert.deepEqual(second[1].referenceKeys, [front.key, second[0].key], 'from the new back');
});

test('a regeneration remakes the views asked for, with the request, in one unscored attempt', async () => {
  requests.length = 0;
  scored.length = 0;
  failing = 'right';
  store.revision = { candidates: [] };
  store.events.length = 0;
  const { ctx } = fakeContext();
  const reviewed = await twoDLoop(ctx, input, spec, 3, 'seg');
  const reviewedBack = reviewed.views.find((c) => c.view === 'back')!;
  requests.length = 0;
  scored.length = 0;
  failing = undefined;
  // The critic would reject every view: a regeneration must not ask it.
  rejecting = 'back';
  const { ctx: next, steps } = fakeContext();

  try {
    const accepted = await regenerate(next, input, spec, 'seg', {
      round: 1,
      accepted: reviewed,
      asked: ['back'],
      requests: { back: ['Add a centred handle to the back'] },
    });

    assert.deepEqual(
      steps,
      [
        'generate_2d-back-3',
        'generate_2d-left-3',
        'generate_2d-right-3',
        'record_2d-3',
        'select-3',
      ],
      'numbered on from the reviewed attempt; the profiles follow the back they are made from',
    );
    assert.equal(scored.length, 0, 'the critic is never called');
    assert.match(
      requests[0].prompt,
      /REQUESTS FROM THE DESIGN TEAM[\s\S]*- Add a centred handle to the back\./,
    );
    assert.ok(
      requests.slice(1).every((r) => !r.prompt.includes('REQUESTS FROM THE DESIGN TEAM')),
      'a view remade only because it is made from the back carries no request',
    );
    assert.ok(
      requests.every((r) => !r.prompt.includes('CORRECTIONS')),
      'no earlier verdict is turned into corrections',
    );
    assert.equal(accepted.front.id, reviewed.front.id, 'the front is kept');
    assert.notEqual(accepted.views[1].id, reviewedBack.id);
    assert.equal(accepted.unscored, true);
    assert.ok(accepted.views.slice(1).every((c) => c.attempt === 3 && !c.evaluation));
    assert.equal(store.revision.selectedViews?.back, accepted.views[1].id);
    assert.equal(store.revision.attempt, 3);
    assert.deepEqual(store.revision.criticOutcome, { evaluated: false, attempt: 3 });

    const events = store.events.filter((e) => e.attempt === 3);
    assert.ok(
      events.every((e) => e.stage === 'generate_2d'),
      'no evaluate_2d event',
    );
    const opening = events.filter((e) => e.status === 'running').map((e) => e.message!);
    assert.match(opening[0], /^Regeneration 1: the back, from the front render/);
    assert.ok(
      opening.every((m) => !/attempt|critic/i.test(m)),
      opening.join(' | '),
    );
  } finally {
    rejecting = undefined;
  }
});

test('a regeneration asked at the gate overwrites the earlier verdict with an unscored outcome', async () => {
  requests.length = 0;
  scored.length = 0;
  failing = undefined;
  store.revision = { candidates: [] };
  const { ctx } = fakeContext();
  const reviewed = await twoDLoop(ctx, input, spec, 2, 'seg');
  assert.equal(store.revision.criticOutcome && 'approved' in store.revision.criticOutcome, true);
  const { ctx: next, steps } = fakeContext();

  await regenerate(next, input, spec, 'seg', {
    round: 1,
    accepted: reviewed,
    asked: ['left'],
    requests: { left: ['Show the armrest higher'] },
  });

  assert.deepEqual(steps, ['generate_2d-left-2', 'record_2d-2', 'select-2']);
  assert.deepEqual(store.revision.criticOutcome, { evaluated: false, attempt: 2 });
});

test('a regeneration is numbered after the last attempt made, not the one kept', async () => {
  requests.length = 0;
  scored.length = 0;
  failing = undefined;
  store.revision = { candidates: [] };
  const { ctx } = fakeContext();
  const reviewed = await twoDLoop(ctx, input, spec, 2, 'seg');
  const { ctx: next, steps } = fakeContext();

  // The loop kept attempt 1 after making two: attempt 2's step names are taken.
  await regenerate(next, input, spec, 'seg', {
    round: 1,
    accepted: { ...reviewed, lastAttempt: 2 },
    asked: ['left'],
    requests: { left: ['Show the armrest higher'] },
  });

  assert.deepEqual(steps, ['generate_2d-left-3', 'record_2d-3', 'select-3']);
});

test('an accepted attempt records that the critic approved it', async () => {
  requests.length = 0;
  scored.length = 0;
  failing = 'front';
  store.revision = { candidates: [] };
  const { ctx } = fakeContext();
  await twoDLoop(ctx, input, spec, 3, 'seg');
  assert.deepEqual(store.revision.criticOutcome, {
    approved: true,
    attempt: 2,
    attempts: 2,
    issues: [],
  });
});

test('the best attempt has the most approved views, then the best score, then is the latest', () => {
  const view = (
    attempt: number,
    v: 'front' | 'back',
    verdict: Evaluation['verdict'],
    score: number,
  ) => ({
    id: `${attempt}-${v}`,
    url: '',
    modelId: 'm',
    attempt,
    createdAt: '',
    view: v,
    evaluation: {
      verdict,
      scores: { sketchFidelity: score, specAdherence: score, imageQuality: score },
      issues: verdict === 'fail' ? [`${v} wrong`, ' shared issue '] : [],
      reviewer: 'fake',
    },
  });
  const tried = (
    attempt: number,
    front: Evaluation['verdict'],
    back: Evaluation['verdict'],
    score: number,
  ) => ({
    attempt,
    views: [view(attempt, 'front', front, score), view(attempt, 'back', back, score)],
  });

  assert.equal(
    bestAttempt([tried(1, 'fail', 'pass', 0.2), tried(2, 'fail', 'fail', 0.9)]).attempt,
    1,
  );
  assert.equal(
    bestAttempt([tried(1, 'fail', 'warn', 0.2), tried(2, 'fail', 'pass', 0.9)]).attempt,
    2,
    'a warning counts as approved',
  );
  assert.equal(
    bestAttempt([tried(1, 'fail', 'fail', 0.7), tried(2, 'fail', 'fail', 0.4)]).attempt,
    1,
  );
  assert.equal(
    bestAttempt([tried(1, 'fail', 'fail', 0.5), tried(2, 'fail', 'fail', 0.5)]).attempt,
    2,
  );
  assert.throws(() => bestAttempt([]));
  assert.deepEqual(rejectedIssues(tried(1, 'fail', 'fail', 0).views), [
    'front wrong',
    'shared issue',
    'back wrong',
  ]);
});
