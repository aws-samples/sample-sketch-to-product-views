import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseCsv, readLabels } from '../scripts/critic-measure.js';

test('a labels CSV reads quoted cells, defaults the view and coerces the attempt', () => {
  assert.deepEqual(parseCsv('a,b\n"x, ""y""",2\r\n'), [{ a: 'x, "y"', b: '2' }]);
  const dir = mkdtempSync(join(tmpdir(), 'labels-'));
  const csv = join(dir, 'labels.csv');
  writeFileSync(
    csv,
    'revisionId,view,attempt,label,note\nr-1,,1,good,\nr-1,left,2,bad,"belt, wrong"\n',
  );
  assert.deepEqual(readLabels(csv), [
    { revisionId: 'r-1', view: 'front', attempt: 1, label: 'good' },
    { revisionId: 'r-1', view: 'left', attempt: 2, label: 'bad', note: 'belt, wrong' },
  ]);
});

test('a JSON label with an unknown verdict is refused, naming its row', () => {
  const dir = mkdtempSync(join(tmpdir(), 'labels-'));
  const json = join(dir, 'labels.json');
  writeFileSync(json, JSON.stringify([{ revisionId: 'r-1', attempt: 1, label: 'meh' }]));
  assert.throws(() => readLabels(json), /label 1:/);
});
