import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SKETCH_ANALYSIS_JSON_SCHEMA,
  checkAnalysis,
  imagesIssue,
  noDesignReference,
  rawAnalysisSchema,
  type RawAnalysis,
} from '../src/index.js';

const none = { value: '', source: 'none' } as const;

function rawAnalysis(overrides: Partial<RawAnalysis> = {}): RawAnalysis {
  return {
    product: { type: none, colour: none, material: none, dimensions: none },
    images: [{ image: 1, kind: 'sketch', views: ['front'], description: 'a front sketch' }],
    parts: [],
    details: [],
    ignored: [],
    observedColours: ['navy'],
    materialCues: [],
    assumptions: [],
    ...overrides,
  };
}

/** Every keyword the schema uses, collected recursively. */
function keywords(node: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(node)) node.forEach((n) => keywords(n, found));
  else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      found.add(key);
      // `properties` maps field names, not keywords; only its values are schemas.
      if (key === 'properties') Object.values(value as object).forEach((v) => keywords(v, found));
      else keywords(value, found);
    }
  }
  return found;
}

test('the JSON Schema uses only keywords Bedrock structured outputs support', () => {
  const allowed = new Set([
    'type',
    'properties',
    'required',
    'additionalProperties',
    'items',
    'enum',
  ]);
  for (const keyword of keywords(SKETCH_ANALYSIS_JSON_SCHEMA)) {
    assert.ok(allowed.has(keyword), `unsupported keyword: ${keyword}`);
  }
});

test('every object in the JSON Schema forbids additional properties and requires every field', () => {
  const walk = (node: Record<string, unknown>) => {
    if (node.type === 'object') {
      assert.equal(node.additionalProperties, false);
      assert.deepEqual(node.required, Object.keys(node.properties as object));
      Object.values(node.properties as object).forEach(walk);
    }
    if (node.type === 'array') walk(node.items as Record<string, unknown>);
  };
  walk(SKETCH_ANALYSIS_JSON_SCHEMA);
});

test('the zod mirror accepts a valid response and rejects an extra field', () => {
  assert.equal(rawAnalysisSchema.safeParse(rawAnalysis()).success, true);
  assert.equal(rawAnalysisSchema.strict().safeParse({ ...rawAnalysis(), extra: 1 }).success, false);
  const badKind = { ...rawAnalysis(), images: [{ ...rawAnalysis().images[0], kind: 'swatch' }] };
  assert.equal(rawAnalysisSchema.safeParse(badKind).success, false);
});

test('the images are put in order, and the views are every view the sketches and photos show, once', () => {
  const analysis = checkAnalysis(
    rawAnalysis({
      images: [
        { image: 3, kind: 'material', views: ['front'], description: ' oak veneer ' },
        { image: 2, kind: 'photo', views: ['side', 'front'], description: 'a prototype' },
        { image: 1, kind: 'sketch', views: ['front', 'back', 'front'], description: 'a sheet' },
        { image: 4, kind: 'ignored', views: ['back'], description: 'a mood board' },
      ],
    }),
  );
  assert.deepEqual(
    analysis.images!.map((i) => [i.image, i.kind, i.views, i.description]),
    [
      [1, 'sketch', ['front', 'back'], 'a sheet'],
      [2, 'photo', ['side', 'front'], 'a prototype'],
      [3, 'material', [], 'oak veneer'],
      [4, 'ignored', [], 'a mood board'],
    ],
  );
  assert.deepEqual(analysis.views, ['front', 'back', 'side']);
});

test('the image list must read each image sent exactly once', () => {
  const at = (...numbers: number[]) =>
    imagesIssue({ images: numbers.map((image) => ({ ...rawAnalysis().images[0], image })) }, 2);
  assert.equal(at(2, 1), undefined);
  assert.match(at(1)!, /not each of 1 to 2 once/);
  assert.match(at(1, 1)!, /not each of 1 to 2 once/);
  assert.match(at(1, 2, 3)!, /not each of 1 to 2 once/);
});

test('an analysis with no sketch or photo of the product cannot be designed from', () => {
  const read = (...kinds: ('sketch' | 'photo' | 'material' | 'ignored')[]) =>
    noDesignReference(
      checkAnalysis(
        rawAnalysis({
          images: kinds.map((kind, i) => ({ image: i + 1, kind, views: [], description: '' })),
        }),
      ),
    );
  assert.equal(read('photo', 'material'), undefined);
  assert.equal(
    read('material', 'ignored'),
    'No image is a sketch or a photo of the product (the analyser read image 1 as a material sample, image 2 as unrelated). Add a sketch or a photo of the product.',
  );
  // A run analysed before images were classified has no list to judge.
  assert.equal(noDesignReference({}), undefined);
});

test('a metadata value is kept as the analyser gave it, even paraphrased', () => {
  // The metadata says "IVORY"; the analyser may rephrase, and the value is not compared with it.
  const raw = rawAnalysis({
    product: { ...rawAnalysis().product, colour: { value: 'off-white', source: 'metadata' } },
  });
  assert.deepEqual(checkAnalysis(raw).product.colour, { value: 'off-white', source: 'metadata' });
});

test('dimensions read from the images become none', () => {
  const raw = rawAnalysis({
    product: { ...rawAnalysis().product, dimensions: { value: 'about 80 cm', source: 'image' } },
  });
  assert.deepEqual(checkAnalysis(raw).product.dimensions, none);
});

test('metadata dimensions are kept', () => {
  const dimensions = { value: 'W 78 x D 82 x H 74 cm', source: 'metadata' } as const;
  const analysis = checkAnalysis(
    rawAnalysis({ product: { ...rawAnalysis().product, dimensions } }),
  );
  assert.deepEqual(analysis.product.dimensions, dimensions);
});

test('free text is trimmed, never cut', () => {
  const long = `small embroidered ${'x'.repeat(200)}`;
  const raw = rawAnalysis({
    product: { ...rawAnalysis().product, type: { value: `  ${long}\n`, source: 'image' } },
    observedColours: [' navy ', '  '],
    parts: [
      { name: ' seat ', description: ' padded\n', location: ' middle ' },
      { name: ' ', description: 'nothing', location: '' },
    ],
    ignored: [' a signature ', ''],
    details: [
      { description: ` ${long} `, location: 'left chest\n', view: 'front' },
      { description: ' ', location: 'back', view: 'back' },
    ],
    assumptions: [`  ${long}  `],
  });
  const analysis = checkAnalysis(raw);
  assert.equal(analysis.product.type.value, long);
  assert.deepEqual(analysis.parts, [{ name: 'seat', description: 'padded', location: 'middle' }]);
  assert.deepEqual(analysis.ignored, ['a signature']);
  assert.deepEqual(analysis.details, [
    { description: long, location: 'left chest', view: 'front' },
  ]);
  assert.deepEqual(analysis.observedColours, ['navy']);
  assert.deepEqual(analysis.assumptions, [long]);
});

test('a blank value becomes none, whatever its source', () => {
  const raw = rawAnalysis({
    product: { ...rawAnalysis().product, type: { value: '  ', source: 'metadata' } },
  });
  assert.deepEqual(checkAnalysis(raw).product.type, none);
});
