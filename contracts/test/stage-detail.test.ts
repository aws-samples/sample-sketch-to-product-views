import assert from 'node:assert/strict';
import test from 'node:test';
import { DETAIL_BUDGET_BYTES, captureDetail } from '../src/stage-detail.js';

test('records input and output verbatim when they fit', () => {
  const detail = captureDetail({ input: { a: 1 }, output: { a: 1, b: 2 } });
  assert.deepEqual(detail.input, { a: 1 });
  assert.deepEqual(detail.output, { a: 1, b: 2 });
  assert.equal(detail.truncated, undefined);
});

test('omits absent parts rather than storing empty ones', () => {
  assert.deepEqual(captureDetail({ output: 'done' }), { output: 'done' });
  assert.deepEqual(captureDetail({}), {});
});

test('drops undefined facts so the UI never renders an empty row', () => {
  const detail = captureDetail({ facts: { model: 'm', latencyMs: undefined } });
  assert.deepEqual(detail.facts, { model: 'm' });
});

test('omits the facts object entirely when every fact was undefined', () => {
  assert.equal(captureDetail({ facts: { latencyMs: undefined } }).facts, undefined);
});

test('replaces an over-budget snapshot with its shape and flags the detail', () => {
  const big = { image: 'x'.repeat(DETAIL_BUDGET_BYTES * 2) };
  const detail = captureDetail({ input: { small: true }, output: big });

  assert.deepEqual(detail.input, { small: true }, 'the part that fits is still recorded');
  assert.equal(detail.truncated, true);
  assert.match(JSON.stringify(detail.output), /object with keys image/);
  assert.ok(
    JSON.stringify(detail.output).length < DETAIL_BUDGET_BYTES,
    'the replacement must itself be small, or the budget bought nothing',
  );
});

test('a value JSON cannot represent is treated as absent', () => {
  assert.equal(captureDetail({ output: () => 1 }).output, undefined);
});
