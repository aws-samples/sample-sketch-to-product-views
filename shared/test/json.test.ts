import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stripFence } from '../src/qc/json.js';

test('a fenced answer is unwrapped, with or without the json tag', () => {
  assert.equal(stripFence('```json\n{"a":1}\n```'), '{"a":1}');
  assert.equal(stripFence('Here:\n```\n{"a":1}\n```\nDone.'), '{"a":1}');
});

test('an unfenced or unterminated answer is returned trimmed', () => {
  assert.equal(stripFence('  {"a":1} '), '{"a":1}');
  assert.equal(stripFence('```json {"a":1}'), '```json {"a":1}');
});

test('a hostile answer of a fence and many spaces returns at once', () => {
  const started = performance.now();
  stripFence(`\`\`\`${' '.repeat(200_000)}x`);
  assert.ok(performance.now() - started < 200);
});
