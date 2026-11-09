import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clean, removedHint } from '../src/lib/clean.js';

test('the form cleans a field as the API will, and says how much it removed', () => {
  assert.deepEqual(clean(' MODEL\u200B-1\n', 'single'), { text: 'MODEL-1', removed: 1 });
  assert.deepEqual(clean('a\u202Eb\r\n\r\n\r\nc', 'multiline'), { text: 'ab\n\nc', removed: 1 });
  assert.deepEqual(clean('{"a":"b\u2066"}', 'details'), { text: '{\n  "a": "b"\n}', removed: 1 });
  assert.deepEqual(clean('', 'details'), { text: '', removed: 0 });
});

test('the hint appears only when something was removed', () => {
  assert.equal(removedHint(0), null);
  assert.equal(removedHint(1), '1 hidden or control character removed.');
  assert.equal(removedHint(3), '3 hidden or control characters removed.');
});
