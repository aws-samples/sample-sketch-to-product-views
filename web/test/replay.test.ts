import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Candidate, Evaluation, PipelineState, StageEvent } from '@sketch-to-product-views/contracts';
import { replayAt } from '../src/lib/replay.js';
import { focusStage } from '../src/lib/run-focus.js';
import { byAttempt, latestViews } from '../src/lib/views.js';

/** Replay is where the UI derives state instead of reading it, so these pin its gates. */

let seq = 0;
const at = (n: number) => `2026-01-01T00:00:${String(n).padStart(2, '0')}Z`;

function event(
  stage: StageEvent['stage'],
  status: StageEvent['status'],
  extra: Partial<StageEvent> = {},
): StageEvent {
  seq += 1;
  return { seq, revisionId: 'r', stage, status, at: at(seq), ...extra };
}

const verdict = (v: Evaluation['verdict']): Evaluation => ({
  verdict: v,
  scores: { sketchFidelity: 0.8, specAdherence: 0.8, imageQuality: 0.9 },
  issues: v === 'fail' ? ['Collar diverges.'] : [],
  reviewer: 'r',
});

function candidate(
  id: string,
  attempt: number,
  view: Candidate['view'],
  createdAt: number,
  v?: Evaluation['verdict'],
): Candidate {
  return {
    id,
    url: `/${id}`,
    modelId: 'm',
    attempt,
    view,
    createdAt: at(createdAt),
    ...(v ? { evaluation: verdict(v) } : {}),
  };
}

/**
 * Attempt 1: front and back; the critic fails the back. Attempt 2 remakes the back only and
 * passes. Then review, approval, delivery.
 */
function run(): PipelineState {
  seq = 0;
  const events = [
    event('upload', 'passed'), // 1
    event('submit', 'passed'), // 2
    event('validate', 'passed'), // 3
    event('analyse', 'passed'), // 4
    event('complete_spec', 'passed'), // 5
    event('generate_2d', 'passed', { attempt: 1, view: 'front' }), // 6
    event('generate_2d', 'passed', { attempt: 1, view: 'back' }), // 7
    event('evaluate_2d', 'running', { attempt: 1 }), // 8
    event('evaluate_2d', 'passed', { attempt: 1, message: 'back fail: Collar diverges.' }), // 9
    event('generate_2d', 'passed', { attempt: 2, view: 'back' }), // 10
    event('evaluate_2d', 'running', { attempt: 2 }), // 11
    event('evaluate_2d', 'passed', { attempt: 2 }), // 12
    event('human_review', 'awaiting_review'), // 13
    event('human_review', 'passed'), // 14
    event('deliver', 'passed'), // 15
  ];
  return {
    revisionId: 'r',
    productId: 'SYN-001',
    revision: 1,
    status: 'approved',
    createdAt: at(0),
    updatedAt: at(15),
    modelId: 'm',
    attemptBudget: 2,
    attempt: 2,
    inputs: [],
    analysis: {
      product: {
        type: { value: 'desk lamp', source: 'image' },
        colour: { value: '', source: 'none' },
        material: { value: '', source: 'none' },
        dimensions: { value: '', source: 'none' },
      },
      views: ['front'],
      parts: [],
      details: [],
      ignored: [],
      observedColours: [],
      materialCues: [],
      assumptions: [],
    },
    spec: { model: 'SYN-001', productType: { value: 'desk lamp', provenance: 'observed' } },
    warning: 'No composition found.',
    stages: {},
    candidates: [
      candidate('f1', 1, 'front', 6, 'pass'),
      candidate('b1', 1, 'back', 7, 'fail'),
      candidate('b2', 2, 'back', 10, 'pass'),
    ],
    selectedCandidateId: 'f1',
    selectedViews: { front: 'f1', back: 'b2' },
    criticOutcome: { approved: true, attempt: 2, attempts: 2, issues: [] },
    deliveryUrl: '/delivered/front',
    deliveryUrls: { front: '/delivered/front', back: '/delivered/back' },
    events,
  };
}

test('scrubbing to the end returns the live document itself', () => {
  const state = run();
  assert.equal(replayAt(state, 15), state);
  assert.equal(replayAt(state, 99), state);
});

test('a stage with no event yet is pending, and the run is still going', () => {
  const view = replayAt(run(), 5);
  assert.equal(view.stages.complete_spec?.status, 'passed');
  assert.equal(view.stages.generate_2d?.status, 'pending');
  assert.equal(view.stages.human_review?.status, 'pending');
  assert.equal(view.status, 'running');
});

test('the analysis and the spec exist only once their stage settled', () => {
  assert.equal(replayAt(run(), 3).analysis, undefined);
  assert.ok(replayAt(run(), 4).analysis);
  assert.equal(replayAt(run(), 4).spec, undefined);
  assert.equal(replayAt(run(), 4).warning, undefined);
  assert.ok(replayAt(run(), 5).spec);
});

test('a view carries no verdict until the critic scored its attempt', () => {
  const mid = replayAt(run(), 8);
  assert.deepEqual(
    mid.candidates.map((c) => c.id),
    ['f1', 'b1'],
  );
  assert.ok(mid.candidates.every((c) => c.evaluation === undefined));

  const judged = replayAt(run(), 9);
  assert.equal(judged.candidates.find((c) => c.id === 'b1')?.evaluation?.verdict, 'fail');
  assert.equal(judged.candidates.length, 2, 'attempt 2 is not generated yet');
});

test('the selection, the outcome and the delivery are hidden until they happened', () => {
  const beforeReview = replayAt(run(), 12);
  assert.equal(beforeReview.selectedViews, undefined);
  assert.equal(beforeReview.criticOutcome, undefined);

  const atGate = replayAt(run(), 13);
  assert.equal(atGate.status, 'awaiting_review');
  assert.deepEqual(atGate.selectedViews, { front: 'f1', back: 'b2' });
  assert.equal(atGate.deliveryUrls, undefined);

  assert.equal(replayAt(run(), 14).deliveryUrl, undefined);
});

test('a rejected view is a retry, not a failed run', () => {
  const view = replayAt(run(), 9);
  assert.equal(view.status, 'running');
  assert.equal(view.failureReason, undefined);
  assert.equal(focusStage(view), 'evaluate_2d');
});

test('focus prefers live work over an already-failed stage', () => {
  const state = run();
  state.stages = {
    generate_2d: { status: 'running', attempt: 2 },
    evaluate_2d: { status: 'failed', attempt: 1 },
  };
  assert.equal(focusStage(state), 'generate_2d');
});

test('focus falls back to the furthest stage that finished', () => {
  const state = run();
  state.stages = {
    upload: { status: 'passed', attempt: 0 },
    submit: { status: 'passed', attempt: 0 },
    human_review: { status: 'awaiting_review', attempt: 0 },
  };
  assert.equal(focusStage(state), 'human_review');

  delete state.stages.human_review;
  assert.equal(focusStage(state), 'submit');
});

test('the current views are the newest image of each view, in view order', () => {
  const { candidates } = run();
  assert.deepEqual(
    latestViews([...candidates].reverse()).map((c) => c.id),
    ['f1', 'b1'],
    'newest means last in the list, as the API stores them',
  );
  assert.deepEqual(
    latestViews(candidates).map((c) => c.id),
    ['f1', 'b2'],
  );
  assert.deepEqual(
    byAttempt(candidates).map(([attempt, views]) => [attempt, views.map((c) => c.id)]),
    [
      [1, ['f1', 'b1']],
      [2, ['b2']],
    ],
  );
});
