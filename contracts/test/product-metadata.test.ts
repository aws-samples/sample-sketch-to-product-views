import assert from 'node:assert/strict';
import test from 'node:test';
import {
  validateProductMetadata,
  validateProductMetadataFile,
  validateProductMetadataText,
} from '../src/index.js';

const file = (text: string, name = 'row.json', type = 'application/json') => ({
  name,
  type,
  size: new TextEncoder().encode(text).byteLength,
  text,
});

const code = (result: ReturnType<typeof validateProductMetadataText>) =>
  result.ok ? 'ok' : result.error.code;

test('any key names are accepted, including ones no code knows', () => {
  for (const row of [
    { 'Color Description': 'IVORY' },
    { 'Color Desc': 'IVORY' },
    { couleur: 'ivoire', 'Mat. descr': 'TECHNO COTTON POPLIN' },
  ]) {
    assert.equal(code(validateProductMetadataText(JSON.stringify(row))), 'ok');
  }
});

test('nested objects and arrays are accepted', () => {
  const text = JSON.stringify({ product: { colours: ['IVORY', 'BLACK'], model: 'MODEL-1' } });
  assert.equal(code(validateProductMetadataText(text)), 'ok');
});

test('the stored text is the parsed document re-serialised, so it is stable', () => {
  const result = validateProductMetadataText('{"Color":9002,   "Model":"MODEL-1"}');
  assert.ok(result.ok);
  assert.equal(result.metadata.text, '{\n  "Color": 9002,\n  "Model": "MODEL-1"\n}');
  assert.equal(result.metadata.format, 'json');
});

test('a UTF-8 byte-order mark is stripped before parsing', () => {
  assert.equal(code(validateProductMetadataText('\uFEFF{\"Color Desc\":\"IVORY\"}')), 'ok');
});

test('text that is not a JSON object or array is kept as trimmed text', () => {
  for (const [input, kept] of [
    ['  oak and boucle, ecru, 78 cm wide \n', 'oak and boucle, ecru, 78 cm wide'],
    ['{"Color Desc": "IVORY",}', '{"Color Desc": "IVORY",}'],
    ['42', '42'],
    ['"ivory"', '"ivory"'],
  ]) {
    const result = validateProductMetadataText(input);
    assert.ok(result.ok, input);
    assert.deepEqual(result.metadata, { format: 'text', text: kept });
  }
});

test('blank text and a JSON document with no data are rejected as empty', () => {
  for (const text of ['', '   \n', '{}', '[]', '""', 'null', '{"a": "", "b": null, "c": [" "]}']) {
    assert.equal(code(validateProductMetadataText(text)), 'empty', text);
  }
});

test('a file that is not .txt or .json is rejected by name and type', () => {
  assert.equal(
    code(validateProductMetadataFile(file('a,b', 'row.csv', 'text/csv'))),
    'unsupported_file',
  );
  // Either signal is enough: some browsers leave `type` empty.
  assert.equal(code(validateProductMetadataFile(file('{"a":1}', 'row.json', ''))), 'ok');
  assert.equal(code(validateProductMetadataFile(file('oak, ecru', 'row.txt', ''))), 'ok');
  assert.equal(code(validateProductMetadataFile(file('{"a":1}', 'row', 'application/json'))), 'ok');
});

test('a file over 64 KB is rejected before it is read', () => {
  const big = JSON.stringify({ notes: 'x'.repeat(65 * 1024) });
  assert.equal(code(validateProductMetadataFile(file(big))), 'too_large');
});

test('the API re-reads the submitted text rather than trusting the client', () => {
  assert.deepEqual(validateProductMetadata({ format: 'json', text: '{"a":1}' }), {
    ok: true,
    metadata: { format: 'json', text: '{\n  "a": 1\n}' },
  });
  // A stored value's format is recomputed: text that is not JSON is text.
  assert.deepEqual(validateProductMetadata({ format: 'json', text: '{not json' }), {
    ok: true,
    metadata: { format: 'text', text: '{not json' },
  });
  assert.equal(code(validateProductMetadata({ format: 'text', text: 'oak' })), 'ok');
  assert.equal(code(validateProductMetadata({ format: 'csv', text: 'a,b' })), 'invalid');
  assert.equal(code(validateProductMetadata('{"a":1}')), 'invalid');
});
