import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PipelineState } from '@sketch-to-product-views/contracts';
import { inputDescriptions, inputLabels } from '../src/lib/inputs.js';

const inputs = [
  { filename: 'a.jpg', url: '' },
  { filename: 'b.jpg', url: '' },
] as PipelineState['inputs'];

test('each thumbnail is labelled with what the analyser decided', () => {
  const analysis = {
    images: [
      { image: 1, kind: 'photo', views: ['front'], description: 'a prototype' },
      { image: 2, kind: 'material', views: [], description: 'oak veneer' },
    ],
  } as unknown as PipelineState['analysis'];
  assert.deepEqual(inputLabels({ inputs, analysis }), ['Photo', 'Material sample']);
  assert.deepEqual(inputLabels({ inputs, analysis }, { short: true }), ['Photo', 'Material']);
  assert.deepEqual(inputDescriptions({ inputs, analysis }), [
    'a.jpg: a prototype',
    'b.jpg: oak veneer',
  ]);
});

test('before the analysis, an image is its number, or an older client’s tag', () => {
  const tagged = [inputs[0], { ...inputs[1], role: 'swatch' as const }];
  assert.deepEqual(inputLabels({ inputs: tagged }), ['Image 1', 'Material sample']);
  assert.deepEqual(inputLabels({ inputs: tagged }, { short: true }), ['Image 1', 'Material']);
});
