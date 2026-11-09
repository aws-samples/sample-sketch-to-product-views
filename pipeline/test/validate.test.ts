import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import sharp from 'sharp';
// The real sniffer, bound before the store is mocked: the stage's magic-byte gate is part of
// what is under test, only the S3 calls are faked.
import { isOwnedKey, sniffImageType } from '@sketch-to-product-views/shared/store';
import type { PipelineInput } from '../src/input.js';

/** Stands in for the bucket: key -> bytes. `sizeOverride` fakes a HEAD size without the bytes. */
const objects = new Map<string, { bytes: Uint8Array; sizeOverride?: number }>();
const gets: string[] = [];

mock.module('@sketch-to-product-views/shared/store', {
  namedExports: {
    sniffImageType,
    isOwnedKey,
    headArtifact: async (key: string) => {
      const found = objects.get(key);
      if (!found) return undefined;
      return {
        contentType: 'application/octet-stream',
        sizeBytes: found.sizeOverride ?? found.bytes.byteLength,
      };
    },
    getArtifact: async (key: string) => {
      gets.push(key);
      const found = objects.get(key);
      if (!found) throw Object.assign(new Error('missing'), { name: 'NoSuchKey' });
      return found.bytes;
    },
  },
});

const { validate, ValidationError } = await import('../src/stages/validate.js');

const png = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: '#888' } })
    .png()
    .toBuffer();

function reset(): void {
  objects.clear();
  gets.length = 0;
}

function packageOf(...files: { key: string; filename: string }[]): PipelineInput {
  return {
    revisionId: 'r-1',
    productId: 'P-1',
    modelId: 'gpt-image-flare',
    submittedBy: 'u-1',
    createdAt: '2026-09-28T10:00:00.000Z',
    inputs: files.map((file) => ({
      ...file,
      role: 'image' as const,
      url: `https://example.invalid/${file.key}`,
    })),
  };
}

test('a valid package passes, and the checks carry size and dimensions', async () => {
  reset();
  const bytes = await png(512, 768);
  objects.set('user/u-1/k/front.png', { bytes });

  const result = await validate(packageOf({ key: 'user/u-1/k/front.png', filename: 'front.png' }));

  assert.deepEqual(result.checks, [
    {
      filename: 'front.png',
      detectedType: 'image/png',
      readable: true,
      sizeBytes: bytes.byteLength,
      width: 512,
      height: 768,
    },
  ]);
});

test('an object over 3.75 MB is rejected from its HEAD size, without being downloaded', async () => {
  reset();
  objects.set('user/u-1/k/big.png', { bytes: await png(64, 64), sizeOverride: 4_200_000 });

  await assert.rejects(
    () => validate(packageOf({ key: 'user/u-1/k/big.png', filename: 'big.png' })),
    (error: Error) =>
      error instanceof ValidationError &&
      /big\.png: too large: 4\.20 MB, the limit is 3\.75 MB/.test(error.message),
  );
  assert.deepEqual(gets, []);
});

test('an image over 8000 px is rejected, naming the file and the limit', async () => {
  reset();
  objects.set('user/u-1/k/wide.png', { bytes: await png(8001, 10) });

  await assert.rejects(
    () => validate(packageOf({ key: 'user/u-1/k/wide.png', filename: 'wide.png' })),
    /wide\.png: 8001 px wide, the limit is 8000 px per side/,
  );
});

test('a gif is rejected', async () => {
  reset();
  const gif = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#888' } })
    .gif()
    .toBuffer();
  objects.set('user/u-1/k/anim.gif', { bytes: gif });

  await assert.rejects(
    () => validate(packageOf({ key: 'user/u-1/k/anim.gif', filename: 'anim.gif' })),
    /anim\.gif is not a readable JPEG, PNG or WebP/,
  );
});

test('a missing object is rejected as unreadable', async () => {
  reset();
  await assert.rejects(
    () => validate(packageOf({ key: 'user/u-1/k/gone.png', filename: 'gone.png' })),
    /gone\.png could not be read from storage/,
  );
});

test('every failing file is named in one error', async () => {
  reset();
  objects.set('user/u-1/k/ok.png', { bytes: await png(64, 64) });
  objects.set('user/u-1/k/wide.png', { bytes: await png(8001, 10) });

  await assert.rejects(
    () =>
      validate(
        packageOf(
          { key: 'user/u-1/k/gone.png', filename: 'gone.png' },
          { key: 'user/u-1/k/ok.png', filename: 'ok.png' },
          { key: 'user/u-1/k/wide.png', filename: 'wide.png' },
        ),
      ),
    (error: Error) =>
      /gone\.png/.test(error.message) &&
      /wide\.png/.test(error.message) &&
      !/ok\.png/.test(error.message),
  );
});
