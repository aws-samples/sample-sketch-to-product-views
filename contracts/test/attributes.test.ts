import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  ASPECTS,
  aspectDef,
  evaluationSchema,
  isSketchSourced,
  isSpecSourced,
  type AspectDef,
} from '../src/index.js';

const CSV = new URL('../../docs/evaluation/attribute-schema.csv', import.meta.url);

/** The CSV is semicolon separated, UTF-8 with a BOM, and quotes cells that hold a `;`. */
function csvRows(): Record<string, string>[] {
  const text = readFileSync(CSV, 'utf8').replace(/^﻿/, '');
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  const split = (line: string) => {
    const cells: string[] = [];
    let cell = '';
    let quoted = false;
    for (const ch of line) {
      if (ch === '"') quoted = !quoted;
      else if (ch === ';' && !quoted) {
        cells.push(cell);
        cell = '';
      } else cell += ch;
    }
    cells.push(cell);
    return cells;
  };
  const [header, ...rows] = lines.map(split);
  return rows.map((cells) => Object.fromEntries(header.map((h, i) => [h, cells[i] ?? ''])));
}

/** "spec (Color Description), swatch" reads as {spec, swatch}. */
function csvSources(cell: string): string[] {
  return cell
    .replace(/\([^)]*\)/g, '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (s === 'output convention' ? 'convention' : s))
    .sort();
}

test('the aspect CSV and the code list the same aspects, sources, weights and hard facts', () => {
  const rows = csvRows();
  assert.deepEqual(
    rows.map((r) => r.aspect),
    ASPECTS.map((a) => a.name),
  );
  for (const row of rows) {
    const def = aspectDef(row.aspect);
    assert.deepEqual([...def.sources].sort(), csvSources(row.compared_with), row.aspect);
    assert.equal(def.weight, row.weight, row.aspect);
    assert.equal(def.hard ? 'yes' : 'no', row.hard_fail, row.aspect);
  }
});

test('colour is never compared with the sketch', () => {
  const color = aspectDef('color');
  assert.equal(isSketchSourced(color), false);
  assert.equal(isSpecSourced(color), true);
});

test('only object type, colour and presentation are hard facts', () => {
  assert.deepEqual(
    (ASPECTS as readonly AspectDef[]).filter((a) => a.hard).map((a) => a.name),
    ['object_type', 'color', 'presentation'],
  );
});

const stored = {
  verdict: 'pass',
  scores: { sketchFidelity: 1, specAdherence: 1, imageQuality: 0.9 },
  issues: [],
  reviewer: 'judge',
};

test('an evaluation without aspect results parses', () => {
  assert.equal(evaluationSchema.safeParse(stored).success, true);
});

test('an evaluation stored by the earlier critic still parses', () => {
  const earlier = {
    ...stored,
    attributes: [
      {
        attribute: 'fit',
        expected: 'large',
        observed: 'oversized',
        outcome: 'close',
        confidence: 0.9,
      },
    ],
  };
  assert.equal(evaluationSchema.safeParse(earlier).success, true);
});

test('an evaluation with reasons and a confirmation parses', () => {
  const pairwise = {
    ...stored,
    verdict: 'warn',
    attributes: [
      {
        attribute: 'part: handle',
        expected: 'a loop handle',
        observed: 'no handle',
        outcome: 'mismatch',
        confidence: 1,
        reason: 'the handle is missing',
      },
    ],
    confirmation: { failedOn: ['color'], confirmed: [] },
  };
  assert.equal(evaluationSchema.safeParse(pairwise).success, true);
});
