import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mayReadRevision, mayReviewRevision } from '../src/authz.js';

/**
 * The policy itself, away from any transport. Both the deployed API and the local mock call
 * these exact functions, so this is the one place it has to be true.
 */

test('the owner may read and review their own revision', () => {
  const state = { owner: 'user-a' };
  assert.equal(mayReadRevision(state, 'user-a'), true);
  assert.equal(mayReviewRevision(state, 'user-a'), true);
});

test('another subject may neither read nor review it', () => {
  const state = { owner: 'user-a' };
  assert.equal(mayReadRevision(state, 'user-b'), false);
  assert.equal(mayReviewRevision(state, 'user-b'), false);
});

test('a revision with an empty owner is open to nobody, not even an empty subject', () => {
  const state = { owner: '' };
  for (const sub of ['', 'anyone']) {
    assert.equal(mayReadRevision(state, sub), false, sub);
    assert.equal(mayReviewRevision(state, sub), false, sub);
  }
});
