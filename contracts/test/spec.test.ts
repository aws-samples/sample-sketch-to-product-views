import assert from 'node:assert/strict';
import test from 'node:test';
import { SPEC_FIELDS, completeSpec, warningFor, type SketchAnalysis } from '../src/index.js';

type Product = SketchAnalysis['product'];
const none = { value: '', source: 'none' } as const;
const fromMetadata = (value: string) => ({ value, source: 'metadata' }) as const;
const fromImage = (value: string) => ({ value, source: 'image' }) as const;

function analysis(
  product: Partial<Product> = {},
  rest: Partial<SketchAnalysis> = {},
): SketchAnalysis {
  return {
    product: {
      type: none,
      colour: none,
      material: none,
      dimensions: none,
      ...product,
    },
    views: ['front'],
    parts: [],
    details: [],
    ignored: [],
    observedColours: ['navy'],
    materialCues: ['quilted', 'matte woven'],
    assumptions: [],
    ...rest,
  };
}

test('no field is ever filled from a default: an empty analysis gives an empty spec', () => {
  const spec = completeSpec('P1', analysis({}, { observedColours: [], materialCues: [] }), {
    hasMaterial: false,
  });
  assert.deepEqual(spec, { model: 'P1', views: ['front'] });
});

test('metadata values are supplied and win over what the images show', () => {
  const spec = completeSpec(
    'MODEL-1',
    analysis({ type: fromMetadata('Lounge Chair'), colour: fromMetadata('IVORY') }),
    { hasMaterial: false },
  );
  assert.deepEqual(spec.productType, {
    value: 'lounge chair',
    raw: 'Lounge Chair',
    provenance: 'supplied',
  });
  // The sketch is drawn navy; the colour in the metadata is what gets generated.
  assert.deepEqual(spec.colorDescription, { value: 'ivory', raw: 'IVORY', provenance: 'supplied' });
});

test('with no metadata, type, colour and material are all observed', () => {
  const spec = completeSpec('P1', analysis({ type: fromImage('kettle') }), { hasMaterial: false });
  assert.equal(spec.productType?.provenance, 'observed');
  assert.deepEqual(spec.colorDescription, { value: 'navy', provenance: 'observed' });
  assert.deepEqual(spec.materialDescription, {
    value: 'quilted and matte woven',
    provenance: 'observed',
  });
});

test('partial metadata: only the missing fields are observed', () => {
  const spec = completeSpec(
    'P1',
    analysis({ colour: fromMetadata('PINK'), type: fromImage('desk lamp') }),
    { hasMaterial: false },
  );
  assert.equal(spec.colorDescription?.provenance, 'supplied');
  assert.equal(spec.productType?.provenance, 'observed');
});

test('a material sample replaces observed colour and material, never supplied ones', () => {
  const observedOnly = completeSpec('P1', analysis(), { hasMaterial: true });
  assert.equal(observedOnly.colorDescription, undefined);
  assert.equal(observedOnly.materialDescription, undefined);

  const withMetadata = completeSpec(
    'P1',
    analysis({ colour: fromMetadata('PINK'), material: fromMetadata('VERY LIGHT MATTE LEATHER') }),
    { hasMaterial: true },
  );
  assert.equal(withMetadata.colorDescription?.value, 'pink');
  assert.equal(withMetadata.materialDescription?.value, 'very light matte leather');
});

test('no observed colour, as from an uncoloured sketch, leaves the colour to the sketch', () => {
  const uncoloured = analysis({}, { observedColours: [] });
  assert.equal(completeSpec('P1', uncoloured, { hasMaterial: false }).colorDescription, undefined);
});

test('the details reach the spec as the analyser gave them', () => {
  const details = [
    { description: 'small embossed logo', location: 'left of the lid', view: 'front' },
  ] as const;
  const parts = [{ name: 'handle', description: 'a loop', location: 'top' }];
  const ignored = ['a handwritten note'];
  const spec = completeSpec('P1', analysis({}, { details: [...details], parts, ignored }), {
    hasMaterial: true,
  });
  assert.deepEqual(spec.details, details);
  assert.deepEqual(spec.parts, parts);
  assert.deepEqual(spec.ignored, ignored);
  const bare = completeSpec('P1', analysis(), { hasMaterial: true });
  assert.equal(bare.details, undefined);
  assert.equal(bare.parts, undefined);
  assert.equal(bare.ignored, undefined);
});

test('dimensions are taken from the metadata only, and normalised', () => {
  const supplied = completeSpec('P1', analysis({ dimensions: fromMetadata('W 78  x H 74 CM') }), {
    hasMaterial: false,
  });
  assert.deepEqual(supplied.dimensions, {
    value: 'w 78 x h 74 cm',
    raw: 'W 78  x H 74 CM',
    provenance: 'supplied',
  });
  // `checkAnalysis` already drops image-sourced dimensions; the spec never observes them.
  const observed = completeSpec('P1', analysis({ dimensions: fromImage('80 cm') }), {
    hasMaterial: false,
  });
  assert.equal(observed.dimensions, undefined);
});

test('every present field carries a provenance', () => {
  const spec = completeSpec(
    'P1',
    analysis({ type: fromMetadata('Side Table'), dimensions: fromMetadata('45 cm tall') }),
    { hasMaterial: false },
  );
  for (const key of SPEC_FIELDS) {
    const field = spec[key];
    if (field) assert.ok(['supplied', 'observed'].includes(field.provenance), key);
  }
});

test('warningFor joins the missing views, the assumptions and one sentence per gap', () => {
  const a = analysis(
    {},
    {
      observedColours: [],
      materialCues: [],
      assumptions: ['The tabletop is blue and the legs black.'],
    },
  );
  const spec = completeSpec('P1', a, { hasMaterial: false });
  assert.equal(
    warningFor(spec, { hasMaterial: false }),
    'Only the front view is available; the back and the side will be assumed. ' +
      'Assumed: The tabletop is blue and the legs black. ' +
      'No product type found. No colour found. No material found.',
  );
});

test('warningFor names the views that will be assumed, and is quiet about a missing side', () => {
  const at = (...views: ('front' | 'back' | 'side')[]) =>
    warningFor(
      {
        model: 'P1',
        productType: { value: 'x', provenance: 'supplied' },
        views,
      },
      { hasMaterial: true },
    );
  assert.equal(
    at('back'),
    'Only the back view is available; the front and the side will be assumed.',
  );
  assert.equal(
    at('back', 'side'),
    'Only the back and side views are available; the front will be assumed.',
  );
  assert.equal(at(), 'No front, back or side view is available; all three will be assumed.');
  assert.equal(at('front', 'back'), undefined);
});

test('completeSpec records the views in front, back, side order and the assumptions', () => {
  const spec = completeSpec(
    'P1',
    analysis(
      {},
      {
        views: ['side', 'front'],
        assumptions: ['The stripes are red.'],
      },
    ),
    { hasMaterial: true },
  );
  assert.deepEqual(spec.views, ['front', 'side']);
  assert.deepEqual(spec.assumptions, ['The stripes are red.']);
});

test('warningFor ignores colour and material gaps when there is a material sample', () => {
  const a = analysis({ type: fromMetadata('Side Table') }, { views: ['front', 'back'] });
  const spec = completeSpec('P1', a, { hasMaterial: true });
  assert.equal(warningFor(spec, { hasMaterial: true }), undefined);
});

test('warningFor returns undefined when there is nothing to say', () => {
  const a = analysis(
    {
      type: fromMetadata('Side Table'),
      colour: fromMetadata('PINK'),
      material: fromMetadata('WALNUT'),
    },
    { views: ['front', 'back'] },
  );
  const spec = completeSpec('P1', a, { hasMaterial: false });
  assert.equal(warningFor(spec, { hasMaterial: false }), undefined);
});

test('the same analysis always gives the same spec', () => {
  const a = analysis({ type: fromMetadata('Lounge Chair') });
  assert.deepEqual(
    completeSpec('P1', a, { hasMaterial: false }),
    completeSpec('P1', a, { hasMaterial: false }),
  );
});

test('the spec records what each image is, and the warning names the images not used as such', () => {
  const read = (image: number, kind: 'sketch' | 'photo' | 'material' | 'ignored') => ({
    image,
    kind,
    views: kind === 'sketch' ? (['front', 'back'] as const).slice() : [],
    description: '',
  });
  const a = analysis(
    { type: fromMetadata('Lamp') },
    {
      views: ['front', 'back'],
      images: [read(1, 'sketch'), read(2, 'material'), read(3, 'material'), read(4, 'ignored')],
    },
  );
  const spec = completeSpec('P1', a, { hasMaterial: true });
  assert.deepEqual(spec.imageKinds, ['sketch', 'material', 'material', 'ignored']);
  assert.equal(
    warningFor(spec, { hasMaterial: true }),
    'Image 2 is the material sample; image 3 is another material sample, sent as a reference only. Image 4 does not show the product and is not used.',
  );
  assert.equal(completeSpec('P1', analysis(), { hasMaterial: false }).imageKinds, undefined);
});
