import assert from 'node:assert/strict';
import test from 'node:test';
import {
  pipelineInputSchema,
  evaluationSchema,
  pipelineStateSchema,
  changedAttributes,
  requestsByView,
  reviewDecisionSchema,
  viewsToRemake,
} from '../src/index.js';

/**
 * Revisions already stored in DynamoDB were written by earlier versions of these schemas.
 * They must keep parsing, whatever the schemas gain.
 */

const storedEvaluation = {
  verdict: 'fail',
  scores: { sketchFidelity: 0.52, specAdherence: 0.71, imageQuality: 0.88 },
  issues: ['Collar shape diverges from the front sketch.'],
  reviewer: 'us.anthropic.claude-sonnet-4-6',
  model: {
    id: 'critic-sonnet',
    name: 'Claude Sonnet 4.6 (EU)',
    bedrockModelId: 'us.anthropic.claude-sonnet-4-6',
    region: 'us-east-1',
  },
};

test('a stored evaluation without attribute results still parses', () => {
  assert.equal(evaluationSchema.safeParse(storedEvaluation).success, true);
});

test('an evaluation recorded without a model still parses', () => {
  const { model: _model, ...withoutModel } = storedEvaluation;
  assert.equal(evaluationSchema.safeParse(withoutModel).success, true);
});

test('a stored revision that has not reached every stage still parses', () => {
  const revision = {
    revisionId: 'r1',
    productId: 'MODEL-9',
    revision: 1,
    status: 'running',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    modelId: 'stub',
    attemptBudget: 3,
    attempt: 0,
    inputs: [],
    stages: {},
    candidates: [],
    events: [],
  };
  const parsed = pipelineStateSchema.safeParse(revision);
  assert.equal(parsed.success, true, parsed.success ? '' : parsed.error.message);
});

test('a regeneration needs a description; approving does not', () => {
  assert.equal(reviewDecisionSchema.safeParse({ decision: 'regenerate' }).success, false);
  assert.equal(
    reviewDecisionSchema.safeParse({ decision: 'regenerate', notes: '  ' }).success,
    false,
    'blank is no description',
  );
  assert.equal(
    reviewDecisionSchema.safeParse({ decision: 'regenerate', notes: 'Longer handle.' }).success,
    true,
  );
  assert.equal(reviewDecisionSchema.safeParse({ decision: 'approve' }).success, true);
});

test('a remade view remakes the views made from it', () => {
  assert.deepEqual(viewsToRemake(['front']), ['front', 'back', 'left', 'right']);
  assert.deepEqual(viewsToRemake(['back']), ['back', 'left', 'right']);
  assert.deepEqual(viewsToRemake(['right', 'left']), ['left', 'right']);
  assert.deepEqual(viewsToRemake([]), []);
});

test('every request a view was given is kept, oldest first', () => {
  assert.deepEqual(
    requestsByView([
      { round: 1, notes: 'a', views: [{ view: 'left', request: 'Higher slit.' }] },
      {
        round: 2,
        notes: 'b',
        views: [
          { view: 'front', request: 'Wider belt.' },
          { view: 'left', request: 'Wider belt.' },
        ],
      },
    ]),
    { left: ['Higher slit.', 'Wider belt.'], front: ['Wider belt.'] },
  );
});

test('the attributes changed across the regenerations are kept once each', () => {
  assert.deepEqual(
    changedAttributes([
      { round: 1, notes: 'a', views: [], attributes: ['parts', 'color'] },
      { round: 2, notes: 'b', views: [] },
      { round: 3, notes: 'c', views: [], attributes: ['color', 'shape'] },
    ]),
    ['parts', 'color', 'shape'],
  );
});

test('a pipeline input may carry the design notes, within their length limit', () => {
  const base = {
    revisionId: 'r1',
    productId: 'demo--A1',
    inputs: [{ role: 'image', filename: 's.jpg', url: '', key: 'product/x/uploads/u/s.jpg' }],
    modelId: 'gpt-image-flare',
    createdAt: '2026-10-20T09:00:00.000Z',
  };
  const requests = { notes: 'Ada: a longer handle', reviewedBy: 'Ada' };
  assert.equal(pipelineInputSchema.safeParse({ ...base, requests }).success, true);
  assert.equal(
    pipelineInputSchema.safeParse({ ...base, requests: { notes: 'x'.repeat(4001) } }).success,
    false,
  );
});
