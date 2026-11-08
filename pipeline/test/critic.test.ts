import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DETAIL_BUDGET_BYTES,
  type AttributeResult,
  type Candidate,
  type Evaluation,
  type ProductSpec,
} from '@sketch-to-product-views/contracts';
import { evaluationDetail } from '../src/handler.js';

const ATTRIBUTE_NAMES = [
  'object_type',
  'shape',
  'proportions',
  'color',
  'material',
  'pattern',
  'presentation',
  'part: handle',
  'part: lid',
  'part: spout',
  'part: base',
  'part: strap',
  'part: zip',
  'part: pocket',
  'part: sole',
  'part: lace',
];

function evaluationWith(mismatched: Set<string>): Evaluation {
  const attributes: AttributeResult[] = ATTRIBUTE_NAMES.map((attribute) => ({
    attribute,
    expected: `expected_${attribute}_value`,
    observed: mismatched.has(attribute)
      ? `observed_${attribute}_value`
      : `expected_${attribute}_value`,
    outcome: mismatched.has(attribute) ? 'mismatch' : 'match',
    confidence: 0.82,
  }));
  return {
    verdict: 'fail',
    scores: { sketchFidelity: 0.4, specAdherence: 0.5, imageQuality: 0.9 },
    issues: [...mismatched].map((a) => `${a} does not match the sketch or the specification`),
    reviewer: 'judge',
    model: {
      id: 'nova-pro',
      name: 'Nova Pro',
      bedrockModelId: 'us.amazon.nova-pro-v1:0',
      region: 'us-east-1',
    },
    attributes,
  };
}

const candidate: Candidate = {
  id: 'c0ffee00-0000-4000-8000-000000000000',
  url: 'https://example.invalid/candidate.png',
  key: 'runs/p/rev/candidates/1.png',
  modelId: 'nova-canvas',
  attempt: 1,
  createdAt: '2026-09-24T10:00:00.000Z',
};

const spec: ProductSpec = {
  model: '871735',
  colorDescription: { value: 'pink', raw: 'PINK', provenance: 'supplied' },
};

test('a sixteen-attribute evaluation fits the stage detail budget and lists only the mismatches', () => {
  const mismatched = new Set(['color', 'part: handle', 'part: lid']);
  const detail = evaluationDetail(candidate, spec, evaluationWith(mismatched), 1);

  assert.ok(JSON.stringify(detail).length < DETAIL_BUDGET_BYTES);
  assert.equal(detail.truncated, undefined);

  const output = detail.output as { attributes?: unknown; mismatches: string[] };
  assert.equal(output.attributes, undefined);
  assert.deepEqual(output.mismatches, [
    'color: expected_color_value → observed_color_value',
    'part: handle: expected_part: handle_value → observed_part: handle_value',
    'part: lid: expected_part: lid_value → observed_part: lid_value',
  ]);
  assert.equal(detail.facts?.mismatched, '3 of 16');
});

test('an evaluation where all sixteen attributes mismatch still fits the stage detail budget', () => {
  const detail = evaluationDetail(candidate, spec, evaluationWith(new Set(ATTRIBUTE_NAMES)), 1);

  assert.ok(JSON.stringify(detail).length < DETAIL_BUDGET_BYTES);
  assert.equal(detail.truncated, undefined);
  assert.equal((detail.output as { mismatches: string[] }).mismatches.length, 16);
});

test('an evaluation without attributes records no mismatch list', () => {
  const { attributes: _, ...plain } = evaluationWith(new Set());
  const detail = evaluationDetail(candidate, spec, plain, 1);

  assert.equal((detail.output as { mismatches?: unknown }).mismatches, undefined);
  assert.equal(detail.facts?.mismatched, undefined);
});
