import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import sharp from 'sharp';
import {
  checkAnalysis,
  type PipelineInput,
  type RawAnalysis,
  type ViewRequest,
} from '@sketch-to-product-views/contracts';
import * as realAnalyse from '@sketch-to-product-views/shared/analyse';
import * as realTriage from '@sketch-to-product-views/shared/analyse/triage';
import * as realGenerate from '@sketch-to-product-views/shared/generate';
import type { GenerationRequest } from '@sketch-to-product-views/shared/generate';
import type { CriticInput } from '@sketch-to-product-views/shared/qc/critic';
import * as realJudge from '@sketch-to-product-views/shared/qc/judge';
import { sniffImageType } from '@sketch-to-product-views/shared/store';
import { fakeContext, fakeStore } from './fakes.js';

/**
 * A whole run through the real handler, the review gate included: what a reviewer's
 * regeneration does to the run, with every model faked.
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
  await sharp({ create: { width: 64, height: 96, channels: 3, background: '#888' } })
    .png()
    .toBuffer(),
);

const none = { value: '', source: 'none' } as const;
const analysis: RawAnalysis = {
  product: {
    type: { value: 'wrap skirt', source: 'image' },
    colour: none,
    material: none,
    dimensions: none,
  },
  images: [{ image: 1, kind: 'sketch', views: ['front'], description: 'a sketch' }],
  parts: [],
  details: [],
  ignored: [],
  observedColours: [],
  materialCues: [],
  assumptions: [],
};
mock.module('@sketch-to-product-views/shared/analyse', {
  namedExports: {
    ...realAnalyse,
    analyseImages: async () => ({
      analysis: checkAnalysis(analysis),
      model: { id: 'a', name: 'Fake analyser', bedrockModelId: 'a', region: 'x' },
      promptVersion: 'test',
      latencyMs: 1,
    }),
  },
});

/** What the triage was asked, and what it routes each description to. */
const triaged: string[] = [];
let routes: { views: ViewRequest[]; attributes: string[] }[] = [];
mock.module('@sketch-to-product-views/shared/analyse/triage', {
  namedExports: {
    ...realTriage,
    triageFeedback: async ({ notes }: { notes: string }) => {
      triaged.push(notes);
      return {
        ...routes.shift()!,
        model: { id: 'a', name: 'Fake analyser', bedrockModelId: 'a', region: 'x' },
        promptVersion: 'test',
        latencyMs: 1,
      };
    },
  },
});

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
          durationMs: 1,
        };
      },
    }),
  },
});

const judged: CriticInput[] = [];
/** When set, the critic rejects every view, scoring each attempt of four views with this score. */
let rejectAll: number[] | undefined;
mock.module('@sketch-to-product-views/shared/qc/judge', {
  namedExports: {
    ...realJudge,
    createJudgeCritic: () => ({
      evaluate: async (input: CriticInput) => {
        judged.push(input);
        if (rejectAll) {
          const score = rejectAll[Math.floor((judged.length - 1) / 4)];
          return {
            verdict: 'fail',
            scores: { sketchFidelity: score, specAdherence: score, imageQuality: score },
            issues: [`The ${input.view} is off.`, 'The colour is wrong.'],
            reviewer: 'fake',
          };
        }
        return {
          verdict: 'pass',
          scores: { sketchFidelity: 0.9, specAdherence: 0.9, imageQuality: 0.9 },
          issues: [],
          reviewer: 'fake',
        };
      },
    }),
  },
});

const { runDurable } = await import('../src/handler.js');

const input: PipelineInput = {
  revisionId: 'r-1',
  productId: 'MODEL-1',
  modelId: 'gpt-image-flare',
  submittedBy: 'u-1',
  createdAt: '2026-10-12T10:00:00.000Z',
  inputs: [{ role: 'image', filename: 's.png', url: 'https://x/s.png', key: 'user/u-1/k/sketch.png' }],
};

test('a regeneration routes the description, remakes those views, and reviews again', async () => {
  store.objects.set('user/u-1/k/sketch.png', IMAGE);
  store.revision = { candidates: [] };
  routes = [
    {
      views: [{ view: 'left', request: 'Raise the slit on the left side to mid-thigh' }],
      attributes: ['details'],
    },
    { views: [{ view: 'front', request: 'Make the waistband wider' }], attributes: ['waist'] },
  ];
  const { ctx, steps } = fakeContext([
    { decision: 'regenerate', notes: 'La fente plus haute', reviewedBy: 'Reviewer' },
    { decision: 'regenerate', notes: 'Ceinture plus large' },
    { decision: 'approve' },
  ]);

  const outcome = await runDurable(input, ctx);

  assert.equal(outcome.status, 'approved');
  assert.deepEqual(triaged, ['La fente plus haute', 'Ceinture plus large']);
  assert.deepEqual(
    steps.filter((s) => /^(human_review|triage|generate_2d|record-review)/.test(s)),
    [
      'generate_2d-front-1',
      'generate_2d-back-1',
      'generate_2d-left-1',
      'generate_2d-right-1',
      'human_review',
      'record-review',
      'triage-1',
      'generate_2d-left-2',
      'human_review-2',
      'record-review-2',
      'triage-2',
      'generate_2d-front-3',
      'generate_2d-back-3',
      'generate_2d-left-3',
      'generate_2d-right-3',
      'human_review-3',
      'record-review-3',
    ],
    'only the left is remade first; a new front then remakes all four',
  );
  assert.equal(new Set(steps).size, steps.length, 'no step name repeats');

  const [left2, front3, back3, left3] = requests.slice(4);
  assert.match(left2.prompt, /- Raise the slit on the left side to mid-thigh\./);
  assert.match(front3.prompt, /- Make the waistband wider\./);
  assert.doesNotMatch(back3.prompt, /REQUESTS FROM THE DESIGN TEAM/);
  assert.match(
    left3.prompt,
    /- Raise the slit on the left side to mid-thigh\./,
    'an earlier request is sent again when its view is remade',
  );

  assert.deepEqual(store.revision.regenerations, [
    {
      round: 1,
      notes: 'La fente plus haute',
      views: [{ view: 'left', request: 'Raise the slit on the left side to mid-thigh' }],
      attributes: ['details'],
      reviewedBy: 'Reviewer',
    },
    {
      round: 2,
      notes: 'Ceinture plus large',
      views: [{ view: 'front', request: 'Make the waistband wider' }],
      attributes: ['waist'],
    },
  ]);
  const triage = store.events.filter((e) => e.stage === 'human_review' && e.status === 'passed');
  assert.ok(
    triage.some((e) => e.message === 'Regeneration 1: remaking the left side.'),
    triage.map((e) => e.message).join(' | '),
  );
  assert.ok(
    triage.some(
      (e) =>
        e.message ===
        'Regeneration 2: remaking the front, the back, the left side, the right side.',
    ),
  );
  assert.equal(judged.length, 4, 'the critic scores the first generation only');
  assert.ok(
    !steps.some((s) => /^evaluate_2d-[23]$/.test(s)),
    'a regeneration is one attempt, with no critic',
  );
  assert.deepEqual(store.revision.criticOutcome, { evaluated: false, attempt: 3 });
  assert.ok(
    !store.events.some((e) => e.stage === 'evaluate_2d' && (e.attempt ?? 0) > 1),
    'no evaluate_2d event after the first generation',
  );
  const delivered = store.revision.selectedViews!;
  const attemptOf = (id: string) => store.revision.candidates!.find((c) => c.id === id)!.attempt;
  assert.equal(attemptOf(delivered.front), 3, 'the views of the last round are delivered');
});

test('a run whose two attempts, the default budget, the critic rejects parks at review with the best', async () => {
  store.objects.set('user/u-1/k/sketch.png', IMAGE);
  store.revision = { candidates: [] };
  store.events.length = 0;
  judged.length = 0;
  rejectAll = [0.5, 0.8];
  try {
    const { ctx, steps } = fakeContext([{ decision: 'approve' }]);

    const outcome = await runDurable(input, ctx);

    assert.equal(outcome.status, 'approved', 'the reviewer had the last word');
    assert.equal(judged.length, 8, 'two attempts of four views');
    assert.ok(steps.includes('select-2'), steps.join(', '));
    assert.ok(steps.includes('human_review'), 'the run reached the review gate');
    const selected = store.revision.selectedViews!;
    const attemptOf = (id: string) => store.revision.candidates!.find((c) => c.id === id)!.attempt;
    assert.equal(attemptOf(selected.front), 2, 'the attempt with the best score');
    assert.equal(store.revision.attempt, 2);
    assert.deepEqual(store.revision.criticOutcome, {
      approved: false,
      attempt: 2,
      attempts: 2,
      issues: [
        'The front is off.',
        'The colour is wrong.',
        'The back is off.',
        'The left is off.',
        'The right is off.',
      ],
    });
    assert.ok(
      store.events.some(
        (e) =>
          e.stage === 'evaluate_2d' &&
          /rejected all 2 attempt\(s\); attempt 2/.test(e.message ?? ''),
      ),
    );
  } finally {
    rejectAll = undefined;
  }
});

test('a review gate that ends without a decision fails the run and says so on the rail', async () => {
  store.revision = { candidates: [] };
  store.events.length = 0;
  // No decision queued: the fake's callback rejects, as a timeout would.
  const { ctx, steps } = fakeContext([]);

  const outcome = await runDurable(input, ctx);

  assert.equal(outcome.status, 'failed');
  assert.ok(steps.includes('review-failed'));
  const failed = store.events.find((e) => e.stage === 'human_review' && e.status === 'failed');
  assert.match(failed?.message ?? '', /^No review decision: /);
  assert.match(store.revision.failureReason ?? '', /^No review decision: /);
});

test("a run's own attempt budget replaces the deployment's", async () => {
  store.objects.set('user/u-1/k/sketch.png', IMAGE);
  store.revision = { candidates: [] };
  store.events.length = 0;
  judged.length = 0;
  rejectAll = [0.5];
  try {
    const { ctx, steps } = fakeContext([{ decision: 'approve' }]);

    await runDurable({ ...input, settings: { attemptBudget: 1 } }, ctx);

    assert.equal(judged.length, 4, 'one attempt of four views');
    assert.ok(steps.includes('select-1') && !steps.some((s) => s.endsWith('-2')), steps.join(', '));
  } finally {
    rejectAll = undefined;
  }
});
