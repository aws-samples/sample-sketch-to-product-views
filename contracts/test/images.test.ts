import assert from 'node:assert/strict';
import test from 'node:test';
import { planImages, type InputRole } from '../src/index.js';

const files = (...roles: (InputRole | undefined)[]) =>
  roles.map((role, i) => ({ filename: `${i + 1}.jpg`, ...(role ? { role } : {}) }));
const names = (list: { filename: string }[]) => list.map((f) => f.filename);

test('sketches and photos are the design references in upload order; the first material is the sample', () => {
  const plan = planImages(files(undefined, undefined, undefined, undefined, undefined), [
    'material',
    'photo',
    'sketch',
    'material',
    'ignored',
  ]);
  assert.deepEqual(names(plan.design), ['2.jpg', '3.jpg']);
  assert.deepEqual(plan.designKinds, ['photo', 'sketch']);
  assert.equal(plan.material?.filename, '1.jpg');
  assert.deepEqual(names(plan.extraMaterials), ['4.jpg']);
  assert.deepEqual(plan.criticReference, { file: { filename: '3.jpg' }, kind: 'sketch' });
});

test('without a sketch the critic compares with the first photo', () => {
  const plan = planImages(files(undefined, undefined), ['material', 'photo']);
  assert.deepEqual(plan.criticReference, { file: { filename: '2.jpg' }, kind: 'photo' });
});

test('the analyser decides, whatever role an older client sent', () => {
  const plan = planImages(files('swatch', 'image'), ['sketch', 'material']);
  assert.deepEqual(names(plan.design), ['1.jpg']);
  assert.equal(plan.material?.filename, '2.jpg');
});

test('a run analysed before images were classified falls back to its roles', () => {
  const plan = planImages(files('image', 'image', 'swatch'));
  assert.deepEqual(names(plan.design), ['1.jpg', '2.jpg']);
  assert.deepEqual(plan.designKinds, ['sketch', 'sketch']);
  assert.equal(plan.material?.filename, '3.jpg');
  assert.deepEqual(plan.extraMaterials, []);
  assert.equal(plan.criticReference?.kind, 'sketch');
});

test('no sketch or photo leaves the critic nothing to compare with', () => {
  assert.equal(planImages(files(undefined), ['material']).criticReference, undefined);
});
