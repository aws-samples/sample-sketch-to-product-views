import assert from 'node:assert/strict';
import { test } from 'node:test';
import { STAGES } from '@sketch-to-product-views/contracts';
import {
  layoutFlow,
  NODE_H,
  NODE_W,
  PROMPT_ID,
  selectionAfterClick,
} from '../src/lib/flow-layout.js';
import { diffPrompts } from '../src/lib/prompt-diff.js';

/**
 * The canvas is a lens over the event log, so what is worth testing is the geometry and the
 * diff — the two pieces that compute something rather than render it.
 */

/** Uniform cards: the topology must hold whatever heights the run's outputs ask for. */
const LAYOUT = layoutFlow(() => NODE_H);

test('every stage gets exactly one node', () => {
  assert.equal(LAYOUT.nodes.length, STAGES.length);
  assert.deepEqual([...LAYOUT.nodes.map((n) => n.id)].sort(), [...STAGES.map((s) => s.id)].sort());
});

test('the chain walks every stage in order, with the prompt spliced into the spec → generate hop', () => {
  const sequence = LAYOUT.edges.filter((e) => e.kind === 'sequence');
  // One hop per consecutive pair, plus one: the prompt splits a hop in two.
  assert.equal(sequence.length, STAGES.length);

  // Without the prompt, the chain is exactly the stages in contract order.
  const walk: string[] = [sequence[0].source];
  for (const edge of sequence) {
    assert.equal(edge.source, walk[walk.length - 1], 'the chain must not branch');
    walk.push(edge.target);
  }
  assert.deepEqual(
    walk.filter((id) => id !== PROMPT_ID),
    STAGES.map((s) => s.id),
  );
});

test('a failed evaluation loops back to the prompt, which is what actually changes', () => {
  const retry = LAYOUT.edges.filter((e) => e.kind === 'retry');
  assert.equal(retry.length, 1);
  assert.equal(retry[0].source, 'evaluate_2d');
  assert.equal(retry[0].target, PROMPT_ID);
});

test('the prompt sits in the gap between the two columns it joins, overlapping neither', () => {
  const byId = new Map(LAYOUT.nodes.map((n) => [n.id, n]));
  const spec = byId.get('complete_spec')!;
  const gen = byId.get('generate_2d')!;
  const { prompt } = LAYOUT;

  assert.ok(prompt.x >= spec.x + NODE_W, 'must clear the intake column');
  assert.ok(prompt.x + prompt.width <= gen.x, 'must clear the 2D column');
  // Vertically between the midpoints of the two stages, so the three read as one line.
  const mid = prompt.y + prompt.height / 2;
  const low = Math.min(spec.y + spec.height / 2, gen.y + gen.height / 2);
  const high = Math.max(spec.y + spec.height / 2, gen.y + gen.height / 2);
  assert.ok(mid >= low && mid <= high);
});

test('groups occupy distinct columns and never overlap', () => {
  const byId = new Map(LAYOUT.nodes.map((n) => [n.id, n]));
  const columns = new Map<string, number>();
  for (const stage of STAGES) {
    const x = byId.get(stage.id)!.x;
    const existing = columns.get(stage.group);
    if (existing === undefined) columns.set(stage.group, x);
    else assert.equal(x, existing, `${stage.id} should share its group's column`);
  }
  const xs = [...columns.values()].sort((a, b) => a - b);
  assert.equal(new Set(xs).size, xs.length, 'each group needs its own column');
  for (let i = 1; i < xs.length; i += 1) {
    assert.ok(xs[i] - xs[i - 1] >= NODE_W, 'columns must not overlap');
  }
});

test('an appended clause reads as one added run, not one per word', () => {
  const tokens = diffPrompts('a pink leather skirt', 'a pink leather skirt on white');
  assert.deepEqual(tokens, [
    { text: 'a pink leather skirt', kind: 'same' },
    { text: 'on white', kind: 'added' },
  ]);
});

test('a replaced word shows as removed and added, leaving the rest untouched', () => {
  const tokens = diffPrompts('a pink skirt on white', 'a pink dress on white');
  assert.deepEqual(
    tokens.filter((t) => t.kind !== 'same'),
    [
      { text: 'skirt', kind: 'removed' },
      { text: 'dress', kind: 'added' },
    ],
  );
  assert.equal(
    tokens
      .filter((t) => t.kind === 'same')
      .map((t) => t.text)
      .join(' '),
    'a pink on white',
  );
});

test('an unchanged prompt produces no highlights', () => {
  const prompt = 'a pink leather skirt, studio lighting';
  assert.deepEqual(diffPrompts(prompt, prompt), [{ text: prompt, kind: 'same' }]);
});

test('a taller card pushes the ones below it down instead of overlapping them', () => {
  // The generate card grows to hold its views; everything under it must move.
  const layout = layoutFlow((id) => (id === 'generate_2d' ? NODE_H + 200 : NODE_H));
  const byColumn = new Map<number, typeof layout.nodes>();
  for (const node of layout.nodes) {
    byColumn.set(node.x, [...(byColumn.get(node.x) ?? []), node]);
  }
  for (const column of byColumn.values()) {
    const ordered = [...column].sort((a, b) => a.y - b.y);
    for (let i = 1; i < ordered.length; i += 1) {
      const above = ordered[i - 1];
      assert.ok(ordered[i].y >= above.y + above.height, `${ordered[i].id} overlaps ${above.id}`);
    }
  }
});

test('each band encloses its own column and no other', () => {
  const layout = layoutFlow(() => NODE_H);
  assert.equal(layout.bands.length, new Set(STAGES.map((s) => s.group)).size);

  const byId = new Map(layout.nodes.map((n) => [n.id, n]));
  for (const band of layout.bands) {
    for (const stage of STAGES) {
      const node = byId.get(stage.id)!;
      const inside = node.x >= band.x && node.x + NODE_W <= band.x + band.width;
      assert.equal(
        inside,
        stage.group === band.id,
        `${stage.id} should ${stage.group === band.id ? '' : 'not '}sit inside band ${band.id}`,
      );
    }
  }

  const ordered = [...layout.bands].sort((a, b) => a.x - b.x);
  for (let i = 1; i < ordered.length; i += 1) {
    assert.ok(ordered[i].x >= ordered[i - 1].x + ordered[i - 1].width, 'bands must not overlap');
  }
});

test('a click on a column band clears the selection instead of selecting an unknown stage', () => {
  for (const band of layoutFlow(() => NODE_H).bands) {
    assert.equal(selectionAfterClick(`band:${band.id}`, 'analyse'), null);
  }
  assert.equal(selectionAfterClick('analyse', null), 'analyse');
  assert.equal(selectionAfterClick('analyse', 'analyse'), null, 'a second click closes it');
  assert.equal(selectionAfterClick(PROMPT_ID, null), PROMPT_ID);
});
