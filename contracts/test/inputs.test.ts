import assert from 'node:assert/strict';
import test from 'node:test';
import { submitRequestSchema, validatePackage, type InputRole } from '../src/index.js';

const pkg = (...roles: InputRole[]) => roles.map((role) => ({ role }));

test('one to five images are a valid package, whatever role an older client sent', () => {
  for (const count of [1, 2, 3, 4, 5]) {
    const images = Array.from({ length: count }, () => 'image' as const);
    assert.deepEqual(validatePackage(pkg(...images)), { errors: [], warnings: [] });
  }
  assert.deepEqual(validatePackage(pkg('swatch')).errors, []);
  assert.deepEqual(validatePackage(pkg('image', 'swatch', 'swatch')).errors, []);
  assert.deepEqual(validatePackage([{}]).errors, []);
});

test('an empty package is rejected', () => {
  assert.deepEqual(validatePackage(pkg()).errors, ['At least one image is required.']);
});

test('six images are rejected', () => {
  const errors = validatePackage(pkg('image', 'image', 'image', 'image', 'image', 'image')).errors;
  assert.deepEqual(errors, ['At most 5 images are allowed.']);
});

test('an image needs no role on the wire', () => {
  const parsed = submitRequestSchema.safeParse({
    productId: 'MODEL-9',
    inputs: [{ filename: 'a.jpg', url: 'https://x/a.jpg' }],
  });
  assert.equal(parsed.success, true);
});

test('the removed view roles are rejected as unknown roles', () => {
  for (const role of ['front_sketch', 'back_sketch', 'side_sketch', 'detail_sketch']) {
    const parsed = submitRequestSchema.safeParse({
      productId: 'MODEL-9',
      inputs: [{ role, filename: 'a.jpg', url: 'https://x/a.jpg' }],
    });
    assert.equal(parsed.success, false, role);
  }
});

test('the schema rejects a sixth file', () => {
  const input = { role: 'image', filename: 'a.jpg', url: 'https://x/a.jpg' };
  const parsed = submitRequestSchema.safeParse({
    productId: 'MODEL-9',
    inputs: Array.from({ length: 6 }, () => input),
  });
  assert.equal(parsed.success, false);
});
