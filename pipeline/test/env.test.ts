import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { positiveIntFromEnv } from '../src/handler.js';

/**
 * `positiveIntFromEnv` guards two loop bounds: the 2D generation attempt budget and the human
 * review timeout. A `NaN` budget silently means "zero attempts" — the loop skips every
 * iteration and the run fails having generated nothing — so every rejected input below is
 * a real failure mode, not a hypothetical one.
 */

const NAME = 'PIPELINE_TEST_BUDGET';

afterEach(() => {
  delete process.env[NAME];
});

test('an unset variable yields the default', () => {
  assert.equal(positiveIntFromEnv(NAME, 3), 3);
});

test('an empty string yields the default rather than zero', () => {
  // `Number('')` is 0, which as an attempt budget means the loop never runs.
  process.env[NAME] = '';
  assert.equal(positiveIntFromEnv(NAME, 3), 3);
});

test('a whitespace-only value yields the default rather than zero', () => {
  process.env[NAME] = '   ';
  assert.equal(positiveIntFromEnv(NAME, 3), 3);
});

test('a malformed value yields the default rather than a NaN loop bound', () => {
  process.env[NAME] = 'three';
  assert.equal(positiveIntFromEnv(NAME, 3), 3);
});

test('the literal string NaN yields the default', () => {
  process.env[NAME] = 'NaN';
  assert.equal(positiveIntFromEnv(NAME, 3), 3);
});

test('zero yields the default, because zero attempts is never what anyone configured', () => {
  process.env[NAME] = '0';
  assert.equal(positiveIntFromEnv(NAME, 3), 3);
});

test('a negative value yields the default', () => {
  process.env[NAME] = '-2';
  assert.equal(positiveIntFromEnv(NAME, 3), 3);
});

test('a fractional value yields the default, because a budget must be a whole number', () => {
  process.env[NAME] = '2.5';
  assert.equal(positiveIntFromEnv(NAME, 3), 3);
});

test('Infinity yields the default, so a review timeout cannot become unbounded', () => {
  process.env[NAME] = 'Infinity';
  assert.equal(positiveIntFromEnv(NAME, 7), 7);
});

test('a valid positive integer is used as configured', () => {
  process.env[NAME] = '5';
  assert.equal(positiveIntFromEnv(NAME, 3), 5);
});

test('surrounding whitespace is tolerated, as Number ignores it', () => {
  process.env[NAME] = ' 4 ';
  assert.equal(positiveIntFromEnv(NAME, 3), 4);
});
