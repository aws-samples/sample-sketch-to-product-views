import assert from 'node:assert/strict';
import test from 'node:test';
import { normalise } from '../src/index.js';

test('values are trimmed, whitespace collapsed and lower-cased', () => {
  assert.equal(normalise('  IVORY   9002 '), 'ivory 9002');
  assert.equal(normalise('Walnut\tveneer'), 'walnut veneer');
});

test('words are left as written, never translated', () => {
  assert.equal(normalise('100% COTON'), '100% coton');
});

test('normalisation is idempotent', () => {
  for (const raw of ['  Matte BLACK  aluminium', '100% COTON', 'Lounge Chair']) {
    assert.equal(normalise(normalise(raw)), normalise(raw));
  }
});
