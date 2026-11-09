import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Candidate } from '@sketch-to-product-views/contracts';
import { byAttempt, latestViews, viewOf } from '../src/lib/views.js';

const candidate = (id: string, attempt: number, view?: Candidate['view']) =>
  ({ id, url: `https://x/${id}`, modelId: 'm', attempt, createdAt: '', view }) as Candidate;

test('a candidate without a view is a front', () => {
  assert.equal(viewOf(candidate('a', 1)), 'front');
});

test('the latest views are the newest image of each view, in view order', () => {
  const candidates = [
    candidate('f1', 1, 'front'),
    candidate('b1', 1, 'back'),
    candidate('r1', 1, 'right'),
    candidate('l1', 1, 'left'),
    // A retry that remade only the left keeps the other views of attempt 1.
    candidate('l2', 2, 'left'),
  ];
  assert.deepEqual(
    latestViews(candidates).map((c) => c.id),
    ['f1', 'b1', 'l2', 'r1'],
  );
});

test('candidates group by attempt, oldest first, each in view order', () => {
  const groups = byAttempt([
    candidate('r2', 2, 'right'),
    candidate('f1', 1, 'front'),
    candidate('l1', 1, 'left'),
    candidate('b1', 1, 'back'),
  ]);
  assert.deepEqual(
    groups.map(([attempt, list]) => [attempt, list.map((c) => c.id)]),
    [
      [1, ['f1', 'b1', 'l1']],
      [2, ['r2']],
    ],
  );
});
