import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import sharp from 'sharp';
import type { Candidate, Evaluation, PipelineInput, ProductSpec } from '@sketch-to-product-views/contracts';
import type { GenerationRequest, ImageGenerator } from '@sketch-to-product-views/shared/generate';
import { sniffImageType } from '@sketch-to-product-views/shared/store';
import { fakeStore } from './fakes.js';

const store = fakeStore(sniffImageType);
let keys = 0;
mock.module('@sketch-to-product-views/shared/store', {
  namedExports: {
    ...store.exports,
    candidateKey: (_p: string, _r: string, id: string) => `candidates/${id}-${(keys += 1)}.png`,
  },
});

const { generateView } = await import('../src/stages/generate-2d.js');
const { attemptVerdict } = await import('../src/handler.js');

/** A small image, distinct per call so the test can tell which bytes travelled where. */
async function png(shade: number): Promise<Uint8Array> {
  return new Uint8Array(
    await sharp({
      create: { width: 8, height: 12, channels: 3, background: { r: shade, g: shade, b: shade } },
    })
      .png()
      .toBuffer(),
  );
}

function fakeGenerator(image: Uint8Array) {
  const requests: GenerationRequest[] = [];
  const generator: ImageGenerator = {
    async generate(request) {
      requests.push(request);
      return {
        image,
        contentType: 'image/png',
        model: { id: 'gpt-image-flare', bedrockModelId: 'gpt-image-2.5-flare', region: 'x' },
        durationMs: 90_000,
      };
    },
  };
  return { generator, requests };
}

const input = (modelId: string): PipelineInput => ({
  revisionId: 'r-1',
  productId: 'MODEL-1',
  modelId,
  createdAt: '2026-09-29T10:00:00.000Z',
  inputs: [{ role: 'image', filename: 's.png', url: 'https://x/s.png', key: 'k/sketch.png' }],
});

const spec: ProductSpec = {
  model: 'MODEL-1',
  productType: { value: 'flames cap', provenance: 'supplied' },
  views: ['front'],
};

/** The registry defaults for every GPT image entry, as the handler resolves them. */
const settings = { size: '2336x3504', quality: 'max' };

const front = (key: string): Candidate => ({
  id: 'front-1',
  url: '',
  key,
  modelId: 'gpt-image-flare',
  attempt: 1,
  createdAt: '',
  view: 'front',
});

test('the front is one call from the sketch, at the shared size and quality', async () => {
  const sketch = await png(40);
  store.objects.set('k/sketch.png', sketch);
  const { generator, requests } = fakeGenerator(await png(200));

  const candidate = await generateView(
    input('gpt-image-flare'),
    spec,
    1,
    'front',
    generator,
    'seg',
    {
      settings,
    },
  );

  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].sketch, sketch);
  assert.equal(requests[0].references, undefined);
  assert.deepEqual(requests[0].params, settings);
  assert.match(requests[0].prompt, /the front view, seen straight on/);
  assert.match(
    requests[0].prompt,
    /The flames cap is shown alone, standing or resting as it does in use/,
  );
  assert.equal(candidate.view, 'front');
  assert.equal(candidate.attempt, 1);
  assert.deepEqual(candidate.referenceKeys, ['k/sketch.png']);
  assert.equal(candidate.prompt, requests[0].prompt);
  assert.ok(candidate.key && store.objects.has(candidate.key), 'the view is in S3');
  assert.equal(candidate.latencyMs, 90_000);
  assert.equal(candidate.estimatedCostUsd, undefined, 'no per-image price is published at max');
});

test('a material sample is sent after the sketch, and the prompt makes it decide colour and pattern', async () => {
  const sketch = await png(40);
  const swatch = new Uint8Array(
    await sharp(await png(90))
      .jpeg()
      .toBuffer(),
  );
  store.objects.set('k/sketch.png', sketch);
  store.objects.set('k/swatch.jpg', swatch);
  const { generator, requests } = fakeGenerator(await png(200));
  const withSwatch = input('gpt-image-flare');
  withSwatch.inputs.push({
    role: 'swatch',
    filename: 'w.jpg',
    url: 'https://x/w.jpg',
    key: 'k/swatch.jpg',
  });

  const candidate = await generateView(withSwatch, spec, 1, 'front', generator, 'seg', {
    settings,
  });

  assert.deepEqual(requests[0].sketch, sketch);
  assert.deepEqual(requests[0].references, [swatch]);
  assert.match(requests[0].prompt, /The second is a sample of its material/);
  assert.deepEqual(candidate.referenceKeys, ['k/sketch.png', 'k/swatch.jpg']);
});

test('the analyser decides the images: design references in upload order, the first material as the sample, the rest as references', async () => {
  const [material, photo, sketch, extra, unrelated] = await Promise.all(
    [10, 20, 30, 40, 50].map(png),
  );
  const files = { material, photo, sketch, extra, unrelated };
  for (const [name, bytes] of Object.entries(files)) store.objects.set(`k/${name}.png`, bytes);
  const { generator, requests } = fakeGenerator(await png(200));
  const untagged = {
    ...input('gpt-image-flare'),
    inputs: Object.keys(files).map((name) => ({
      filename: `${name}.png`,
      url: '',
      key: `k/${name}.png`,
    })),
  };
  const read: ProductSpec = {
    ...spec,
    imageKinds: ['material', 'photo', 'sketch', 'material', 'ignored'],
  };

  const candidate = await generateView(untagged, read, 1, 'front', generator, 'seg', { settings });

  assert.deepEqual(candidate.referenceKeys, [
    'k/photo.png',
    'k/sketch.png',
    'k/extra.png',
    'k/material.png',
  ]);
  assert.deepEqual(requests[0].sketch, photo);
  assert.match(
    requests[0].prompt,
    /^The first three attached images show one flames cap\. The first is a photo of it \(the product itself, a prototype or a reference for it\)\. The second is the designer's sketch of it\. The third is a sample of another material of the flames cap, not a view of it\. The fourth is a sample of its material\. Turn the sketch and the photo into/,
  );
});

test('a view the sketch does not draw is made from the front render alone', async () => {
  const render = await png(120);
  store.objects.set('k/sketch.png', await png(40));
  store.objects.set('k/front.png', render);
  const { generator, requests } = fakeGenerator(await png(200));

  const back = await generateView(input('gpt-image-flare'), spec, 2, 'back', generator, 'seg', {
    settings,
    front: front('k/front.png'),
  });

  assert.deepEqual(requests[0].sketch, render, 'the render fills the dispatcher sketch slot');
  assert.equal(requests[0].references, undefined);
  assert.deepEqual(requests[0].params, settings, 'every view shares the attempt settings');
  assert.match(
    requests[0].prompt,
    /^The attached image is a product photograph of the finished flames cap seen from the front/,
  );
  assert.match(requests[0].prompt, /the back view, seen from directly behind/);
  assert.equal(back.view, 'back');
  assert.equal(back.attempt, 2);
  assert.deepEqual(back.referenceKeys, ['k/front.png']);
});

test('a profile the sketch draws gets the sketch, the material sample, the front and the back, in that order', async () => {
  const sketch = await png(40);
  const swatch = await png(90);
  const render = await png(120);
  store.objects.set('k/sketch.png', sketch);
  store.objects.set('k/swatch.png', swatch);
  store.objects.set('k/front.png', render);
  const backRender = await png(160);
  store.objects.set('k/back.png', backRender);
  const { generator, requests } = fakeGenerator(await png(200));
  const withSwatch = input('gpt-image-flare');
  withSwatch.inputs.push({
    role: 'swatch',
    filename: 'w.png',
    url: 'https://x/w.png',
    key: 'k/swatch.png',
  });

  const left = await generateView(
    withSwatch,
    { ...spec, views: ['front', 'side'] },
    1,
    'left',
    generator,
    'seg',
    {
      settings,
      front: front('k/front.png'),
      back: { ...front('k/back.png'), id: 'back-1', view: 'back' },
    },
  );

  assert.deepEqual(requests[0].sketch, sketch);
  assert.deepEqual(requests[0].references, [swatch, render, backRender]);
  assert.match(requests[0].prompt, /The third is a photograph of the finished product/);
  assert.match(
    requests[0].prompt,
    /The fourth is a photograph of the same finished product seen from directly behind/,
  );
  assert.match(requests[0].prompt, /the left side view, in full left profile/);
  assert.deepEqual(left.referenceKeys, [
    'k/sketch.png',
    'k/swatch.png',
    'k/front.png',
    'k/back.png',
  ]);
});

test('every uploaded image is sent as the sketch, in upload order, and numbered before the rest', async () => {
  const frontSketch = await png(30);
  const backSketch = await png(50);
  const swatch = await png(90);
  const render = await png(120);
  store.objects.set('k/front-sketch.png', frontSketch);
  store.objects.set('k/back-sketch.png', backSketch);
  store.objects.set('k/swatch.png', swatch);
  store.objects.set('k/front.png', render);
  const { generator, requests } = fakeGenerator(await png(200));
  const twoFiles: PipelineInput = {
    ...input('gpt-image-flare'),
    inputs: [
      { role: 'image', filename: 'f.png', url: 'https://x/f.png', key: 'k/front-sketch.png' },
      { role: 'image', filename: 'b.png', url: 'https://x/b.png', key: 'k/back-sketch.png' },
      { role: 'swatch', filename: 'w.png', url: 'https://x/w.png', key: 'k/swatch.png' },
    ],
  };

  const back = await generateView(
    twoFiles,
    { ...spec, views: ['front', 'back'] },
    1,
    'back',
    generator,
    'seg',
    { settings, front: front('k/front.png') },
  );

  assert.deepEqual(requests[0].sketch, frontSketch);
  assert.deepEqual(requests[0].references, [backSketch, swatch, render]);
  assert.match(
    requests[0].prompt,
    /^The first two attached images are the designer's images of one flames cap, each showing the same object; together they are the sketch\. The third is a sample of its material\. The fourth is a photograph of the finished product/,
  );
  assert.deepEqual(back.referenceKeys, [
    'k/front-sketch.png',
    'k/back-sketch.png',
    'k/swatch.png',
    'k/front.png',
  ]);
});

test('a view other than the front refuses to run without the front render', async () => {
  store.objects.set('k/sketch.png', await png(40));
  const { generator, requests } = fakeGenerator(await png(200));
  await assert.rejects(
    () => generateView(input('gpt-image-flare'), spec, 1, 'right', generator, 'seg', { settings }),
    /the right view needs the front render/,
  );
  assert.equal(requests.length, 0, 'nothing was paid for');
});

const verdict = (v: Evaluation['verdict']): Evaluation => ({
  verdict: v,
  scores: { sketchFidelity: 1, specAdherence: 1, imageQuality: 1 },
  issues: [],
  reviewer: 'test',
});

test('a failed view fails its attempt, a warned one only warns it', () => {
  assert.equal(
    attemptVerdict([verdict('pass'), verdict('fail'), verdict('pass'), verdict('pass')]),
    'fail',
  );
  assert.equal(
    attemptVerdict([verdict('pass'), verdict('warn'), verdict('pass'), verdict('pass')]),
    'warn',
  );
  assert.equal(
    attemptVerdict([verdict('pass'), verdict('pass'), verdict('pass'), verdict('pass')]),
    'pass',
  );
});
