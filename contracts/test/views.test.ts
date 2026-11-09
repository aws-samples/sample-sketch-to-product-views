import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CANDIDATE_VIEWS,
  candidateSchema,
  pipelineStateSchema,
  viewMapSchema,
  viewUrlsSchema,
} from '../src/index.js';

/**
 * The generated views are a key in several places: the candidate's `view`, the accepted
 * attempt's `selectedViews`, the delivery keys and URLs. These tests pin them to one list, so a
 * view added or renamed in one place cannot be left out of another.
 */

test('the generated views are the four camera positions, the front first', () => {
  assert.deepEqual(CANDIDATE_VIEWS, ['front', 'back', 'left', 'right']);
});

test('every per-view map has exactly one key per generated view, the front required', () => {
  for (const schema of [viewMapSchema, viewUrlsSchema]) {
    assert.deepEqual(Object.keys(schema.shape), [...CANDIDATE_VIEWS]);
    assert.equal(schema.safeParse({ front: 'f', back: 'b', left: 'l', right: 'r' }).success, true);
    assert.equal(schema.safeParse({ front: 'f' }).success, true);
    assert.equal(schema.safeParse({ back: 'b' }).success, false, 'the front is required');
    // A stored map from before the profiles existed carries `side`: it parses, and the key is
    // dropped rather than shown as a view nothing knows how to label.
    const parsed = schema.parse({ front: 'f', side: 's' }) as Record<string, string>;
    assert.equal(parsed.side, undefined);
  }
  assert.deepEqual(Object.keys(pipelineStateSchema.shape.deliveryUrls.unwrap().shape), [
    ...CANDIDATE_VIEWS,
  ]);
});

test('a candidate carries any generated view and refuses the retired "side"', () => {
  const base = { id: 'c', url: '', modelId: 'm', attempt: 1, createdAt: '' };
  for (const view of CANDIDATE_VIEWS) {
    assert.equal(candidateSchema.safeParse({ ...base, view }).success, true, view);
  }
  assert.equal(candidateSchema.safeParse({ ...base, view: 'side' }).success, false);
  assert.equal(candidateSchema.safeParse(base).success, true, 'a run before views has none');
  assert.equal(
    candidateSchema.safeParse({ ...base, view: 'left', referenceKeys: ['k/front.png'] }).success,
    true,
  );
});
