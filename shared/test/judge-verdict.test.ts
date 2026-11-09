import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ASPECTS, type AspectDef } from '@sketch-to-product-views/contracts';
import { hardFails, judge, type Answer, type ComparisonAnswer } from '../src/qc/judge/index.js';

const asked = (ASPECTS as readonly AspectDef[]).filter(
  (d) => !d.perPart && d.name !== 'presentation',
);

/** Every aspect answered `same`, a usable image; `over` sets the answers given. */
function answer(
  over: Partial<Record<string, Answer>> = {},
  image: Partial<ComparisonAnswer['image']> = {},
  parts: ComparisonAnswer['parts'] = [],
): ComparisonAnswer {
  return {
    aspects: Object.fromEntries(
      asked.map((def) => [
        def.name,
        {
          reference: `sketched ${def.name}`,
          observed: over[def.name] === 'different' ? `other ${def.name}` : `sketched ${def.name}`,
          reason: `${def.name} compared`,
          answer: over[def.name] ?? 'same',
        },
      ]),
    ),
    parts,
    image: { usable: true, imageQuality: 0.9, problems: [], ...image },
  };
}

const part = (name: string, a: Answer) => ({
  part: name,
  reference: `a ${name}`,
  observed: a === 'different' ? 'none' : `a ${name}`,
  reason: `${name} compared`,
  answer: a,
});

test('everything the same passes, with full scores', () => {
  const result = judge(answer(), asked);
  assert.equal(result.verdict, 'pass');
  assert.deepEqual(result.scores, { sketchFidelity: 1, specAdherence: 1, imageQuality: 0.9 });
  assert.deepEqual(result.issues, []);
  assert.equal(result.confirmation, undefined);
  assert.equal(result.attributes.find((a) => a.attribute === 'presentation')?.outcome, 'match');
});

test('a different shape or a missing part only warns, its issue kept for a retry', () => {
  const result = judge(answer({ shape: 'different' }, {}, [part('handle', 'different')]), asked);
  assert.equal(result.verdict, 'warn');
  assert.deepEqual(result.issues, [
    'shape: expected sketched shape, observed other shape (shape compared)',
    'part: handle: expected a handle, observed none (handle compared)',
  ]);
  const handle = result.attributes.find((a) => a.attribute === 'part: handle');
  assert.deepEqual(
    [handle?.expected, handle?.observed, handle?.outcome, handle?.reason],
    ['a handle', 'none', 'mismatch', 'handle compared'],
  );
});

test('cant_tell never fails nor warns, and is left out of the scores', () => {
  const result = judge(answer({ object_type: 'cant_tell', color: 'cant_tell' }), asked);
  assert.equal(result.verdict, 'pass');
  assert.equal(result.attributes.find((a) => a.attribute === 'color')?.outcome, 'skipped');
  assert.equal(result.scores.specAdherence, 1);
});

test('only object type, colour and an unusable image are hard facts', () => {
  assert.deepEqual(hardFails(answer({ shape: 'different', material: 'different' })), []);
  assert.deepEqual(hardFails(answer({ object_type: 'different', color: 'different' })), [
    'object_type',
    'color',
  ]);
  assert.deepEqual(hardFails(answer({}, { usable: false })), ['presentation']);
  assert.deepEqual(hardFails(answer({}, { imageQuality: 0.4 })), ['presentation']);
});

test('a hard fact fails only when the second reading agrees', () => {
  const first = answer({ color: 'different', shape: 'different' });
  const agreed = judge(first, asked, answer({ color: 'different' }));
  assert.equal(agreed.verdict, 'fail');
  assert.deepEqual(agreed.confirmation, { failedOn: ['color'], confirmed: ['color'] });
  assert.match(agreed.issues[0], /^color: /, 'the confirmed fact comes first');

  const disagreed = judge(first, asked, answer());
  assert.equal(disagreed.verdict, 'warn');
  assert.deepEqual(disagreed.confirmation, { failedOn: ['color'], confirmed: [] });
  assert.ok(disagreed.issues.some((i) => /^color: .*a second reading disagreed\)$/.test(i)));
  assert.equal(disagreed.attributes.find((a) => a.attribute === 'color')?.confidence, 0.5);
});

test('with two hard facts, only the one both readings fail on fails', () => {
  const result = judge(
    answer({ object_type: 'different', color: 'different' }),
    asked,
    answer({ color: 'different' }),
  );
  assert.equal(result.verdict, 'fail');
  assert.deepEqual(result.confirmation, {
    failedOn: ['object_type', 'color'],
    confirmed: ['color'],
  });
});

test('an unusable image fails first, with its problems listed after', () => {
  const bad = answer({}, { usable: false, imageQuality: 0.3, problems: ['a hand holds the lid'] });
  const result = judge(bad, asked, bad);
  assert.equal(result.verdict, 'fail');
  assert.deepEqual(result.issues, [
    'presentation: not a usable studio product image',
    'a hand holds the lid',
  ]);
  assert.equal(result.scores.imageQuality, 0.3);
});

test('scores weigh must 3, should 2 over the answered aspects; the parts count once', () => {
  // Sketch-sourced: object_type 3, shape 3, proportions 2, pattern 2, parts 2.
  const result = judge(
    answer({ shape: 'different', proportions: 'cant_tell' }, {}, [
      part('handle', 'same'),
      part('lid', 'different'),
      part('back seam', 'cant_tell'),
    ]),
    asked,
  );
  assert.equal(result.scores.sketchFidelity, (3 + 2 + 1) / (3 + 3 + 2 + 2));
});

test('no more than twelve parts are kept', () => {
  const many = Array.from({ length: 20 }, (_, i) => part(`rivet ${i}`, 'same'));
  const result = judge(answer({}, {}, many), asked);
  assert.equal(result.attributes.filter((a) => a.attribute.startsWith('part: ')).length, 12);
});
