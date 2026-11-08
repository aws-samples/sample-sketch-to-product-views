import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PipelineState } from '@sketch-to-product-views/contracts';
import {
  askToNotify,
  milestone,
  noticeFor,
  notificationPermission,
  titleWith,
  type RunSnapshot,
} from '../src/lib/notify.js';

const snap = (status: RunSnapshot['status'], revisionId = 'r1'): RunSnapshot => ({
  revisionId,
  status,
});

test('a run reaching review, approval or failure while watched is a milestone', () => {
  assert.equal(milestone(snap('running'), snap('awaiting_review')), 'awaiting_review');
  assert.equal(milestone(snap('running'), snap('approved')), 'approved');
  assert.equal(milestone(snap('awaiting_review'), snap('failed')), 'failed');
});

test('the first poll never notifies, so a reload of a finished run stays quiet', () => {
  assert.equal(milestone(null, snap('approved')), null);
  assert.equal(milestone(null, snap('awaiting_review')), null);
});

test('an unchanged poll does not notify again', () => {
  assert.equal(milestone(snap('awaiting_review'), snap('awaiting_review')), null);
});

test('switching to another run is a first poll, not a transition', () => {
  assert.equal(milestone(snap('running', 'r1'), snap('approved', 'r2')), null);
});

test('leaving the gate is not a milestone; reaching it again after a regeneration is', () => {
  assert.equal(milestone(snap('awaiting_review'), snap('running')), null);
  assert.equal(milestone(snap('running'), snap('awaiting_review')), 'awaiting_review');
  assert.equal(milestone(snap('running'), snap('cancelled')), null);
});

test('the notice names the product, and the failure its reason', () => {
  const state = { productId: 'P-1', failureReason: 'the critic timed out' } as PipelineState;
  assert.match(noticeFor(state, 'awaiting_review').body, /^P-1: /);
  assert.equal(noticeFor(state, 'failed').body, 'P-1: the critic timed out');
  assert.equal(
    titleWith(noticeFor(state, 'awaiting_review'), 'Sketch to product views'),
    '● Ready for review — Sketch to product views',
  );
  assert.equal(titleWith(null, 'Base'), 'Base');
});

test('without a Notification API, nothing is asked and nothing throws', async () => {
  assert.equal(typeof (globalThis as { Notification?: unknown }).Notification, 'undefined');
  assert.equal(notificationPermission(), 'unsupported');
  assert.equal(await askToNotify(), 'unsupported');
});
