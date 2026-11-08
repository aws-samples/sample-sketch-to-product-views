import assert from 'node:assert/strict';
import test from 'node:test';
import {
  sanitizeProductDetails,
  sanitizeReviewBody,
  sanitizeSubmitBody,
  sanitizeText,
  sanitizeTextReport,
  validateProductMetadataText,
} from '../src/index.js';

const multiline = { multiline: true } as const;

test('zero-width, invisible and bidi characters are removed and counted', () => {
  const hidden = 'oak\u200B \u200Dleg\u2060s\uFEFF \u202Eevil\u202C \u2066iso\u2069 \u00ADsoft';
  const result = sanitizeTextReport(hidden);
  assert.equal(result.text, 'oak legs evil iso soft');
  assert.equal(result.removed, 9);
});

test('tag characters and data-carrying variation selectors are removed', () => {
  // "hi" smuggled as Unicode tags, and bytes hidden in VS1 and VS17 after a letter.
  const smuggled = `a\u{E0068}\u{E0069}b\uFE00\u{E0100}c`;
  assert.equal(sanitizeText(smuggled), 'abc');
});

test('C0 and C1 controls are removed; multiline keeps line feeds and tabs', () => {
  const text = 'a\u0000b\u0007c\u001Bd\u007Fe\u0085f\u009Fg';
  // NEL is a line break, not a control to drop.
  assert.equal(sanitizeText(text), 'abcde fg');
  assert.equal(sanitizeText(text, multiline), 'abcde\nfg');
  assert.equal(sanitizeText('col 1\tcol 2\nnext', multiline), 'col 1\tcol 2\nnext');
});

test('single-line fields turn line breaks and tabs into one space', () => {
  assert.equal(sanitizeText('  sketch\r\n front\t.png  '), 'sketch front .png');
});

test('line endings are normalised, blank runs collapsed and blank lines limited', () => {
  const text = 'one\r\ntwo\rthree\u2028four  \t \n\n\n\n   five    six  ';
  assert.equal(sanitizeText(text, multiline), 'one\ntwo\nthree\nfour\n\nfive six');
});

test('NFKC is applied', () => {
  // Full-width letters, a ligature and a no-break space become their plain forms.
  assert.equal(sanitizeText('ＭＯＤＥＬ\u00A0ﬁt'), 'MODEL fit');
});

test('emoji and ordinary non-ASCII text are kept', () => {
  const text = 'Café crème, 日本語のメモ 👍 ❤️ (Größe M), naïve résumé';
  assert.equal(sanitizeText(text), text);
  assert.equal(sanitizeTextReport(text).removed, 0);
});

test('sanitising is idempotent', () => {
  const samples = [
    'a\u200B b\u202E\r\n\r\n\r\nc\t\t d\u0000',
    'ＡＢＣ\u00A0 ﬁ  \u2029x',
    '{"a": "b\u200B"}',
    '  日本語 👍\u{E0041}  ',
  ];
  for (const text of samples) {
    for (const options of [{}, multiline]) {
      const once = sanitizeText(text, options);
      assert.equal(sanitizeText(once, options), once);
    }
    const details = sanitizeProductDetails(text).text;
    assert.equal(sanitizeProductDetails(details).text, details);
  }
});

test('JSON product details keep their structure, with keys and values sanitised', () => {
  const row = {
    'Colour\u200B Desc': 'IVORY\u202E',
    nested: { list: ['oak\u0007', 42, true, null], note: 'line 1\r\nline 2' },
  };
  const result = sanitizeProductDetails(JSON.stringify(row));
  assert.deepEqual(JSON.parse(result.text), {
    'Colour Desc': 'IVORY',
    nested: { list: ['oak', 42, true, null], note: 'line 1\nline 2' },
  });
  assert.equal(result.text, JSON.stringify(JSON.parse(result.text), null, 2));
  assert.equal(result.removed, 3);
});

test('JSON escapes that decode to hidden characters are removed too', () => {
  const text = '{"material": "boucl\\u00e9\\u200b\\u202e"}';
  assert.deepEqual(JSON.parse(sanitizeProductDetails(text).text), { material: 'bouclé' });
});

test('hidden characters between JSON tokens do not turn a document into text', () => {
  const checked = validateProductMetadataText('\uFEFF{\u200B"type": "chair"}');
  assert.ok(checked.ok);
  assert.equal(checked.metadata.format, 'json');
  assert.deepEqual(JSON.parse(checked.metadata.text), { type: 'chair' });
});

test('product details that are only hidden characters are empty', () => {
  const checked = validateProductMetadataText('\u200B\u202E \u0000');
  assert.ok(!checked.ok);
  assert.equal(checked.error.code, 'empty');
});

test('request bodies are sanitised field by field before their schemas run', () => {
  const body = sanitizeSubmitBody({
    productId: ' MODEL\u200B-1 ',
    inputs: [{ filename: 'sketch\u202E.png', url: 'u' }],
    productMetadata: { format: 'text', text: 'oak\u0000\r\nash' },
    notes: 'taller\u2066 back\r\n',
    requests: { notes: 'x\u200By' },
  }) as Record<string, unknown>;
  assert.deepEqual(body, {
    productId: 'MODEL-1',
    inputs: [{ filename: 'sketch.png', url: 'u' }],
    productMetadata: { format: 'text', text: 'oak\nash' },
    notes: 'taller back',
    requests: { notes: 'xy' },
  });
  assert.deepEqual(sanitizeReviewBody({ decision: 'regenerate', notes: ' a\u200Bb ' }), {
    decision: 'regenerate',
    notes: 'ab',
  });
  // Anything that is not an object is left for the schema to reject.
  assert.equal(sanitizeSubmitBody('nope'), 'nope');
});
