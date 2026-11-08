import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CANDIDATE_VIEWS, type ProductSpec } from '@sketch-to-product-views/contracts';
import {
  VIEWS_FROM_FRONT,
  drawnViewFor,
  imageSettings,
  planViewCall,
  sketchDraws,
  viewInputs,
} from '../src/generate/views.js';
import { modelById } from '../src/registry/index.js';

const spec = (views?: ProductSpec['views']): ProductSpec => ({
  model: 'MODEL-10',
  productType: { value: 'kettle', provenance: 'supplied' },
  ...(views ? { views } : {}),
});

test('the front and the views made from it are exactly the generated views', () => {
  assert.deepEqual(['front', ...VIEWS_FROM_FRONT], [...CANDIDATE_VIEWS]);
});

test('a drawn side stands for both profiles', () => {
  assert.equal(drawnViewFor('left'), 'side');
  assert.equal(drawnViewFor('right'), 'side');
  assert.equal(drawnViewFor('back'), 'back');
  assert.ok(sketchDraws(spec(['front', 'side']), 'left'));
  assert.ok(sketchDraws(spec(['front', 'side']), 'right'));
  assert.equal(sketchDraws(spec(['front', 'side']), 'back'), false);
  // No views recorded: the sketch is the front.
  assert.ok(sketchDraws(spec(), 'front'));
  assert.equal(sketchDraws(spec(), 'back'), false);
});

test('the front call sends the sketch, and the material sample when the product has one', () => {
  assert.deepEqual(planViewCall('front', spec(['front']), { hasSwatch: false }).inputs, ['sketch']);
  const call = planViewCall('front', spec(['front']), { hasSwatch: true });
  assert.deepEqual(call.inputs, ['sketch', 'swatch']);
  assert.match(call.prompt, /The second is a sample of its material/);
  assert.match(call.prompt, /the front view, seen straight on/);
});

test('a view the sketch does not draw gets the renders alone, and no material sample', () => {
  const back = planViewCall('back', spec(['front']), { hasSwatch: true });
  assert.deepEqual(back.inputs, ['front_render']);
  assert.match(back.prompt, /^The attached image is a product photograph of the finished kettle/);
  for (const view of ['left', 'right'] as const) {
    const call = planViewCall(view, spec(['front']), { hasSwatch: true });
    assert.deepEqual(call.inputs, ['front_render', 'back_render'], view);
    assert.match(
      call.prompt,
      /^The first attached image is a product photograph of the finished kettle seen from the front[^\n]*The second is a photograph of the same finished product seen from directly behind/,
    );
  }
  for (const view of VIEWS_FROM_FRONT) {
    assert.doesNotMatch(
      planViewCall(view, spec(['front']), { hasSwatch: true }).prompt,
      /material sample/,
    );
  }
});

test('a view the sketch draws gets the sketch, the material sample and the renders, in that order', () => {
  const back = planViewCall('back', spec(['front', 'back']), { hasSwatch: true });
  assert.deepEqual(back.inputs, ['sketch', 'swatch', 'front_render']);
  assert.match(back.prompt, /The third is a photograph of the finished product/);
  const right = planViewCall('right', spec(['front', 'side']), { hasSwatch: false });
  assert.deepEqual(right.inputs, ['sketch', 'front_render', 'back_render']);
  assert.match(right.prompt, /The second is a photograph of the finished product/);
  assert.match(
    right.prompt,
    /The third is a photograph of the same finished product seen from directly behind/,
  );
  assert.match(right.prompt, /the right side view, in full right profile/);
});

test('viewInputs resolves the plan in call order and refuses a missing input', () => {
  const have = { sketch: 'k/sketch', swatch: 'k/swatch', front_render: 'k/front' };
  assert.deepEqual(viewInputs(['sketch', 'swatch', 'front_render'], have), [
    'k/sketch',
    'k/swatch',
    'k/front',
  ]);
  assert.deepEqual(viewInputs(['front_render'], have), ['k/front']);
  assert.deepEqual(viewInputs(['sketch', 'swatch'], { ...have, sketch: ['k/front', 'k/back'] }), [
    'k/front',
    'k/back',
    'k/swatch',
  ]);
  assert.throws(
    () => viewInputs(['sketch'], { sketch: [] }),
    /the sketch is needed for this view and was not given/,
  );
  assert.throws(
    () => viewInputs(['sketch', 'front_render'], { sketch: 'k/sketch' }),
    /the front render is needed for this view and was not given/,
  );
});

test('the views are rendered at the registry defaults unless the deployment overrides them', () => {
  const entry = modelById('gpt-image-sunburst-openai');
  assert.deepEqual(imageSettings(entry), { size: '2336x3504', quality: 'max' });
  assert.deepEqual(imageSettings(entry, { size: '1536x2304', quality: 'high' }), {
    size: '1536x2304',
    quality: 'high',
  });
  assert.deepEqual(imageSettings(entry, { size: '', quality: ' ' }), {
    size: '2336x3504',
    quality: 'max',
  });
  assert.throws(
    () => imageSettings(entry, { size: '4096x6144' }),
    /gpt-image-sunburst-openai does not offer size "4096x6144"; options: 2336x3504, 1536x2304/,
  );
  assert.throws(() => imageSettings(entry, { quality: 'ultra' }), /does not offer quality "ultra"/);
});

test('every GPT image entry renders the same size and quality by default', () => {
  const ids = [
    'gpt-image-flare',
    'gpt-image-flare-openai',
    'gpt-image-sunburst',
    'gpt-image-sunburst-openai',
  ];
  for (const id of ids) {
    assert.deepEqual(imageSettings(modelById(id)), { size: '2336x3504', quality: 'max' }, id);
  }
});

test('the corrections of a view reach its prompt, whatever images it gets', () => {
  for (const views of [['front'], ['front', 'back']] as const) {
    const call = planViewCall('back', spec([...views]), {
      hasSwatch: false,
      corrections: ['the hood is missing'],
    });
    assert.match(call.prompt, /- the hood is missing\.$/);
  }
});

test('complexity is a setting only where the model declares it, square and landscape included', () => {
  const v26 = modelById('gpt-image-2.6-sunburst-openai');
  assert.deepEqual(imageSettings(v26), { size: '2336x3504', quality: 'max', complexity: 'high' });
  assert.deepEqual(
    imageSettings(v26, { size: '1024x1024', quality: 'medium', complexity: 'low' }),
    {
      size: '1024x1024',
      quality: 'medium',
      complexity: 'low',
    },
  );
  assert.equal(imageSettings(v26, { size: '1536x1024' }).size, '1536x1024');
  // 2.5 has no complexity: an override is ignored rather than sent.
  assert.equal(
    imageSettings(modelById('gpt-image-sunburst-openai'), { complexity: 'low' }).complexity,
    undefined,
  );
});

test('every call passes on what the design references are, render-only ones included', () => {
  const options = { hasSwatch: true, designKinds: ['photo'] as const };
  for (const view of CANDIDATE_VIEWS) {
    assert.doesNotMatch(planViewCall(view, spec(['front']), options).prompt, /sketch/i, view);
  }
});
