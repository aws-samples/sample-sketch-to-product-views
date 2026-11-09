import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { z } from 'zod';
import type { ProductSpec } from '@sketch-to-product-views/contracts';
import {
  askedAspects,
  asksParts,
  bedrockJsonSchema,
  comparisonPrompt,
  comparisonSchema,
  suppliedFacts,
  type AskContext,
} from '../src/qc/judge/index.js';

const supplied = (value: string) => ({ value, provenance: 'supplied' as const });

const lamp: ProductSpec = {
  model: 'LAMP-1',
  productType: supplied('Desk lamp'),
  colorDescription: supplied('Matte black'),
  materialDescription: { value: 'aluminium', provenance: 'observed' },
};

const ctx = (over: Partial<AskContext> = {}): AskContext => ({
  facts: suppliedFacts(lamp),
  swatch: false,
  ...over,
});

const names = (c: AskContext) => askedAspects(c).map((d) => d.name);
const prompt = (c: AskContext) =>
  comparisonPrompt({ ...c, aspects: askedAspects(c), parts: asksParts(c) });

test('only supplied facts reach the critic, never the analyser’s own reading', () => {
  assert.deepEqual(suppliedFacts(lamp), { productType: 'Desk lamp', colour: 'Matte black' });
});

test('presentation and parts are not single-answer aspects', () => {
  const asked = names(ctx());
  assert.deepEqual(asked, ['object_type', 'shape', 'proportions', 'color', 'pattern']);
});

test('colour is asked against the supplied colour or the material sample, never the sketch', () => {
  assert.match(
    prompt(ctx()),
    /- color: the dominant colour, against the supplied colour, never the sketch\./,
  );
  assert.ok(!names(ctx({ facts: {} })).includes('color'), 'nothing states a colour');
  assert.match(
    prompt(ctx({ facts: {}, swatch: true })),
    /- color: the dominant colour, against the material sample, never the sketch\./,
  );
  // An observed material is not a fact: without a sample, the material is not asked.
  assert.ok(!names(ctx()).includes('material'));
  assert.ok(names(ctx({ swatch: true })).includes('material'));
});

test('an aspect the reviewer changed is not asked', () => {
  assert.ok(!names(ctx({ changed: ['shape'] })).includes('shape'));
  assert.equal(asksParts(ctx({ changed: ['parts'] })), false);
  assert.doesNotMatch(prompt(ctx({ changed: ['parts'] })), /under parts/);
});

test('the prompt names the view, the images in order and the facts as data', () => {
  const text = prompt(ctx({ view: 'right', swatch: true }));
  assert.match(text, /2\. The generated image to check\. It shows the right side view/);
  assert.match(text, /3\. The material sample: the material and finish the object is made of\./);
  assert.match(text, /- product type: "Desk lamp"/);
  assert.match(text, /- object_type: what the object is, against the sketch and the supplied/);
  assert.match(prompt(ctx({ facts: {} })), /No product facts were supplied\./);
});

test('the prompt is object-neutral', () => {
  for (const view of ['front', 'back', 'left', 'right'] as const) {
    const text = prompt(ctx({ view, swatch: true }));
    assert.doesNotMatch(text, /garment|fabric|sleeve|neckline|mannequin|swatch/i, view);
  }
});

test('the schema has no union and no optional property, within Bedrock’s limits', () => {
  const c = ctx({ swatch: true, facts: { colour: 'red', material: 'oak' } });
  const json = JSON.stringify(
    bedrockJsonSchema(z.toJSONSchema(comparisonSchema(askedAspects(c), true))),
  );
  assert.doesNotMatch(json, /anyOf|"type":\[/);
  const schema = JSON.parse(json);
  const allRequired = (o: { properties?: object; required?: string[] }) =>
    Object.keys(o.properties ?? {}).length === (o.required ?? []).length;
  assert.ok(allRequired(schema) && allRequired(schema.properties.aspects));
});

test('the spec quotes the front prompt verbatim', () => {
  const spec = readFileSync(new URL('../../docs/spec/07-critic.md', import.meta.url), 'utf8');
  const text = prompt(ctx({ view: 'front', swatch: true }));
  assert.ok(spec.includes(text), 'docs/spec/07-critic.md is out of date with comparisonPrompt');
});

test('a photo standing in for the sketch is described as one, and the spec quotes it', () => {
  const line =
    "1. The sketch: a photograph or render of the object or of a prototype of it, standing in for the designer's drawing. It sets what the object is, its shape, its proportions and its parts. Its colour and material may not be final, so it says nothing about colour or material.";
  assert.ok(prompt(ctx({ sketchKind: 'photo' })).includes(line));
  assert.ok(!prompt(ctx()).includes(line));
  const spec = readFileSync(new URL('../../docs/spec/07-critic.md', import.meta.url), 'utf8');
  assert.ok(spec.includes(line), 'docs/spec/07-critic.md does not quote the photo line');
});
